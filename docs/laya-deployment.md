# Laya integration — deployment

This document splits cleanly into two parts: what's in this repo for **local
development/testing**, and what a human **operator with Coolify/Oracle access** must
do to actually stand Laya up in production. This session (and the Stage A commit it
produced) has no SSH or Coolify access — nothing here was executed against the real
Oracle VM.

## Local development: `docker-compose.laya.yml`

```
docker compose -f docker-compose.yml -f docker-compose.laya.yml up
```
(or `docker compose -f docker-compose.laya.yml up` standalone if Mongo/Redis are already
running separately for local dev).

This starts a `laya` service on the compose network with no host port published — only
the `backend` service (same Docker network) can reach it, by service name
(`http://laya:8000`), never `127.0.0.1`. Before first use:

1. Confirm the actual Laya project publishes a prebuilt image and set the `image:`
   field in `docker-compose.laya.yml` accordingly — it currently has a placeholder. If
   no prebuilt image exists, building one (`Dockerfile.laya`) is a Stage B follow-up,
   not fabricated here.
2. Set `LAYA_API_KEY` in your local `.env` to any value — this is a local dev key, not
   the production secret.
3. `LAYA_ENABLED`/`LAYA_MODE` default to `false`/`off` — the backend behaves exactly as
   it does without Laya unless you explicitly opt in locally.

This compose file is **not** the production topology — see below.

## Production: operator-executed Coolify steps

Production today is a **single-container Coolify deployment** (the repo's `Dockerfile`,
no `docker-compose.yml` drives prod). There is no existing multi-service compose stack
to extend. The recommended approach:

1. **Create a second Coolify "resource"** in the same Coolify project as the backend,
   for Laya (either from a prebuilt image, or from source if one doesn't exist — confirm
   which before proceeding).
2. **Verify internal networking before assuming it works.** Coolify projects support a
   shared internal Docker network with service-name DNS resolution between resources in
   the same project/environment — confirm this is actually configured for this project
   (check Coolify's project/network settings), rather than assuming `127.0.0.1:<port>`
   will reach a sibling container. Separate Coolify resources are separate containers;
   they do not share a localhost network namespace.
3. **Do not expose Laya's port publicly.** No domain, no Traefik route, no published
   host port for the Laya resource — internal network only.
4. **Set `LAYA_BASE_URL`** on the backend resource to Laya's internal Coolify hostname
   once step 2 is confirmed.
5. **Set secrets in the Coolify UI**, matching how every other prod secret
   (`OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, etc.) is already managed — never
   committed to git, never placed in a repo file.
6. **Size `LAYA_THREADS`** against the Oracle VM's *actual* vCPU count — inspect the
   real machine (`nproc`, Oracle Cloud console) before picking a number; do not assume a
   generic default is safe. Keep it at or below the number of physical cores actually
   available to the app, leaving headroom for the backend process itself.
7. **Decide `LAYA_PRELOAD`** based on the VM's actual free RAM — don't enable it
   blindly on a resource-constrained "Always Free" instance; lazy loading is supported
   and is the safer default until real RAM headroom is confirmed.
8. **Health check**: confirm Laya exposes a health endpoint (adjust the healthcheck in
   `docker-compose.laya.yml`'s pattern for the Coolify resource) and that Coolify's own
   health-check/restart-policy is configured so a crashed Laya container restarts
   automatically without operator intervention.
9. **Non-root, minimal filesystem**: run the Laya container as a non-root user
   (`user:` in the local compose file shows the pattern) with no more filesystem access
   than model-cache persistence requires.
10. **Load test before trusting any latency number.** Laya's own published CPU
    benchmarks were not measured on this hardware. Test at 1/5/10/20/50 concurrent
    requests against actual recipe/diet-plan-sized payloads; record average, p50, p95,
    p99 latency, CPU, RAM, and any backend-latency impact. Do this before `LAYA_MODE`
    ever leaves `shadow`. Use `scripts/laya-load-test.js` (see `tests/laya/README.md`, "Load test").

## Rollback

One environment variable: `LAYA_ENABLED=false`. No database migration is required —
every field added to `GenerationLog` in Stage A is additive/optional, and nothing reads
`config.laya` in a live request path until Stage B wires it, guarded by this same flag.

## Env var reference

| Var | Default | Notes |
|---|---|---|
| `LAYA_ENABLED` | `false` | Master kill switch. Must stay `false` in prod until the evaluation dataset (`docs/laya-evaluation.md`) and shadow-mode review are complete. |
| `LAYA_MODE` | `off` | `off` \| `shadow` \| `live` — see `docs/laya-architecture.md`. |
| `LAYA_SHADOW_SURFACES` | empty | Comma-separated shadow surfaces: `recipe_classification`, `diet_plan_review`. Shadow only runs when `LAYA_ENABLED=true`, `LAYA_MODE=shadow` AND the surface is listed - so each decision is switched on independently. Rows land in `GenerationLog` with `layaMode: 'shadow'` and `layaSurface`. |
| `LAYA_BASE_URL` | unset | Internal-only address. Never a public URL. |
| `LAYA_API_KEY` | unset | Bearer token, set via Coolify secrets in prod. |
| `LAYA_MODEL` | `laya-typed-decisions` | See `docs/laya-evaluation.md` for why this default, not the base checkpoint. |
| `LAYA_TIMEOUT_MS` | `3000` | Per-call timeout; on expiry `layaDecisionService.js` returns `{ok:false, reason:'timeout'}`, never blocks the caller indefinitely. |
