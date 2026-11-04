# KairFlow Intelligence: V1 completion report

Scope of this pass: audit the previous session's package, finish what was missing, integrate into the latest repository, and test as far as this environment allows.
Everything below is labelled **Done and tested**, **Done, not executed here**, or **Not done / needs you**.

## Verification limits of the environment this was built in
No PostgreSQL, no npm registry access (so no `node_modules`, no `npm run build`, no Vite), no browser, no Windows, no Ollama, no Zoho. So:
- JavaScript unit tests and Python tests were run for real. SQL, the Vite build, a real browser, Windows scripts, Ollama and Zoho were **not** executed.
- Substitutes used: TypeScript's JSX parser for syntax, a server-side render of every Intelligence view (with stubbed data), and static contract tests over the SQL.
  They catch typos and wiring mistakes. They do **not** replace running the SQL tests, `npm run build` and a browser pass. Commands are in `INTELLIGENCE_SETUP.md`.

## Results
| Check | Result |
|---|---|
| Full JS suite (`node --test`) | 633 tests, 633 pass (baseline repo alone: 576; the 2 "attachment" failures reported earlier do not occur on the latest repo) |
| Python worker (`unittest`) | 85 tests, 85 pass (was 45) |
| JSX syntax, 17 files incl. `App.jsx` | OK (TypeScript parser) |
| SSR smoke render of all Intelligence views, access allowed / denied | 8/8 render; denied access renders nothing |
| PostgreSQL 16 SQL tests (`run_intelligence_auth.sh`) | **Not executed here.** Runner and the new `intelligence_v1.test.sql` (81 assertions) are written; run them |
| `npm run build` | **Not executed here** |
| Browser testing | **Not executed here** |
| Live Supabase schema check, `is_admin` trigger | **Not executed here.** SQL to run is below |
| Zoho | **Not tested** (no OAuth, per instructions). See `ZOHO_COMPATIBILITY.md` |

## Inventory: the eleven outstanding items from the previous session
| # | Item | Status |
|---|---|---|
| 1 | SQL tests never run on PostgreSQL | **Open.** Tests exist (previous 2 files + new V1 file, wired into the runner). Must be run by you |
| 2 | Production build unverified | **Open.** All files parse; imports resolve in the SSR run; `npm run build` still needed |
| 3 | Browser testing | **Open** |
| 4 | Zoho calls untested | **Open**, by design (needs your approval). Report written |
| 5 | Live schema assumptions | **Partly closed.** Every column and constraint the SQL relies on was checked against the repo's migrations (`leads`, `activity_log`, `studio_memberships`, `user_settings`). The live database itself is unchecked: run the query below |
| 6 | `is_admin` self-escalation trigger | **Found in source** (`migration_security_hardening.sql`, root level). **Live state unverified**: run the query below. The Intelligence authorization migration only **warns** if the guard is missing (it does not stop), so check it before applying anything. `docs/verify_live_database.sql` has the read-only query |
| 7 | AI Generated dashboard count + lead filter | **Done and tested.** Dashboard Leads card shows an "AI generated" chip (only when there are any) that opens the board filtered; the board has an "AI Generated" toggle. Based only on the immutable `source_kind`; works with the archived list too |
| 8 | Email threading headers | **Done, not executed live.** Follow-ups and auto-replies carry `In-Reply-To`/`References`; sending uses Zoho's reply action with a safe one-time fallback. Zoho's behaviour on the Free plan is unverified |
| 9 | Kickstarter / X discovery | **Still excluded**, as before (no sanctioned API access assumed) |
| 10 | Studio discovery depends on manual websites | **Partly addressed.** Still no automatic directory crawl (would need a search provider or scraping ToS review). New: you can say "research <name> <website>" in Agent Chat, which adds and researches a studio; seed pages stay editable on the Campaign tab |
| 11 | Agent Chat | **Was missing. Implemented** (below) |

## Gmail provider (added after the first report)
Gmail is now a second mail provider, selectable in Settings > Connections, because Zoho Free's API access is unproven. See `GMAIL_SETUP.md`.
- **Done and unit-tested, not run against Google:** migration `20261109150000`, three Edge Functions (`intel-gmail-connect/-callback/-token`), worker `gmail.py`, provider switch `KAIRFLOW_MAIL_PROVIDER`, UI, result banners.
- Threading is exact with Gmail: we build the message, set `In-Reply-To`/`References` and learn our own Message-ID without searching Sent.
- Safety kept: refresh token encrypted server-side; only the registered agent can obtain an access token; consent requires BOTH send and read scopes or nothing is saved; sender must equal the connected address; sends are never retried on uncertain outcomes; the token functions of each provider refuse the other provider's connection.
- **Cloudflare:** not a substitute (inbound routing and transactional sending only, no mailbox to read replies from); details in `GMAIL_SETUP.md`.

