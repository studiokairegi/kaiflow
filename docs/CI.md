# CI and quality tooling

Everything here runs on every pull request and on every push to `main` (`.github/workflows/ci.yml`).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Existing suite (`node --test`, ~1,370 tests). **Unchanged.** |
| `npm run lint` | ESLint. Real-bug rules fail the run; hygiene findings are warnings. |
| `npm run typecheck` | TypeScript `checkJs` ratchet (see below). |
| `npm run test:unit` | Vitest + jsdom component tests (`src/**/*.spec.{js,jsx}`). |
| `npm run test:e2e` | Playwright smoke tests (builds and serves the app itself). |
| `npm run e2e:install` | One-time: download Chromium for Playwright. |
| `npm run verify` | lint + typecheck + test + test:unit + build (everything except e2e). |

Test file naming keeps the runners apart: `*.test.mjs` = node:test, `*.spec.jsx` = Vitest, `e2e/*.spec.js` = Playwright.

## Type-check ratchet

The code is plain JavaScript, so `checkJs` reports ~1,760 inference errors today. Rather than a gate that is red forever,
`typecheck-baseline.json` records the error count per file. CI fails only if a file gets **worse** or a new file has errors.
When you fix errors, run `npm run typecheck:update` and commit the smaller baseline. Never run `:update` to hide new errors.

## End-to-end safety

The Playwright run builds against a **stub** Supabase URL (process env beats any local `.env`) and aborts every request that
is not to localhost. It cannot reach production Supabase, Paystack, Resend or Google. Tests need no credentials.

## Making CI a deploy gate (Cloudflare Pages)

Pages builds on push by itself, so a failing Action cannot stop it unless `main` only ever receives green code:

1. GitHub -> Settings -> Branches -> add a rule for `main`.
2. Tick **Require a pull request before merging** and **Require status checks to pass**; add the check named **CI**.
3. Tick **Do not allow bypassing the above settings** (otherwise admins can still push straight to `main`).

Work on a branch, open a PR, merge when CI is green; Pages then deploys the merged commit.

## Line endings

`.gitattributes` forces LF. The Finance V2 guard (`src/finance-v3/guards/isolation.test.mjs`) hashes raw bytes, so a
checkout with different line endings fails it. `docs/finance-v3/v2-baseline.sha256` was regenerated from the committed (LF) bytes;
the V2 files themselves are unchanged.
`docs/finance-v3/integration-baseline.sha256` (Phase 1 rev. 1.1) was regenerated the same way: the original manifest matched the
Windows CRLF working copies byte-for-byte (no content drift), and the 17 files that had CRLF are now pinned by their LF hashes.

## Not covered yet

- SQL tests under `supabase/tests/run*.sh` need a Postgres service container.
- Supabase Edge Functions (Deno) are not type-checked; their `.test.mjs` files do run under `npm test`.
- ESLint warnings (~180) are visible but non-blocking. Promote a rule to `error` once its count reaches zero.
