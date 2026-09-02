/**
 * GET .../chat/conversations/:id/messages pagination - cross-app performance
 * optimization, Phase 2 (task 2.4, chat slice).
 *
 * The endpoint used to load a conversation's entire history on every open.
 * It now supports cursor (`?before=`) and offset (`?page=&limit=`) paging,
 * and still returns everything when no paging params are sent (back-compat).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDefaultDietician;
let Chat;
let Conversation;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDefaultDietician } = require('./helpers/factories'));
  ({ Chat, Conversation } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

/**
 * Seeds `count` legacy Chat messages 1 second apart (oldest first) in one
 * conversation between the patient and dietician, and returns the
 * conversation plus the messages ordered oldest -> newest.
 */
async function seedConversation(patient, dietician, count) {
  const conversation = await Conversation.create({
    participants: [{ userId: patient._id }, { userId: dietician._id }],
  });

  const base = Date.now() - count * 1000;
  const docs = Array.from({ length: count }, (_, i) => ({
    conversationId: conversation._id,
    senderId: i % 2 === 0 ? patient._id : dietician._id,
    receiverId: i % 2 === 0 ? dietician._id : patient._id,
    message: `msg-${i}`,
    messageType: 'text',
    isRead: false,
    createdAt: new Date(base + i * 1000),
    updatedAt: new Date(base + i * 1000),
  }));
  // Bypass Mongoose timestamps so the seeded createdAt spacing survives.
  const inserted = await Chat.insertMany(docs, { timestamps: false });
  return { conversation, messages: inserted };
}

const getMessages = (conversationId, token, query = '') =>
  request(app)
    .get(`/api/patient/chat/conversations/${conversationId}/messages${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('GET /api/patient/chat/conversations/:id/messages - pagination', () => {
  test('no paging params: returns the full history, newest first, with no pagination block', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation } = await seedConversation(patient, dietician, 5);
    registerTestToken('p', patient._id);

    const res = await getMessages(conversation._id, 'p');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    // newest first
    expect(res.body.data[0].message).toBe('msg-4');
    expect(res.body.data[4].message).toBe('msg-0');
    expect(res.body.pagination).toBeUndefined();
  });

  test('?limit=2 returns the newest 2 with hasMore=true and a nextBefore cursor', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation, messages } = await seedConversation(patient, dietician, 5);
    registerTestToken('p', patient._id);

    const res = await getMessages(conversation._id, 'p', '?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.message)).toEqual(['msg-4', 'msg-3']);
    expect(res.body.pagination.hasMore).toBe(true);
    expect(res.body.pagination.limit).toBe(2);
    expect(new Date(res.body.pagination.nextBefore).getTime()).toBe(
      new Date(messages[3].createdAt).getTime()
    );
  });

  test('?before=<cursor> returns the page of messages older than the cursor', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation, messages } = await seedConversation(patient, dietician, 5);
    registerTestToken('p', patient._id);

    // cursor = msg-3's timestamp -> expect msg-2, msg-1 (newest-first, older than msg-3)
    const before = new Date(messages[3].createdAt).toISOString();
    const res = await getMessages(conversation._id, 'p', `?before=${before}&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.message)).toEqual(['msg-2', 'msg-1']);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  test('cursor paging walks the whole history without gaps or repeats', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation } = await seedConversation(patient, dietician, 5);
    registerTestToken('p', patient._id);

    const collected = [];
    let before;
    for (let guard = 0; guard < 10; guard += 1) {
      const q = before ? `?before=${before}&limit=2` : '?limit=2';
      const res = await getMessages(conversation._id, 'p', q); // eslint-disable-line no-await-in-loop
      collected.push(...res.body.data.map((m) => m.message));
      if (!res.body.pagination.hasMore) break;
      before = res.body.pagination.nextBefore;
    }
    expect(collected).toEqual(['msg-4', 'msg-3', 'msg-2', 'msg-1', 'msg-0']);
  });

  test('?page=2&limit=2 returns the third and fourth newest (offset mode, back-compat)', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation } = await seedConversation(patient, dietician, 5);
    registerTestToken('p', patient._id);

    const res = await getMessages(conversation._id, 'p', '?page=2&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.message)).toEqual(['msg-2', 'msg-1']);
  });

  test('a limit larger than the history returns everything with hasMore=false', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const { conversation } = await seedConversation(patient, dietician, 3);
    registerTestToken('p', patient._id);

    const res = await getMessages(conversation._id, 'p', '?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  test('a non-participant is refused', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const outsider = await createPatient();
    const { conversation } = await seedConversation(patient, dietician, 2);
    registerTestToken('out', outsider._id);

    const res = await getMessages(conversation._id, 'out', '?limit=2');
    expect(res.status).toBe(403);
  });
});
