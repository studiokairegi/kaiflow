# End-to-end test results (Phase 7)

**Read this first.** Every number below was measured in the Phase 7 session on 14 November 2026 (Python 3.12.3, Node v22.23.4, a sandbox with **no
network, no database, no mail provider and no Gemini key**). So these are results of **offline** tests: mocked providers, fake database calls, source-level
checks of the code and migrations, and the real controller code running as local processes. **None of them is a live end-to-end run.** They show the
code behaves as designed under the conditions the tests build. They do not show that production is ready (see `PRODUCTION_READINESS_REPORT.md`).

Reproduce everything with: `python scripts/phase7_validation.py --full --controller` from `intelligence-worker/` (about two minutes; the controller part needs a POSIX system).

## 1. What was run and what happened

| Run | Result |
|---|---|
| Python worker suite, complete (`unittest discover`) | **1178 tests, OK** (1137 before this session + 41 new Phase 7 tests) |
| Node app suite, complete (`node --experimental-strip-types --test`) | **1191 tests, 1191 pass, 0 fail** |
| Controller acceptance (`scripts/controller_acceptance.py`, real controller and worker processes on this machine) | **39 of 39 checks passed** (88 s) |
| The five-task validation matrix below | **all passed** |
| Not run: a full `vite build`, `pytest`, any SQL, any live provider request | see Section 5 |

### The validation matrix (roadmap Phase 7 tasks 1 to 5)

| Task | What it covers | Python tests | Node tests | Result | Kind of evidence |
|---|---|---|---|---|---|
| 1 | Agent Chat, providers, controller, worker, discovery, CRM, Inbox working together | 416 | 33 | PASS | mocked providers, fake RPC, source-level |
| 2 | Gemini success and every fallback path | 159 | - | PASS | mocked HTTP; **no real Gemini request** |
| 3 | Job retries, worker restarts, duplicate prevention, recovery | 113 | - | PASS | mocked database; controller tests use the real controller code |
| 4 | Permissions, organization boundaries, suppression, email approval controls | 147 | 14 | PASS | source-level over migrations and code; **SQL is never executed** |
| 5 | Provider quotas, usage budgets, operational limits | 127 | - | PASS | mocked clocks and counters |

The counts overlap (several modules serve more than one task), so they do not add up to the full-suite total.

## 2. What the tests actually establish

- **Job reliability (task 3).** A late or repeated failure report cannot turn a succeeded job back into a queued one; completion is idempotent for the same worker; a lease lost mid-job is never re-run by the worker; transient errors back off and permanent ones stop; a second worker is refused by the lock file. These are checked against mocked database responses, so they prove the worker handles each response correctly, not that the hosted database returns them (the Phase 4 SQL contract has never been run).
- **Controller and restarts (task 3).** The 39 real-process checks cover: crash back-off on the documented schedule (20, 40, 80, 160, 320, 600 seconds, capped); exit code 2 treated as a configuration error and delayed; exit code 73 (duplicate worker) flagged and not restarted; an externally killed worker restarted; a worker that ignores SIGTERM force-killed after about 8 seconds; recovery after an explicit Start; no secrets in the status output; authentication, origin, host-header (DNS rebinding), content-type and size limits; remote Ollama URLs refused; shutdown stopping the worker. Windows behaviour is **not** tested (POSIX only).
- **AI routing and fallback (task 2, 5).** Gemini-first routing, Ollama fallback with a recorded reason, the forced-Ollama rollback flag, rate and daily request budgets, provider attribution on job results and chat messages. All against mocked HTTP responses; **no request left the machine**.
- **Safety controls (task 4).** Suppression, contactability, daily caps, approval states, the kill switch and the send boundary, as written in the code and the migrations.

## 3. New in Phase 7: whole-repository checks (41 tests)

`tests/test_phase7_production_validation.py` reads every migration and the worker code. It checks the files; it does not run SQL.

