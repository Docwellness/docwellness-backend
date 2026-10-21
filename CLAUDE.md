# docwellness-backend

Node (>=22) + Express 5 + MongoDB/Mongoose 9 API for the Docwellness patient and dietician apps and the admin panel.

## Layout
- `app.js` is the server entry; `api/index.js` is the Vercel entry.
- `routes/` (patient, dietician, admin, internal, chat, v1), `controllers/`, `middlewares/`, `models/`, `services/`, `utils/`, `socket/`, `chat/`.
- `scripts/` holds one-off data scripts (seeding, backfills, audits). Some of them write data. Read a script before running it.
- `tests/` holds Jest tests, `e2e/` a Python UI driver. Specs and change plans live in the sibling repo `docwellness-specs` (OpenSpec), not here.

## Commands
- Test: `npm test` (Jest, `--runInBand --forceExit`). Lint: `npm run lint` (currently broken, see Verification). Format: `npm run format`.
- Run locally: `npm run dev`.

## Verification (run before reporting any task done, and paste the output)
Run these from the repo root. Paste the raw result lines.
- `npm test` - healthy: Jest ends with `Tests: N passed, N total` and no `failed`.
- `npm run lint` - **cannot run today** (checked 2026-10-20): the script calls `eslint`, which is not in `package.json`, not
  installed, and has no config, so it fails with "'eslint' is not recognized". Report it as "lint unavailable (known)", neither as
  passing nor as a failure of your change. Adding ESLint is a separate decision for the developer; do not add it as part of another task.
There is no separate build step for the API. If another command cannot run, say which and why instead of reporting done.

## Production data safety
- The `MONGODB_URI` in `.env` is a MongoDB Atlas cluster and is **NOT production**. The real production database runs on Coolify, and its connection details are not in this repo.
- Never run a script against what you believe is production without the developer's explicit approval in the session, and never print or commit `.env` values.
- Patient data deletion goes through the shared cascade module `utils/patientDataDeletion.js`. The old reset scripts at the repo root (`reset*.js`, `clean-all.js`) are known to be buggy; do not use them.

## CI
- `.github/workflows/` only deploys the dev backend to Vercel. There is no test workflow, so passing local `npm test` and `npm run lint` is the real gate.
