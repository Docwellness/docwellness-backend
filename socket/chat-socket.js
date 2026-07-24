// Canonical v1 chat socket handler entrypoint (see AI_EXECUTION_PLAN.md
// Phase 4, P4-06). The actual implementation stays in chat/socket/index.js
// (already correct there - it's part of the v1 chat module alongside
// chat/controllers, chat/services, chat/models) rather than being
// physically moved here; this is a thin, deliberately-minimal re-export so
// the file exists at the path the plan specifies, without the risk of
// reproducing ~600 lines by hand.
//
// NOTE: this directory (socket/) also contains index.js, an OLDER,
// unrelated, and unreferenced module (not required anywhere - confirmed
// via repo-wide search) that predates the Supabase-based auth migration
// (it verifies a raw JWT_SECRET-signed token, not a Supabase token) and
// still has the exact client-controlled room-joining anti-pattern this
// phase's P4-01 explicitly warns against (`socket.join(data.userId)` /
// `socket.join(conversationId)` on arbitrary client-supplied values). It
// is dead code, not wired into app.js or anything else - left in place
// rather than deleted (see the Phase 4 completion report), but do not
// confuse it with this file.
module.exports = require('../chat/socket');
