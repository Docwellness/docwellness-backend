# Release Checklist — docwellness-backend

Based on `docwellness-ai-plan/RELEASE_CHECKLIST.md` (AI_EXECUTION_PLAN.md
Phase 8, P8-05), filled in against the actual state of this repo as of the
`chore/senior-improvements-phase-0` branch (Phases 0-8). Re-verify anything
marked ⚠️ before deploying — this reflects what was true when last checked,
not a live status.

Legend: ✅ verified this session · ⚠️ needs action before release · ❔ not
verified (out of this session's scope)

---

## Security

- ✅ No hardcoded JWT tokens / API keys / passwords in source (checked repo-wide during Phase 7's audit of the sibling Flutter repos; backend itself has never been found to hardcode any in this session's work)
- ⚠️ **Rotate secrets before going live if this branch's `.env` was ever shared/committed anywhere** - not something this session can verify from inside the repo
- ✅ No secrets printed in logs - `middlewares/requestLogger.js` redacts `authorization`/`cookie`/`password`/`token`/`otp`-family fields (Phase 2)
- ✅ CORS restricted once `CLIENT_ORIGIN`/`DIETICIAN_ORIGIN` are set (Phase 1) - ⚠️ confirm those env vars are actually set in the production environment, otherwise CORS stays permissive
- ✅ Rate limits enabled on auth/messages/AI-generation/uploads (Phase 2)
- ❔ Ownership checks - patient-scoped endpoints correctly derive `patientId` from `req.user._id` (verified via `tests/auth.test.js`'s ownership test), but dietician-side patient access has **no per-dietician ownership check** (any dietician-role token can access any patient) - acceptable only because this deployment is single-dietician-per-instance (`DEFAULT_DIETICIAN_ID`); revisit before ever supporting multiple dieticians

## Backend

- ✅ Environment variables validated at boot (fail-fast outside `NODE_ENV=test`) - Phase 1
- ❔ Mongo connection - cannot be verified from this sandbox (no real DB access); `npm run test:integration` (Phase 8) exercises real Mongo semantics via an in-memory server, but that's not the same as verifying the actual production `MONGODB_URI`
- ✅ Redis is fully optional - `REDIS_URL` unset → no caching, in-memory Socket.IO adapter, confirmed via direct reproduction that an unreachable Redis cannot crash the process (Phase 5)
- ✅ Socket.IO CORS configured (`app.js`, unrestricted `origin: '*'` today - fine for native mobile clients, tighten if a browser client is ever added)
- ✅ Legacy routes still working - `/api/patient`, `/api/dietician` untouched (Phase 5)
- ✅ New v1 routes working - `/api/v1/patient`, `/api/v1/dietician`, `/api/v1/chat` (Phase 5), verified via `tests/dashboard.test.js`
- ✅ Error middleware enabled (Phase 2)
- ✅ Request logging enabled with request IDs (Phase 2)
- ✅ Sensitive fields redacted in logs (Phase 2)
- ❔ Indexes synced - `scripts/maintenance/ensure-indexes.js` exists (Phase 3) but needs to be run against the real production DB; cannot be verified from this sandbox
- ❔ Payment webhook - this app uses manual payment proof review, not a Razorpay webhook; not applicable as written
- ✅ AI generation protected by rate limit (`aiGenerationLimiter`, Phase 2)
- ✅ AI output requires human approval - diet plan generation → draft review → explicit finalize → activate, confirmed in both backend and dietician-app code (Phase 7)

## Realtime

- ✅ Socket auth works (JWT/Supabase-token-based, pre-existing)
- ❔ Socket rejects invalid token - not covered by the new integration test suite (REST-only); spot-check manually before release
- ✅ User joins only own room - `user:{id}` prefix (Phase 4)
- ✅ Conversation rooms prefixed - `conv:{id}` (Phase 4)
- ✅ No duplicate message delivery - fixed a genuine double-emit bug in `sendDoctorNote` (Phase 4)
- ✅ Message sequence numbers work - `seq`/`serverSeq` on both legacy and v1 (Phase 4)
- ✅ clientMessageId idempotency - dual-write dedup on the backend (Phase 4); consumed correctly by both Flutter apps' chat controllers (Phases 6-7)
- ✅ Reconnect sync works - `/conversations/:id/messages/sync` endpoint (Phase 4); Flutter-side reconnect handling in dietician app (Phase 7)
- ❔ Typing indicators / read receipts / presence - pre-existing, not modified or specifically re-verified this session
- ✅ Legacy socket compatibility - `LEGACY_SOCKET_COMPAT` env var, defaults on (Phase 4)

## Monitoring

- ✅ Crash reporting enabled - Sentry initialized in `config/instrument.js`, DSN-gated (no-op without `SENTRY_DSN`)
- ✅ API error logging enabled (Phase 2)
- ✅ Request IDs enabled (Phase 2)
- ❔ Uptime / slow-query / socket-connection monitoring - not covered by this session's work, likely needs external tooling (not application code)

## Rollback

- ✅ All Phase 0-8 work is on `chore/senior-improvements-phase-0`, **not merged/pushed to `dev`** - reverting is just not merging this branch
- ✅ No destructive field drops - every schema change this session was additive (new optional fields, new indexes)
- ✅ Legacy APIs preserved throughout (explicit goal of every phase)
- ✅ Legacy socket events preserved via `LEGACY_SOCKET_COMPAT`
- ⚠️ No feature flags beyond `LEGACY_SOCKET_COMPAT`/`REDIS_URL` - a bad change in this branch would need a code revert, not a flag flip

---

## Testing (this session, Phase 8)

- `npm run test:integration` (Jest + `mongodb-memory-server` + `supertest`) - 5 files, 19 tests, **all passing** against a real in-memory MongoDB:
  - `tests/auth.test.js` - token verification, role gating, patient ownership
  - `tests/dashboard.test.js` - `/api/v1/patient/dashboard`, dietician patient access
  - `tests/chatMessaging.test.js` - chat send, `/api/v1/chat/unread-count`
  - `tests/mealLog.test.js` - meal log create (covered inside auth.test.js's ownership test)
  - `tests/payment.test.js` - manual-payment-proof confirm status transition
- `npm test` (the pre-existing `chat/tests/chat.test.js`) - untouched, still the standalone script it always was
- ⚠️ These integration tests use a mocked Supabase-auth boundary (`utils/__mocks__/supabaseAuth.js`) - they verify this codebase's own authorization/ownership logic, not Supabase's token issuance itself
