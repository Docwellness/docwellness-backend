# Review policy: docwellness-backend

Read by the `dw-reviewer` agent and by human reviewers. It is advisory: findings never approve or block a change on their own.

## Passes (every review runs all three)
1. **Bugs** - logic errors, broken edge cases, regressions, unhandled promise rejections, wrong Mongoose query shape.
2. **Security** - missing or weakened auth/role checks on a route, injection through unvalidated input, PII or secrets in logs or
   responses, `.env` values leaking into code or output.
3. **Compliance** - does the diff match the change's specs, design and tasks (`docwellness-specs/openspec/changes/<change>/`)? Flag
   anything built that nobody asked for, and anything asked for that was not built.

## Important (always raise)
- Any change that touches authentication, payments, subscriptions, patient health data, data deletion, or production data.
- Writes to the database from a script or migration, or a change that makes a script able to reach the production database. The
  `.env` database is not production; production is on Coolify.
- Patient data deletion that does not go through `utils/patientDataDeletion.js`.
- A new or changed endpoint with no test, or a changed API response shape (the Flutter apps depend on it).
- Test code that would pass without the production change, or that is dead, duplicated or over-mocked.
- Queries inside loops, missing indexes on new query paths, unbounded result sets.

## Nit (raise at most 5 per review, only if nothing Important is left out)
- Naming, comment density or style that departs from the surrounding file; small duplication; missing `async-handler` wrapper
  where neighbouring routes use it.

## Skip
- Generated or vendored output (`node_modules/`, `.vercel/`, `uploads/`, `logs/`), lockfiles, and formatting that `npm run lint`
  or `npm run format` already enforces.
- The root `reset*.js` / `clean-all.js` scripts and other scratch files unless the diff touches them.
