# Laya integration — operations runbook

How to run, check, change and roll back the self-hosted Laya service. Read
`docs/laya-architecture.md` for the design and `docs/laya-deployment.md` for the original
deployment plan; this is the day-to-day companion.

_Last verified against production: 2026-10-05._

## Current state

| | |
|---|---|
| Mode | **Shadow only**, one surface: `recipe_classification`. Laya never affects a response. |
| `diet_plan_review` surface | Wired, **not enabled** (see "Before enabling another surface"). |
| `LAYA_MODE=live` | **Not allowed** until the evaluation gate in `docs/laya-evaluation.md` is met. |
| Evaluation dataset | Does not exist yet (human deliverable, `tests/laya/README.md`). |
| Load test | Script exists (`scripts/laya-load-test.js`); **has not been run on the VM**. |
| Alerting / metrics | **None.** There are no `laya_*` metrics and no alerts; checking is manual (below). |

## What runs where

```
Oracle VM "docwellness-prod" (2 aarch64 cores, ~12 GB RAM)  -- Coolify host
 ├─ docwellness-backend   (Coolify app, Node)         <- calls Laya
 └─ docwellness-laya      (Coolify app, Python)       <- internal only
MongoDB: separate Oracle VM, private address, TLS      <- shadow rows live here
```

- **Coolify project/environment:** `docwellness` / `production`, destination network `coolify`
  (both apps sit on the same Docker subnet).
- **Laya** is a Coolify **Dockerfile-type** app whose Dockerfile is pasted into Coolify
  (General → Dockerfile). The repo copy is `Dockerfile.laya`. They must be kept in sync by hand
  (see "Changing the Laya image").
- **Reachability:** no public domain, no published port. The backend reaches it at
  `http://docwellness-laya:8000` through a Coolify **Custom Network Alias** on the Laya app.
- **Coolify dashboard** is not on the public internet. Reach it through the SSH tunnel to the VM
  (local port 8000), e.g. the Coolify Launcher.

## Configuration

### On `docwellness-laya` (Coolify → Environment Variables / Configuration)

| Setting | Value | Why |
|---|---|---|
| `LAYA_API_KEY` | secret | Bearer token the backend must send. Set in Coolify only. |
| `LAYA_THREADS` | `1` | The VM has 2 cores shared with the backend; do not give Laya all of them. |
| `LAYA_PRELOAD` | `1` | Load the checkpoint at startup. Lazy loading makes the first call ~75 s. |
| `LAYA_MODELS` | `typed-decisions` | Short names (`english`, `multilingual`, `typed-decisions`), not `laya-typed-decisions`. |
| `LAYA_MAX_CONCURRENT` | `4` today; **recommended `2`** | Past this, Laya answers HTTP 503 instead of queueing. Laya serves one request at a time (~5-6 s each), so accepted requests wait for those ahead: with a 15 s client timeout, cap x per-call time must stay under 15 s (2 x ~6 s = 12 s; 4 x 6 s = 24 s means queued requests time out and become abandoned work). |
| CPU limit / memory limit | `1.5` / `4g` | Resource Limits. Model uses ~2 GB. |
| Persistent storage | volume at `/models` | Model weights (~1 GB). Without it every restart re-downloads them. |
| Domains | **empty** | Coolify auto-assigns a public `sslip.io` domain on creation; it must be cleared. |
| Custom Network Aliases | `docwellness-laya` | What the backend resolves. Only takes effect after a Laya **redeploy**. |
| Health check | path `/health`, port `8000`, start period 180 s | `/health` is unauthenticated liveness when `LAYA_API_KEY` is set. |

### On `docwellness-backend`

| Variable | Value | Notes |
|---|---|---|
| `LAYA_ENABLED` | `true` | Master switch. `false` = Laya fully inert. |
| `LAYA_MODE` | `shadow` | `off` \| `shadow` \| `live`. Never `live` yet. |
| `LAYA_SHADOW_SURFACES` | `recipe_classification` | Comma list. Shadow runs only for listed surfaces. |
| `LAYA_BASE_URL` | `http://docwellness-laya:8000` | Must use the **alias**, not the bare app uuid or a container name. |
| `LAYA_API_KEY` | same secret as Laya | |
| `LAYA_TIMEOUT_MS` | `15000` | Fine for fire-and-forget shadow calls. **Far too long for `live`.** |
| `LAYA_SHADOW_MAX_IN_FLIGHT` | `2` (default) | Cap on concurrent shadow calls. Past it, a call is **skipped** (not sent to Laya) and recorded. Keeps a burst of generations from filling Laya's single lane with work that will time out. Keep it at or below Laya's `LAYA_MAX_CONCURRENT`. |

