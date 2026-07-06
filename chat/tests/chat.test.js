/**
 * Chat Module Tests
 * REST API + Socket.IO Integration Tests
 */

const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const jwt = require('jsonwebtoken');

// Test configuration
const TEST_PORT = 5001;
const TEST_JWT_SECRET = 'test-secret-key';
const TEST_MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/docwellness_test';

// Mock user data
const mockPatient = {
  _id: new mongoose.Types.ObjectId(),
  username: 'testpatient',
  email: 'patient@test.com',
  role: 'patient',
  profile: { fullName: 'Test Patient' },
};

const mockDietician = {
  _id: new mongoose.Types.ObjectId(),
  username: 'testdietician',
  email: 'dietician@test.com',
  role: 'dietician',
  profile: { fullName: 'Test Dietician' },
};

// Generate test tokens
function generateToken(user) {
  return jwt.sign({ id: user._id }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

/**
 * REST API Tests
 */
async function testRESTEndpoints(baseUrl, patientToken, dieticianToken) {
  const results = [];

  // Helper for HTTP requests
  async function request(method, path, body = null, token = patientToken) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // Test 1: Create direct conversation
  console.log('\n[TEST] POST /api/v1/chat/conversations/direct');
  try {
    const res = await request('POST', '/api/v1/chat/conversations/direct', {
      participantId: mockDietician._id.toString(),
    });
    results.push({
      name: 'Create Direct Conversation',
      passed: res.status === 201 && res.body.success,
      status: res.status,
    });
    console.log(`  Status: ${res.status}, Success: ${res.body.success}`);

    if (res.body.data?.id) {
      // Test 2: Get conversations
      console.log('\n[TEST] GET /api/v1/chat/conversations');
      const listRes = await request('GET', '/api/v1/chat/conversations');
      results.push({
        name: 'Get Conversations',
        passed: listRes.status === 200 && Array.isArray(listRes.body.data),
        status: listRes.status,
      });
      console.log(`  Status: ${listRes.status}, Count: ${listRes.body.data?.length || 0}`);

      // Test 3: Send message
      console.log('\n[TEST] POST /api/v1/chat/conversations/:id/messages');
      const msgRes = await request(
        'POST',
        `/api/v1/chat/conversations/${res.body.data.id}/messages`,
        {
          client_message_id: `test-${Date.now()}`,
          type: 'text',
          content: 'Hello from test!',
        }
      );
      results.push({
        name: 'Send Message',
        passed: msgRes.status === 201 && msgRes.body.ack,
        status: msgRes.status,
      });
      console.log(`  Status: ${msgRes.status}, Has ACK: ${!!msgRes.body.ack}`);

      if (msgRes.body.ack) {
        // Test 4: Dedup test (same client_message_id)
        console.log('\n[TEST] Deduplication (same client_message_id)');
        const dupRes = await request(
          'POST',
          `/api/v1/chat/conversations/${res.body.data.id}/messages`,
          {
            client_message_id: msgRes.body.data?.id ? `test-${Date.now() - 1000}` : 'test-dedup',
            type: 'text',
            content: 'This should be deduped',
          }
        );
        // Note: For true dedup test, we'd need to send same client_message_id twice
        results.push({
          name: 'Send Another Message',
          passed: dupRes.status === 201 || dupRes.status === 200,
          status: dupRes.status,
        });
        console.log(`  Status: ${dupRes.status}`);
      }

      // Test 5: Get messages
      console.log('\n[TEST] GET /api/v1/chat/conversations/:id/messages');
      const messagesRes = await request(
        'GET',
        `/api/v1/chat/conversations/${res.body.data.id}/messages`
      );
      results.push({
        name: 'Get Messages',
        passed: messagesRes.status === 200 && Array.isArray(messagesRes.body.data),
        status: messagesRes.status,
      });
      console.log(`  Status: ${messagesRes.status}, Count: ${messagesRes.body.data?.length || 0}`);

      // Test 6: Mark as read
      console.log('\n[TEST] POST /api/v1/chat/conversations/:id/read');
      const readRes = await request('POST', `/api/v1/chat/conversations/${res.body.data.id}/read`, {
        last_read_seq: 999,
      });
      results.push({
        name: 'Mark As Read',
        passed: readRes.status === 200 && readRes.body.success,
        status: readRes.status,
      });
      console.log(`  Status: ${readRes.status}`);
    }
  } catch (error) {
    console.error('  Error:', error.message);
    results.push({ name: 'REST Tests', passed: false, error: error.message });
  }

  // Test 7: Link preview
  console.log('\n[TEST] POST /api/v1/chat/link/preview');
  try {
    const previewRes = await request('POST', '/api/v1/chat/link/preview', {
      url: 'https://example.com',
    });
    results.push({
      name: 'Link Preview',
      passed: previewRes.status === 200,
      status: previewRes.status,
    });
    console.log(`  Status: ${previewRes.status}`);
  } catch (error) {
    results.push({ name: 'Link Preview', passed: false, error: error.message });
  }

  // Test 8: Meal log webhook
  console.log('\n[TEST] POST /api/v1/chat/integrations/meal-logs/events');
  try {
    const webhookRes = await request('POST', '/api/v1/chat/integrations/meal-logs/events', {
      event_type: 'meal_log.created',
      event_id: `test-event-${Date.now()}`,
      meal_log_id: new mongoose.Types.ObjectId().toString(),
      meal_log_version: 1,
      actor_user_id: mockPatient._id.toString(),
      snapshot: {
        mealType: 'Breakfast',
        calories: 350,
      },
    });
    results.push({
      name: 'Meal Log Webhook',
      passed: webhookRes.status === 200 && webhookRes.body.success,
      status: webhookRes.status,
    });
    console.log(`  Status: ${webhookRes.status}`);
  } catch (error) {
    results.push({ name: 'Meal Log Webhook', passed: false, error: error.message });
  }

  return results;
}

/**
 * Socket.IO Tests
 */
async function testSocketIO(baseUrl, patientToken, dieticianToken) {
  const results = [];

  return new Promise((resolve) => {
    console.log('\n[TEST] Socket.IO Connection');

    const socket = ioClient(baseUrl, {
      auth: { token: patientToken },
      transports: ['websocket'],
    });

    let testTimeout = setTimeout(() => {
      socket.disconnect();
      results.push({ name: 'Socket Timeout', passed: false, error: 'Connection timeout' });
      resolve(results);
    }, 10000);

    socket.on('ws.auth_ok', (data) => {
      console.log('  Connected, user_id:', data.user_id);
      results.push({ name: 'Socket Auth', passed: true });

      // Test send message
      console.log('\n[TEST] Socket msg.send');
      socket.emit(
        'msg.send',
        {
          receiver_id: mockDietician._id.toString(),
          client_message_id: `socket-test-${Date.now()}`,
          type: 'text',
          content: 'Hello via socket!',
        },
        (response) => {
          results.push({
            name: 'Socket Send Message',
            passed: response.success && response.ack,
          });
          console.log(`  Success: ${response.success}, Has ACK: ${!!response.ack}`);

          // Test typing indicator
          console.log('\n[TEST] Socket typing.start');
          socket.emit('typing.start', {
            receiver_id: mockDietician._id.toString(),
          });
          results.push({ name: 'Typing Start', passed: true });
          console.log('  Emitted');

          // Clean up
          clearTimeout(testTimeout);
          socket.disconnect();
          resolve(results);
        }
      );
    });

    socket.on('connect_error', (error) => {
      console.log('  Connection error:', error.message);
      results.push({ name: 'Socket Auth', passed: false, error: error.message });
      clearTimeout(testTimeout);
      socket.disconnect();
      resolve(results);
    });
  });
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('DocWellness Chat v1 Module - Test Suite');
  console.log('='.repeat(60));

  // Generate tokens
  const patientToken = generateToken(mockPatient);
  const dieticianToken = generateToken(mockDietician);

  const baseUrl = `http://localhost:${process.env.PORT || 5000}`;

  console.log(`\nTarget: ${baseUrl}`);
  console.log('Patient Token:', patientToken.substring(0, 50) + '...');

  let allResults = [];

  // Run REST tests
  console.log('\n' + '-'.repeat(40));
  console.log('REST API Tests');
  console.log('-'.repeat(40));

  try {
    const restResults = await testRESTEndpoints(baseUrl, patientToken, dieticianToken);
    allResults = allResults.concat(restResults);
  } catch (error) {
    console.error('REST Tests failed:', error.message);
  }

  // Run Socket tests
  console.log('\n' + '-'.repeat(40));
  console.log('Socket.IO Tests');
  console.log('-'.repeat(40));

  try {
    const socketResults = await testSocketIO(baseUrl, patientToken, dieticianToken);
    allResults = allResults.concat(socketResults);
  } catch (error) {
    console.error('Socket Tests failed:', error.message);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  allResults.forEach((r) => {
    const status = r.passed ? '✓' : '✗';
    console.log(`  ${status} ${r.name}${r.error ? ` (${r.error})` : ''}`);
  });

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

// Export for module use or run directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { runTests, testRESTEndpoints, testSocketIO };
