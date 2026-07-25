// AI_EXECUTION_PLAN.md Phase 8, P8-01 - scoped to tests/ only so this
// doesn't pick up chat/tests/chat.test.js (a pre-existing standalone
// Node script, not Jest-shaped - still run separately via `npm test`,
// untouched here).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testTimeout: 30000,
};