Env changes only take effect after the app is **redeployed**; there is no hot toggle.

## Routine checks

1. **Is Laya up?** Coolify → `docwellness-laya` should show `running:healthy`.
2. **Is the backend reaching it?** In the backend's Coolify **Terminal**:
   ```
   node -e "fetch(process.env.LAYA_BASE_URL+'/health').then(r=>r.text()).then(console.log).catch(e=>console.log(e.cause&&e.cause.code||e.message))"
   ```
   Expect `{"status":"ok"}`.
3. **Are shadow rows being written, and are they succeeding?** From the backend Terminal:
   ```
   node scripts/laya-shadow-report.js
   ```
   Look at `failedByReason`, `latency`, and `rowsByDieticianId`. Pass
   `--exclude-dietician=<id>` for any test account so test traffic is not read as real usage.
   Rows written by manual testing so far all come from one test dietician account.
4. **Trace one row to its request.** Each shadow row stores `requestId` (the backend `req.id`,
   also the `X-Request-Id` response header). Search the backend logs for that id.

### What a shadow row holds (`GenerationLog`, `layaMode: "shadow"`)

`layaSurface`, `requestId`, `model` (what we asked for), `layaDecisions.servedModel` (what Laya
actually served — its router has always answered `laya-rl-agent`), `layaDecisions.answers`,
`layaDecisions.reference` (what the existing flow decided, for comparison), `layaLatencyMs`,
`layaConfidence` (lowest across answers), `layaTimedOut`, and `layaError { reason, detail }` on
failure. It deliberately holds no request text and no personal data.

## Diagnosing failures

Shadow rows record why a call failed in `layaError`:

| `layaError.detail` | Meaning | What to do |
|---|---|---|
| `fetch failed (EAI_AGAIN)` or `(ENOTFOUND)` | The backend cannot resolve the name. Docker only resolves aliases on shared networks, and an alias only exists after the Laya container is recreated. | Confirm the alias is set on Laya **and Laya was redeployed after**; confirm `LAYA_BASE_URL` uses the alias; redeploy the backend. Test from the backend Terminal: `node -e "require('dns').lookup('docwellness-laya',(e,a)=>console.log(e&&e.code,a))"` (should print an address). |
| `fetch failed (ECONNREFUSED)` | Name resolves, nothing listening. | Laya is down, restarting, or still loading the model. Check Coolify status/logs. |
| `reason: timeout` | No answer within `LAYA_TIMEOUT_MS`. | Laya is slow or busy (see below). Compare `layaLatencyMs` on successes. |
| `HTTP 503 ... server busy` | Past `LAYA_MAX_CONCURRENT`. | Deliberate load shedding. Expected under bursts; see "Capacity". |
| `reason: skipped` | The backend's shadow in-flight cap was hit; Laya was **not** called. | Expected under bursts. Many skips mean generations arrive faster than Laya's ~10 calls a minute. |
| `HTTP 401` | API key mismatch between backend and Laya. | Make both `LAYA_API_KEY` values identical; redeploy both. |

**Laya's own logs** (Coolify → `docwellness-laya` → Logs) show a line per request. An absence of
`POST /v1/systemone` lines while the backend reports failures means requests never reached it
(a name or network problem, not a Laya problem).

## Capacity and behaviour to know about

- **Latency on this VM:** about **5 s per call** at `LAYA_THREADS=1` (measured 4.5–5.3 s on the
  real recipe-classification payload); about 4.4 s at 2 threads. Two threads would take both of the
  VM's cores from the backend, so it stays at 1.
- **Laya handles one request at a time.** Throughput does not rise with concurrency; extra
  concurrent requests queue and, past `LAYA_MAX_CONCURRENT`, are refused with 503.
