# Security Practices

This document covers secret handling and rotation across all three
DocWellness repositories (`docwellness-backend`, `docwellness-user`,
`docwellness-dietician`). It is documentation only - it does not change any
code or configuration by itself.

## Secrets this platform uses

| Secret | Where it lives | Scope |
|---|---|---|
| `JWT_SECRET` | backend `.env` | signs/verifies backend session tokens |
| `MONGODB_URI` | backend `.env` | full database access |
| `SUPABASE_SERVICE_ROLE_KEY` | backend `.env` | full Supabase DB access - server-side only |
| `SUPABASE_PUBLISHABLE_KEY` / anon key | Flutter apps (dart-define) | client-safe by design - only allows what RLS policies permit |
| `CLOUDINARY_API_SECRET` | backend `.env` | image upload signing |
| `RESEND_API_KEY` | backend `.env` | transactional email sending |
| `OPENAI_API_KEY` | backend `.env` | AI-assisted recipe/translation/diet-plan generation |
| `PEXELS_API_KEY` | backend `.env` | stock ingredient images |
| `CRON_SECRET` | backend `.env` | authenticates `/api/internal/*` cron-triggered routes |
| `SENTRY_DSN` | backend `.env`, Flutter apps (dart-define) | crash/error reporting - DSNs are designed to be public/client-embeddable |
| `POSTHOG_API_KEY` | Flutter apps (dart-define) | analytics - project API keys are designed to be public/client-embeddable |

Dart-define values (Sentry DSN, PostHog key, Supabase anon key) are
intentionally public/client-embeddable and end up baked into the compiled
app binary either way - they are safe to commit in a `scripts/run-dev.ps1`
style helper script. Real secrets (JWT signing keys, DB passwords, the
Supabase *service role* key, Cloudinary/Resend/OpenAI/Pexels
secrets) must never appear in a Flutter `--dart-define` or be committed
anywhere, in either repo.

Dev-only convenience credentials (e.g. a dev auto-login email/password, or
a dev-only AI API key used by an in-app "magic fill" testing tool) follow
the existing gitignored-file pattern already used in both Flutter apps:
a real, gitignored file (`lib/dev_credentials.dart`,
`lib/groq_dev_credentials.dart`) paired with a committed `.example.dart`
template. Follow this same pattern for any new dev-only credential rather
than hardcoding it inline.

## If a secret is exposed (committed, logged, or shared)

1. **Do not** paste the secret anywhere else (chat, tickets, code comments)
   while investigating - handling it should stop it from spreading further.
2. Rotate it immediately at the source:
   - **JWT_SECRET** - generate a new random value and update it in the
     backend's env config. This immediately invalidates every existing
     session/token; every logged-in user is signed out and must log in
     again. Coordinate before rotating in production.
   - **MongoDB URI / password** - dev still runs against MongoDB Atlas
     (rotate the database user's password in the Atlas dashboard). Prod
     runs against the dedicated self-hosted instance described in
     `docs/db-migration-oracle.md` - rotate by SSHing into that VM and
     changing the app user's password via `mongosh`
     (`db.updateUser("appuser", { pwd: passwordPrompt() })` against the
     `docwellness` database). Either way, update the corresponding
     `MONGODB_URI` (Vercel project env for dev, the Coolify resource's
     environment variables for prod) immediately after.
   - **Cloudinary** - regenerate the API secret in the Cloudinary console.
   - **Resend** - revoke and reissue the API key in the Resend dashboard.
   - **OpenAI** - revoke and reissue the API key in the OpenAI platform
     dashboard.
   - **Pexels** - regenerate the API key in the Pexels API dashboard.
   - **Supabase service role key** - regenerate it in the Supabase project
     settings (Project Settings -> API). This is the highest-privilege
     Supabase credential; treat exposure as urgent.
   - **CRON_SECRET** - generate a new random value; update both the env
     var and whatever cron trigger (Vercel Cron config, VPS crontab) sends
     it.
3. Update the value in every environment that uses it (local `.env`,
   hosting provider's environment variable settings, CI secrets).
4. If the secret was committed to Git (even once, even if later removed),
   treat the old value as permanently compromised - rotation (step 2) is
   mandatory, not optional, since the value remains in Git history
   regardless of later commits removing it.
5. Recommend Git history cleanup for the affected repo (e.g.
   `git filter-repo` or GitHub's secret-scanning/push-protection tooling)
   if the exposure was committed to a shared branch - this is a
   destructive, history-rewriting operation, so get explicit sign-off
   before running it and coordinate with anyone else who has the repo
   cloned (their local history will diverge).

## Preventing exposure

- Never hardcode a token, password, API key, or private ID directly in
  source. Use environment variables (backend) or the gitignored
  dev-credentials-file pattern above (Flutter, dev-only conveniences).
- Never print or log a secret's value, even for debugging - log that a
  variable is set/unset, not its contents.
- Never log tokens or PHI (personally identifiable health data - names,
  health metrics, consultation answers, etc.) in application logs. Backend
  request logging should redact `authorization`, `cookie`, `password`,
  `token`, and `otp` fields (see Phase 2 of `AI_EXECUTION_PLAN.md`).
- `.env`, `.env.*`, and dev-credentials files are already gitignored in
  every repo - keep it that way. Before committing, review `git status`
  for anything unexpected, especially after a broad `git add`.
- Mobile apps: store any locally-persisted session/auth data in secure
  storage (e.g. `flutter_secure_storage`), not `SharedPreferences`, for
  values more sensitive than a UI preference.