## What was found wrong and fixed
1. **Migration timestamp collision.** The package's `20261108090000` collided with your newest migration `20261108090000_portal_message_participant_identity`. All five were renumbered to `20261109090000`..`20261109130000` and every reference (tests, docs, runner) was updated. A test now enforces that Intelligence migrations sort after every other migration.
2. **Cross-user data exposure.** `crm_find_lead_duplicates(p_owner, ...)` let an authorized admin, or the agent, pass any user's id and probe that user's leads. It is now limited to the caller's own leads or the data owner of their own Intelligence studio (new migration; tested statically and in `intelligence_v1.test.sql`).
3. **Existing-lead follow-ups did not exist.** Only emails sent *by Intelligence* could be followed up, so the 100+ leads you already have were invisible. See "Existing CRM leads".
4. **No Agent Chat.** Implemented.
5. **Threading headers** never set (item 8).

## Existing CRM leads (your V1 priority)
- **Review (read-only):** Intelligence > Existing Leads sorts every non-archived lead into: Follow-up due, Already replied, Not due yet, Needs a look, Never contacted, No email, Do not contact. Rules: lost / disqualified / closed / no-response / won, suppressed or opted-out addresses, closed prospects and finished 4-email sequences are Do not contact; leads in Responded / Qualified / Proposal / Negotiation, or with an inbound reply on file, are "Already replied" and are never offered for follow-up; a lead with no recorded contact date is "Needs a look" rather than guessed.
- **Bring in (explicit, max 25 at a time):** you tick leads and choose the campaign track. Only "Follow-up due" and "Not due yet" leads are accepted. This creates a tracked prospect and a visible "Imported from CRM history" record anchored on the last contact date. **It sends nothing and does not modify the lead** (it stays manual; the immutable attribution is untouched).
- **Drafts:** follow-ups for these leads are *always* `pending_approval`, even if autonomy is set to autonomous. They pick the first unsent slot of the lead's 4-email sequence, so a follow-up you already sent by hand is not repeated.
- Nothing is contacted blindly: there is no "follow up everyone" action anywhere.

## Agent Chat (personal assistant, propose-then-confirm)
Where: Intelligence > Agent Chat. It is a general assistant (questions, drafting, thinking things through, no tool needed) that can also work the studio's prospecting.
1. You send a message. `intel_admin_chat_send` (admin + active Master User, checked) stores it and queues a `chat` job; the local worker asks Ollama.
2. **Tier 1, immediate (13 tools):** look things up, find and research prospects, review the existing leads, bring chosen leads in, queue follow-up/introduction *drafts*, pause campaigns, emergency stop. Every call goes through one database function that re-checks you are STILL admin AND an active Master User, caps calls per request, and audits.
3. **Tier 2, prepared and confirmed by you (9 tools):** approve or discard messages, start a campaign, set a campaign limit, turn sending on, set autonomy, change limits, add a suppression, approve/reject a prospect. The assistant can only PREPARE these. The database stores the change and writes the summary you read (recipient and subject for approvals) from the stored arguments, not from model text. A card with **Confirm / Cancel** appears in the chat; nothing happens until you press Confirm. Confirming runs as you through the existing `intel_admin_*` functions, so their checks still apply (for example, "turn sending on" still fails without a connected mailbox). Cards expire after 30 minutes, run once, and are re-validated against the current state when you confirm. The worker has no way to confirm: that function is callable only by the signed-in administrator.
4. **Deliberately not possible from chat:** changing user roles, admin status, memberships or any permission (in this or any other module); removing a suppression; registering the agent account; editing the knowledge base or an email's text. Asked for these, the assistant says so and explains where the person does it themselves. Tool results (prospect pages, replies) reach the model only inside `<untrusted>` tags. If Ollama is down, a keyword fallback answers read-only questions and can only pause or emergency-stop; it can propose nothing.
Why roles are excluded: a chat assistant reads text written by strangers (prospect websites, email replies). If it could change roles, one malicious page or reply could try to talk it into granting someone admin. Roles are also outside this module and your rule is that Intelligence must not widen other permissions. The existing admin screens are the right place for them.

## Authorization (unchanged rule, re-verified)
Admin (`user_settings.is_admin`) **and** active `master_user` membership, both, everywhere: navigation, RPCs, RLS (chat tables included), Edge Functions, and chat tool execution. Fails closed when records are missing. Nothing in this pass touches Payments or other modules' permissions.

## Changed files in your existing code (small, targeted)
`src/App.jsx` (route/tab wiring from the earlier patch + AI Generated chip, filter state and predicate), `src/notifications/logic.js` (+test). Everything else is new files. A full diff against your original upload is in `integration.diff`.

## Remaining / needs you
1. Run the SQL tests on a disposable PostgreSQL 16, `npm ci && npm test && npm run build`, and click through the module.
2. Run `docs/verify_live_database.sql` in your Supabase SQL editor (read-only `select`s; changes nothing). Apply `migration_security_hardening.sql` first if the trigger check says MISSING.
3. Decide on Zoho: run the read-only `selftest` when you want to; approve a single test send separately.
4. Not built: Kickstarter/X discovery, automatic studio discovery without seed pages, a Windows run of the service scripts.
