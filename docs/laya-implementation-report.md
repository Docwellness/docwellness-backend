# Laya integration — implementation report

_As of 2026-10-05. Status: **shadow mode, one surface, no real traffic yet. Not production-ready
for `live`.**_ This is the report the integration plan (section 31) asks for. It reports what was
measured, says where the measurement is weak, and leaves a field empty where nothing was measured.
Companion docs: `docs/laya-integration-analysis.md`, `docs/laya-architecture.md`,
`docs/laya-deployment.md`, `docs/laya-evaluation.md`, `docs/laya-operations.md`.

## Summary

- **What exists:** Laya runs as a separate, internal-only service on the production Oracle VM. The
  backend calls it through `layaDecisionService` and records its answers in shadow mode for
  recipe classification. Laya never affects a response, and every failure mode seen so far left
  user-facing recipe generation unaffected.
- **What is proven:** the infrastructure, the fail-soft behaviour, the capacity limits, and the
  resource cost (below).
- **What is not proven:** **whether Laya's decisions are accurate.** There is no dietician-reviewed
  dataset, so no accuracy has been measured. All 25 shadow rows so far come from a test account.
- **Verdict:** the shadow infrastructure is operating. `LAYA_MODE=live` is not appropriate and
  would not be viable on this hardware even if accuracy were proven (one request every ~5.5 s).

## Report fields (plan section 31)

```text
Laya version:            laya[serve]==0.3.26 (PyPI), Python 3.12-slim, CPU-only torch (aarch64)
Model:                   requested laya-typed-decisions; Laya's router served laya-rl-agent every call
CPU:                     VM = 2 aarch64 cores shared with the backend. Laya limit 1.5 CPU.
                         Measured: ~140-150% of one core under load (at the limit); ~0.1% idle
RAM:                     VM ~12 GB. Laya limit 4 GB. Measured: ~2.15-2.2 GB under load, ~2.14 GB idle
Threads:                 LAYA_THREADS=1 (effective CPU use ~1.5 cores - see Findings)
Average latency:         5.5 s   (concurrency 1, 20 requests, 80% recipe / 20% review payload mix)
P50:                     5.3 s
P95:                     7.0 s
P99:                     7.1 s   (a second run: 5.6 / 5.4 / 7.2 / 8.0 s)
Error rate:              0% at concurrency 1 (0 of 40 across two runs).
                         Above the concurrency cap, excess requests are refused (HTTP 503) by design:
                         92-99% at 5-50 concurrent clients. Not errors in the failure sense.
Timeout rate:            0% at every level after the concurrency fix (was 92% at 5 clients before it)
Evaluation accuracy:     NOT MEASURED - no reviewed dataset exists
Backend latency impact:  backend /health p95 9-16 ms during load vs 13 ms idle; 33 ms at 50
                         concurrent clients (partly the test's own overhead). No failures.
Fallback behavior:       fire-and-forget behind a timeout; any Laya failure is swallowed. Verified in
                         production through DNS failures, timeouts and 503s: recipes returned 200.
Production rollout:      Phase 4 (shadow), recipe_classification only, test traffic only.
                         Phases 5-7 not started. diet_plan_review built but not enabled.
```

## What was built

| Area | State |
|---|---|
| Deployment | Separate Coolify app `docwellness-laya`, same project and `coolify` network as the backend. No public domain or port. Reached through a Custom Network Alias. Weights in a `/models` volume. Non-root. |
| Resource caps | `LAYA_THREADS=1`, CPU limit 1.5, memory limit 4 GB, `LAYA_PRELOAD=1`, `LAYA_MAX_CONCURRENT=2`. |
| Abstraction | `services/layaDecisionService.js`: fail-soft calls, short typed functions. `validate_diet_plan()` not written. |
| Shadow mode | `services/layaShadowService.js`: fire-and-forget, per-surface switch, in-flight cap, rows in `GenerationLog` with request id, model, answer, latency, confidence, error. |
| Flags / rollback | `LAYA_ENABLED`, `LAYA_MODE`, `LAYA_SHADOW_SURFACES`, `LAYA_SHADOW_MAX_IN_FLIGHT`. Rollback = `LAYA_ENABLED=false` + backend redeploy; no migration. |
| Tooling | Shadow report, review-sheet exporter (JSON/CSV) and strict importer, evaluation scorer, load test (with drain and backend probe). |
| Tests | Five Laya suites (decision service, shadow service, evaluation, load test, CSV), ~95 tests, passing at last run. |
| Docs | The five required docs plus this report. |