- **A client timeout does not cancel work inside Laya.** It keeps processing the abandoned
  request, so a burst of timeouts is followed by 503s while it catches up. Measured on the
  VM (load test, 2026-10-05): 5 concurrent clients completed 2 of 25 requests and throughput fell
  from 0.18 to 0.03 ok/s, because the queue filled with abandoned requests ("congestion
  collapse"). This is why shadow calls are capped in flight and `LAYA_MAX_CONCURRENT` should be 2.
- **First call after a Laya redeploy** is slower (warm-up); discard it when measuring.
- **Model choice:** we request `laya-typed-decisions` but Laya's router has served
  `laya-rl-agent` every time. Do not assume the requested checkpoint is the one answering.
- **Confidence is not calibrated:** Laya warns at startup that this checkpoint ships invalid
  temperatures. Treat confidence as one weak signal, never as proof (plan §17).
- **Quality is unproven.** In shadow data so far meal type matched the requested slot in 12 of 13
  rows, but `protein_level` has looked wrong for clearly protein-rich dishes. This is small-sample,
  test-account data; it is not an accuracy measurement.
- **Load testing:** `node scripts/laya-load-test.js --yes` (see `tests/laya/README.md`). Run it
  from the backend Terminal at a quiet time; it loads the VM the backend shares. First VM run
  (concurrency 1): mean 5.6 s, p50 5.4, p95 7.2, p99 8.0, 0 errors, 0.18 ok/s; backend `/health`
  p95 unaffected (~10 ms). It now waits for Laya to drain between stages.

## Rollback and emergency off

Laya is never a hard dependency: every call fails soft and shadow calls are fire-and-forget, so
Laya being down changes nothing for users. To switch it off anyway:

1. **Stop shadow calls:** set `LAYA_ENABLED=false` on `docwellness-backend` and redeploy it.
   No database migration is needed; the added `GenerationLog` fields are additive.
2. **Stop only one surface:** remove it from `LAYA_SHADOW_SURFACES` and redeploy.
3. **Free the CPU/RAM:** stop the `docwellness-laya` resource in Coolify. The backend keeps
   working (its Laya calls just fail soft).

Not instant: env changes need a backend redeploy.

## Routine changes

**Rotate `LAYA_API_KEY`.** Generate a new random value (e.g. `openssl rand -hex 32`), set it on
**both** apps, redeploy Laya then the backend. Until both are done, shadow calls fail soft with
401. Never commit the key.

**Change threads / CPU / memory.** Edit on `docwellness-laya`, redeploy. Keep Laya at or below the
cores the backend can spare (plan §9). Re-run the load test after changing them.

**Change `LAYA_TIMEOUT_MS`.** Backend env, redeploy. Pick it from the measured `layaLatencyMs`
distribution; the current 15 000 ms is only acceptable because shadow calls are not awaited.

**Changing the Laya image (version bump, Dockerfile change).**
1. Edit and commit `Dockerfile.laya` (the `laya[serve]==x.y.z` pin).
2. In Coolify → `docwellness-laya` → General → **Dockerfile**, replace the contents with the new
   file and Save. (The Coolify API refuses to update this field, so it is a manual paste.)
3. Redeploy. Weights persist in the `/models` volume; expect a slow first call.
4. The image must keep `curl`: Coolify's health check shells out to `curl`/`wget`, and a
   slim Python image has neither — without it the deploy is marked unhealthy and rolled back.
5. On aarch64, torch must come from the CPU wheel index (already in the Dockerfile); a plain
   `pip install torch` pulls the multi-GB CUDA build.

**Redeploying Laya** takes ~3–4 minutes (build). Coolify keeps the old container serving until
the new one passes its health check.

## Before enabling another surface

- **`diet_plan_review`:** its stored `reference` now holds only a risk-flag **count**
  (`riskFlagCount`), not the flag names (e.g. `isMinor`), so nothing health-adjacent is stored.
  One thing is still open: the summary **sent to** Laya for the call (not stored) still includes
  the flag names and up to 10 warning strings. That goes to an internal service only, but
  decide whether it should be generalised too (open question 12 in the analysis doc) before
  adding the surface to `LAYA_SHADOW_SURFACES`.
- Re-run the load test with the added traffic, and watch backend latency while it runs.

## Data hygiene

- Shadow rows from manual testing come from a test dietician account and are **not real usage**.
  Exclude them with `--exclude-dietician`.
- Rows written before the request-id/model change (b9d6ad6, 2026-10-05) have neither field.
- Nothing in shadow data is reviewed ground truth. Accuracy comes only from the
  dietician-reviewed dataset (`tests/laya/README.md`).

## Tooling index

| Script | Purpose |
|---|---|
| `scripts/laya-shadow-report.js` | Summarise shadow rows; `--exclude-dietician` for test accounts. Read-only. |
| `scripts/laya-eval-export-review-sheet.js` | Build a review sheet from real recipes for dieticians to label. Read-only. |
| `scripts/laya-eval-run.js` | Score Laya against the reviewed dataset (reviewed rows only). |
| `scripts/laya-load-test.js` | 1/5/10/20/50 concurrency load test with backend-impact probe. Needs `--yes`. |

## Open items (not done yet)

- Dietician-reviewed dataset (500 rows) and the accuracy thresholds the team sets.
- Load test on the VM, and reading Laya's CPU/RAM from Coolify during it.
- `laya_*` metrics and any alerting.
- `validate_diet_plan()`, candidate filtering and the PASS/FAIL/UNCERTAIN gating flows.
- Phases 5–7 of the rollout (internal users, percentage of traffic, gradual).
- The final implementation report required by the integration plan.