| Check | Result today |
|---|---|
| Migration versions are unique and well formed; repeated names are exactly the known set; no stray non-`.sql` files or backup copies in live folders | pass |
| The database's job-kind constraint (last migration that sets it) lists exactly the 21 kinds the worker handles | pass |
| No destructive DDL (`drop table`, `truncate`, `drop column`, column type change) in Intelligence/Email migrations except the legacy-mailbox removal | pass (the one allowed file drops 2 tables) |
| Replaying every migration in order: **no `intel_*` function is executable by PUBLIC or anon** | pass (after the Phase 7 migration; see Section 4) |
| Private `_intel_*` helpers are not callable by signed-in users | pass |
| Every one of the 56 admin RPCs calls the owner guard; 80 of 81 agent RPCs call the agent guard and the remaining one is service-role-only | pass |
| Both guards fail closed; every `security definer` function pins its `search_path` | pass |
| Safe defaults: kill switch on, autonomy `shadow`, no migration creates settings with sending on; the final send reservation still checks kill switch, suppression, approval and daily caps; turning sending on needs sender identity and a registered agent; **no worker code can write the kill switch** | pass |
| The metrics SQL pack is read-only and every table and column it names exists | pass |
| The detectors catch what they exist to catch (synthetic migrations: a function created after the last revoke, drop-and-recreate resetting a grant, EXECUTE-string grants) | pass |

## 4. Defect found by these checks and fixed

**Two service-role-only functions were open to signed-in users.** Replaying the migrations showed that `20270103100000_intelligence_emma_actions.sql` ends with a loop that
grants `EXECUTE` to `authenticated` on every `intel_*` function except private helpers and `intel_is_authorized_user`. It runs after `intel_resend_record_inbound` and
`intel_agent_apply_delivery_event` had been locked to `service_role`, and re-opened them. Their bodies still refuse a caller whose role is not `service_role`, so this was
**not exploitable**; the grant was wider than intended. Fixed with the forward-only, idempotent migration `20270105090000_intelligence_phase7_service_role_grants.sql`
(revoke and grant only; **not executed anywhere**). A test proves that without it the two functions are exposed and with it they are not, and a SQL test
(`supabase/tests/intelligence_phase7_service_role_grants.test.sql`, also **not executed**) and two live catalog queries (19 and 20 in `SHADOW_MODE_METRICS.sql`) let you confirm it on a real database.

I also got the privilege detector wrong on the way to getting it right (it first missed the repo's `DO`-loop bulk revokes and reported 74 false exposures, then missed `EXECUTE '...'` strings, and inline SQL comments truncated the column reader). Each was a reader gap, fixed
and covered by self-tests. I mention it because it shows why the live queries 19 and 20 matter: a source reader can be wrong, the database cannot.

## 5. Not run, and why

| Roadmap task | Why it was not run | What closes it |
|---|---|---|
| 6 Prospect discovery in shadow mode | no network or database | Stage 3 of `PRODUCTION_ROLLOUT_PLAN.md` |
| 7 Prospect quality and research accuracy | needs real prospects and a human reading sources | the 20-report labelling method in the plan; query 9b |
| 8 Draft-only outreach | needs live Gemini or Ollama and real prospects | Stage 4 |
| 9 Inbound replies and conversation sync | needs a live mailbox | Stage 4, step 3 |
| 10 Execution logs and provider attribution | no live logs exist | queries 3 and 14 after Stage 3 |
| 11 Operational performance and bottlenecks | no real workload has run | queries 2, 4, 5 and 15 after a week of shadow mode |
| 12 Limited production workloads | requires your approval; none given | Stage 5, written approval |
| 13 A documented rollback procedure for every production change | **written** (`ROLLBACK_PROCEDURES.md`), but never drilled: no system to drill it on | the drill in Section 9 of that document |
| Real Gemini request; real Ollama request | no key, no network, no Ollama | `selftest`, Stage 2 |
| All SQL (migrations, SQL tests, metrics queries) | no PostgreSQL | rehearsal on a branch or copy, Stage 1 |
| Full `vite build`, `pytest` | no installed toolchain here (the project's own `npm test` suite does run and passes) | your machine, Stage 0 step 6 |
| Windows controller behaviour | POSIX-only here | your machine |

## 6. How to read a pass

A passing mocked test means "given this response, the code does the right thing". It cannot catch a wrong assumption about the real service: a Gemini model id that does
not exist, a free-tier limit that differs from the configured one, a column the hosted database does not have because a migration was never applied. Those are exactly the
risks the unrun items above exist to catch, which is why the verdict in the readiness report is **not ready** despite about 2,400 passing checks (1178 Python, 1191 Node, 39 controller).