## Load test results (production VM, 2026-10-05)

Payload: three built-in recipe shapes (6, 13, 20 ingredients) and a synthetic ~2 KB review summary,
80/20 mix, through the same `layaDecisionService` path production uses. Each stage waits for Laya
to drain before the next. Client timeout 15 s.

**Run 1** (`LAYA_MAX_CONCURRENT=4`, before the drain step): concurrency 1 was healthy (20/20, mean
5.6 s). At 5 concurrent clients **2 of 25** requests succeeded, 92% timed out, and throughput fell
from 0.18 to 0.03 ok/s. The queue filled with requests the clients had already given up on, and
nothing completed until the load stopped. The concurrency-10 line in this run partly measured that
backlog and is not reliable.

**Run 2** (`LAYA_MAX_CONCURRENT=2`, with drain):

| Clients | OK | Timeouts | Refused (503) | Notes |
|---|---|---|---|---|
| 1 | 20/20 | 0% | 0% | mean 5.5 s, p50 5.3, p95 7.0, p99 7.1, 0.18 ok/s |
| 5 | 2/25 | 0% | 92% | the 2 admitted took ~4.1 s and ~9.5 s |
| 10 | 2/50 | 0% | 96% | same |
| 20 | 2/100 | 0% | 98% | same |
| 50 | 2/250 | 0% | 99.2% | same |

**Run 3** (levels 1, 2, 50; output not retained): used to read CPU and RAM from Coolify's metrics
(below).

**How to read these:**
- **Capacity is about one request per 5.4 s, roughly 11 per minute, whatever the load.** Laya serves
  one request at a time. Above the cap it refuses instantly and keeps serving the admitted ones at
  normal speed.
- **Stages above concurrency 1 measure load shedding, not capacity.** Fast refusals use up the
  request count within seconds, so each had only 2 successes. Their p95/p99 rest on 2 samples and
  are not meaningful.
- **Resource use** came from Coolify's Metrics view, at coarse granularity.

## Production shadow-mode check

Five recipe generations fired at once: Laya was called for **2** (5.5 s and 9.9 s, the second
waiting behind the first); the other **3** were recorded as `skipped` (`shadow in-flight cap
reached (2)`) and never reached Laya. All 5 recipe responses were 200 in 6-10 s. Every row's
`requestId` matched the response's `X-Request-Id`.

## Shadow data so far (not an accuracy measurement)

25 rows, **all from one test dietician account** (excluded from reports with
`--exclude-dietician`). There is no real-usage data.

| Outcome | Rows |
|---|---|
| Succeeded | 15 |
| Failed during bring-up (DNS ×4, timeouts ×2, one before failure reasons were recorded) | 7 |
| Skipped by the in-flight cap | 3 |

Of the 15 successes, Laya's meal type matched the slot the generator was asked for in **14**. The
miss was a snack requested as "Evening Snack" that Laya called "dinner". That measures consistency
with the request, which is not accuracy. Laya's `protein_level` answered "low" for several clearly
protein-rich dishes (chicken curry, chole, fish curry, rajma, paneer tikka). That is anecdotal
and small-sample, but it is the kind of disagreement the evaluation dataset exists to quantify.
Laya also warns at startup that this checkpoint's confidence is not calibrated.

## Findings and fixes during rollout

