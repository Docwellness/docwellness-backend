/**
 * AI_EXECUTION_PLAN.md Phase 8, P8-01 - chat message send and chat unread
 * count (the /api/v1/chat/unread-count endpoint added in Phase 5).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDefaultDietician;
let Chat;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDefaultDietician } = require('./helpers/factories'));
  ({ Chat } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('POST /api/patient/chat/message', () => {
  // Patient sends always auto-route to config.defaultDieticianId - see
  // tests/helpers/testDb.js/factories.js for why the dietician here must
  // be created via createDefaultDietician(), not createDietician().
  test('patient sends a message, auto-routed to the configured dietician, and it persists', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/chat/message')
      .set('Authorization', 'Bearer patient-token')
      .send({ message: 'Hello dietician, test message' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const stored = await Chat.find({ senderId: patient._id });
    expect(stored.length).toBe(1);
    expect(stored[0].receiverId.toString()).toBe(dietician._id.toString());
    expect(stored[0].message).toBe('Hello dietician, test message');
  });

  test('rejects an empty message with no attachment', async () => {
    await createDefaultDietician();
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/chat/message')
      .set('Authorization', 'Bearer patient-token')
      .send({ message: '' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/chat/unread-count', () => {
  test('counts unread messages sent to the authenticated user', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);
    registerTestToken('dietician-token', dietician._id);

    // Two messages patient -> dietician, unread by the dietician.
    await request(app)
      .post('/api/patient/chat/message')
      .set('Authorization', 'Bearer patient-token')
      .send({ message: 'first' });
    await request(app)
      .post('/api/patient/chat/message')
      .set('Authorization', 'Bearer patient-token')
      .send({ message: 'second' });

    const dieticianUnread = await request(app)
      .get('/api/v1/chat/unread-count')
      .set('Authorization', 'Bearer dietician-token');
    expect(dieticianUnread.status).toBe(200);
    expect(dieticianUnread.body.data.unreadCount).toBe(2);

    // The sender's own unread count should not include their own sends.
    const patientUnread = await request(app)
      .get('/api/v1/chat/unread-count')
      .set('Authorization', 'Bearer patient-token');
    expect(patientUnread.status).toBe(200);
    expect(patientUnread.body.data.unreadCount).toBe(0);
  });

  test('returns zero for a user with no conversations', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/v1/chat/unread-count')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(0);
  });
});