| Issue | Effect | Resolution |
|---|---|---|
| Coolify auto-assigns a public domain to new apps | Laya briefly had a public address | Cleared; verified unreachable |
| Coolify's health check needs `curl`; slim image has none | Deploy marked unhealthy and rolled back | `curl` added to the image |
| Bare app name did not resolve from the backend (`EAI_AGAIN`) | Every shadow call failed | Custom Network Alias, then redeploy of Laya |
| Default 3 s timeout vs ~5 s calls | Every call timed out | `LAYA_TIMEOUT_MS=15000` (acceptable only because calls are fire-and-forget) |
| Client timeout does not cancel work inside Laya | Congestion collapse under bursts | `LAYA_MAX_CONCURRENT=2` and a shadow in-flight cap |
| Shadow rows recorded no failure reason | Failures undiagnosable | `layaError {reason, detail}`, network cause code surfaced |
| `dotenv` banner printed to stdout | Corrupted the first line of CSV exports | Silenced in the exporter |
| `.dockerignore` excluded all of `tests/` | Reviewed datasets would not reach the container | `tests/laya` now ships |
| Laya uses its full 1.5-CPU limit despite `LAYA_THREADS=1` | Three quarters of the VM busy during inference | Open: see below |
| Stage A assumed port 8080 and a `laya-` prefix on `LAYA_MODELS` | Wrong defaults | Corrected (port 8000, short names) |

**Open finding.** Under load Laya's CPU plateaus at the container limit (~150%), so
`LAYA_THREADS=1` does not confine it to one core. The likely cause is thread pools outside torch
(OpenMP/BLAS/tokenizers); that is a hypothesis, not confirmed. The Docker limit still guarantees the
backend at least 0.5 core. An untried experiment would set `OMP_NUM_THREADS=1`,
`MKL_NUM_THREADS=1` and `TOKENIZERS_PARALLELISM=false` to make Laya truly single-core, at an unknown
cost in latency (a second thread earlier helped by only ~15%).

## Definition of done (plan section 30)

| | Item | Status |
|---|---|---|
| ✅ | Separate internal service; not publicly exposed | Done, verified |
| ✅ | Configurable CPU/thread settings; API authentication | Done |
| ✅ | Backend talks to Laya only through `LayaDecisionService` | Done, enforced by a test |
| ✅ | Feature flags; shadow mode; timeouts; fallback; health check | Done |
| ✅ | Rollback by configuration; existing LLM flow works with Laya off | Done |
| ✅ | Automated tests | ~95 tests |
| ✅ | Sensitive information not unnecessarily logged | Shadow rows hold decision metadata only; the diet-plan reference now stores a risk-flag count, not names |
| 🟡 | CPU/RAM load testing | Done, with caveats: built-in fixtures not real DB recipes; stages above 1 client are short |
| 🟡 | Production logging and metrics | Rows and logs exist; **no `laya_*` metrics, no alerting** |
| ❌ | Evaluation dataset | Not started; needs dieticians |
| ❌ | Recipe classification, compatibility and plan validation evaluated | Blocked on the dataset |
| ❌ | Gradual production rollout | Not started |

## Deviations from the plan

- **Shadow before the evaluation dataset.** The plan puts the dataset first. We went to shadow
  without it. The evaluation doc gates `live`, not `shadow`, but it is still out of order.
- **Stack differs from the plan's diagrams:** MongoDB and OpenAI, not PostgreSQL/Redis and Claude.
- **Regeneration bound:** the existing loop (`MAX_GENERATION_ATTEMPTS = 3`) stays the only bound
  rather than a separate `MAX_REGENERATIONS=2`. `shouldRegenerate` is not wired.
- **Not built:** `validate_diet_plan()`, candidate filtering, compatibility wiring, PASS/FAIL/UNCERTAIN
  gating.
- **Manual testing wrote production rows** (all 25), from a test account, to a production database.

## Limits of this report

- One VM, one day, one operator. Latency was measured with fixture payloads.
- CPU and RAM were read from Coolify charts by eye, not from raw time series.
- Run 3's output was not kept; only its resource readings are used.
- Everything about accuracy is **unknown**, not "good" or "bad".

## What would move this forward

1. A dietician-reviewed dataset (500 rows, plan §10) and accuracy thresholds set by the team.
2. Real shadow traffic, analysed with `scripts/laya-shadow-report.js --exclude-dietician=<test id>`.
3. A decision on latency for `live`: this hardware allows ~11 calls a minute, so `live` needs a
   different setup (faster model format, more CPU, GPU, or a dedicated VM). Shadow mode does not.
4. A per-user flag mechanism for the staged rollout, and `laya_*` metrics.

Do not claim production readiness for `live` until items 1 and 3 are resolved.
