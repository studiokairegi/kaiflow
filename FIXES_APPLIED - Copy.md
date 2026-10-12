# Fixes applied (Project module)

Cross-checked against all three uploaded audit passes. Everything below was
verified against the actual code in `files (31).zip` / `kairil-merged-v12.zip`,
not just the audit text, and the modified `App.jsx` was syntax-checked with
esbuild after every change.

## `src/App.jsx`

1. **Project creation is now atomic.** `handleSaveProject` calls the
   already-existing-but-unused `create_project_with_shots` RPC instead of
   doing `projects.insert()` followed by a separate `shots.insert()`. A
   failed shots write can no longer leave a project with zero shots behind.

2. **Save no longer discards unsaved changes on failure.** `handleSaveProject`,
   `handleSaveCard`, and `handleSaveInvoice` now only call their
   `setEditing…(null)` on the success path. Previously it ran unconditionally
   after the try/catch, so a failed save silently closed the editor and lost
   the form.

3. **Delete no longer closes the editor on failure either**
   (`handleDeleteCard`, `handleDeleteInvoice`, and `handleDeleteProject`, all
   fixed the same way).

4. **Project deletion now cleans up local state fully.** Previously only
   `projects` and `cards` were filtered out of React state; `invoices`,
   `activity`, `expenses`, and `leads` were left stale in memory until a
   reload, even though the database already cascades/nulls them correctly.
   All five are now updated in the same `setData` call.

5. **Project deletion now trashes its Drive folder.** Calls the new
   `studio-drive-delete-project` edge function before deleting the DB row.
   This is intentionally best-effort/non-blocking — if Drive cleanup fails
   (not connected, expired token, API hiccup) the project delete still
   proceeds.

6. **Project deletion now requires confirmation**, naming the shot count,
   invoice count, and whether a Drive folder will be trashed.

7. **Milestone invoice creation is now atomic.** `handleCreateMilestones`
   calls the already-existing-but-unused `create_milestone_invoices` RPC
   (single multi-row insert) instead of three sequential
   `handleSaveInvoice()` calls that could partially fail.

8. **Shot stage moves now roll back on DB failure.** `moveCardStage` did an
   optimistic UI update but never reverted it if the database write failed,
   so the UI could show a stage the database never actually saved until the
   next reload. It now restores the pre-move card snapshot on error.

9. **Attachment deletion now actually deletes the Drive file.**
   `removeAttachment` (in `CardEditor`) previously called `remove_shot_file`
   directly, which only strips the metadata entry — the Drive file was never
   touched. It now calls the `studio-drive-delete` edge function (which
   already existed for exactly this purpose but was never wired up), which
   trashes the Drive file and removes the metadata server-side.

10. **Drive folder creation has a client-side idempotency guard** — skips
    the request if a folder already exists or one is already in flight. (The
    real fix is server-side — see below.)

## Backend (edge functions / SQL)

11. **New edge function: `studio-drive-delete-project`.** Verifies project
    ownership, then trashes the project's Drive folder (which, since Drive
    trash is recursive, takes References/Cuts/Deliverables with it). Only
    trashes the folder — the caller still deletes the project row itself.

12. **`google-drive-create-folders` is now idempotent server-side.** It now
    re-checks the project's `drive_folder_id` immediately before doing any
    Drive work and returns the existing folders instead of creating a
    duplicate set if one is already there. This closes most of the race
    where two tabs/requests both see "no folder" and each create one — it
    isn't a full transactional lock, but it narrows the window from "every
    request" to "two requests within the same few hundred milliseconds."

13. **New migration `migration_audit_fixes_11.sql`.** Adds `CHECK`
    constraints on `shots.stage`, `shots.priority`, `shots.review_status`,
    `projects.priority`, `projects.budget_mode`, `projects.currency`,
    `invoices.status`, `invoices.currency`, and `expenses.currency` — all
    previously enforced only by the React UI, so any direct Supabase
    call could have written an arbitrary string into any of them. Added
    `NOT VALID` + `VALIDATE CONSTRAINT` so this surfaces any pre-existing
    bad data as an explicit validation error rather than failing the whole
    migration silently.

## Deliberately deferred (still real issues, lower priority / bigger changes)

One item remains genuinely out of scope — everything else originally listed
here has now been addressed (see the second pass below).

- **Project client as free text → CRM `client_id` reference** (audit 1,
  finding #39 / audit 3, finding #13): this is a feature, not a bug fix — it
  needs a client-picker UI (search/select from existing leads vs. type a new
  name), a decision on what happens to shots that already snapshot a client
  name independently of their project, and a migration to backfill existing
  free-text values against CRM records that may not match cleanly (typos,
  since-renamed clients, clients that only ever existed as project text and
  were never a lead). Implementing this without those product decisions
  would mean guessing at matches between free text and CRM rows, which is
  worse than leaving the text field as-is.

All changes were verified to compile (esbuild, no errors) before packaging.

## Second pass — the remaining deferred items, now resolved

Revisited each of the previously-deferred items and made a concrete call on
every one rather than leaving them open:

1. **Multi-currency budget math (fixed).** `projectBudgetSummary` now
   converts each invoice's `amountPaid` into the project's own currency
   before summing, via a new `convertAmount()` helper built on the same
   live-FX-rate infrastructure (`fxRates`, `convertToUSD`) the Finance panel
   already uses. This uses **current** FX rates, not the rate at invoice
   issue/payment time — Kairil doesn't currently capture a per-invoice FX
   rate anywhere, so "historical rate" isn't a smaller fix, it's a new
   feature (a column + capturing the rate at save time + a decision on what
   to do with invoices saved before that column existed). Current-rate
   conversion is a strict improvement over the previous behavior (adding
   raw numbers across currencies, which was simply wrong) and matches how
   the rest of the app already treats cross-currency totals.

2. **Project deadline (fixed, no migration).** Changed the deadline field
   from free text to a native `<input type="date">`. The database column
   stays `text` — no migration of existing rows. New values are always
   written as ISO `YYYY-MM-DD`. An old free-text value that isn't
   ISO-formatted shows the date picker as blank (browsers can't parse
   "Aug 15" into a date input) rather than erroring, and a hint line under
   the field shows the raw stored value so it doesn't look like data went
   missing — the old value is still there until the user picks a new date.

3. **Attachment array race (fixed).** `cardToRow` no longer includes
   `attachments` in the payload for ordinary shot saves. Attachments are
   now mutated exclusively through their dedicated atomic paths (upload,
   and the `studio-drive-delete`-backed removal fixed in the first pass) —
   the same way `deliverables` already worked, which is what made the
   inconsistency visible in the first place. Omitting the key means
   Supabase's UPDATE simply doesn't touch that column, so a normal shot
   save (renaming it, changing its stage, editing notes) can no longer
   clobber an attachment uploaded or removed concurrently in another tab.

4. **Free-plan project/budget-planner limit race (fixed).** Added
   `pg_advisory_xact_lock`, keyed per-user, to `enforce_project_limit()`,
   `enforce_project_unarchive_limit()`, and `enforce_budget_planner_limit()`
   in the new `migration_audit_fixes_12.sql`. Two concurrent requests for
   the same user now serialize at the count-then-insert check instead of
   both reading the same stale count and both proceeding.

5. **Pro-only project currency (fixed).** New trigger
   `enforce_project_currency_plan` in the same migration: a free-plan
   user's `projects.currency` is now rejected server-side if it doesn't
   match their studio default (`user_settings.currency_symbol`), reusing
   the existing `user_has_pro_access()` helper — the same server-side
   pattern `migration_security_hardening.sql` already used for `is_admin`/
   `plan` and the project-count limit, just extended to this field.

6. **Stage-move resetting review history — investigated, not a bug.**
   Looked more closely at how `revisions`/`revisionVersion` are actually
   used: they're not an audit trail, they're the *current* review cycle's
   notes and a version counter that also drives the delivered-filename
   convention (`shotFileName` → `..._v02`, etc.), scoped to whichever
   production stage the shot is currently in. Resetting both when a shot
   changes stage is the correct behavior for that model — a fresh stage
   should start a fresh review/version cycle. Left unchanged.

All of the above (App.jsx changes and both new/edited SQL migrations) were
re-verified with esbuild after this pass — no syntax errors.

## Still genuinely out of scope

Beyond the CRM `client_id` item above, two things from the original audits
remain untouched, on purpose:

- **Currency stored as symbol vs. ISO code** (`$`/`¥`/`€`/`£`/`KSh` instead
  of `USD`/`JPY`/`EUR`/`GBP`/`KES`): the app already has a symbol→code
  lookup (`CURRENCY_CODE_BY_SYMBOL`) it uses internally for FX conversion,
  which is what made fix #1 above possible without a schema change. Actually
  renaming the stored values is a data migration with no real behavior
  change to justify the risk, so it's left as-is.
- **`App.jsx` module size / architecture split** (flagged by all three
  audits): a large refactor with no bug behind it — out of scope for a
  fix pass regardless of effort available.

## Session merge (branch reconciliation)

This codebase had diverged into two branches after this point:

- **Settings-as-full-page branch** (this file): the audit fixes above,
  `create_project_with_shots`/`create_milestone_invoices` atomic RPCs,
  studio-drive-delete-project cleanup on project delete, and the
  settings-page-instead-of-modal navigation refactor.
- **Billing/document-types branch**: Proforma → Receipt → Invoice document
  chaining, per-invoice line items, and studio/client billing details
  (legal name, address, tax ID, VAT status, eTIMS number) on invoice PDFs.

Both branches' work has been merged into this file. Where the branches
touched the same code differently (`projectBudgetSummary` doing FX
conversion on one side and excluding superseded documents on the other;
`cardToRow` deliberately omitting the `attachments` key to avoid a
concurrent-write clobber on one side, and re-adding it on the other), the
fix from the settings-as-full-page branch was kept and the document-types
feature was layered on top of it, not the other way around. A new
migration (`migration_project_client_billing_rpc.sql`) extends
`create_project_with_shots` with the two new client billing columns, since
new projects are created through that RPC and it predated
`migration_billing_details.sql`.

Bracket-balance verified by raw character-count comparison (parens, braces,
brackets each match exactly, and the merged counts equal the sum of what
each branch changed) rather than a full parser, since no offline JS/JSX
parser was available in this environment. Please run a real build
(`npm install && npm run dev`) before deploying to be sure.

## Post-merge regressions (found and fixed)

Keeping `cardToRow`'s "never write attachments" design (above) safe
depends on a second piece that turns out **not** to have survived the
branch merge: uploads have to be impossible before a shot is saved, or
there's nothing for the atomic RPC path to attach the file to. That
second piece was missing here, plus a separate, unrelated bug in the
shared Drive upload helper. Both are fixed now:

14. **Attachments on a brand-new, unsaved shot were silently lost.**
    `handleFileSelected`'s guard checked `form.projectId`, which is set
    the moment the shot editor opens and so never actually blocked
    anything. A file attached before the first Save uploaded to Drive
    fine, but with no shot row yet to record it against, and then
    `cardToRow` (correctly, per #3 above) left `attachments` out of the
    insert — so the upload vanished the moment Save was clicked, with no
    error shown. Fixed by checking `form.id` instead (only true once the
    shot has a database row) and, matching the existing Freelancer-link
    section in the same editor, hiding the upload control behind a "save
    this shot first" hint for new shots instead of letting people hit
    that dead end. Anything already lost this way is still sitting
    unlinked in the project's Drive References folder — it wasn't
    deleted, just never recorded against the shot.

15. **Studio attachments and freelancer deliverables were never made
    link-shareable.** `uploadFileToDrive` (`_shared/google.ts`) creates
    every file in the studio's own Drive account. New Drive files are
    private to the owner by default, and nothing ever called Drive's
    permissions API afterward — so every attachment/deliverable link
    opened to Google's "you need access" screen for anyone who wasn't
    signed into that exact account, including the freelancer viewing
    their own upload. Fixed with a `shareFileWithAnyone()` step
    (`role: reader, type: anyone`) called right after every upload inside
    `uploadFileToDrive` itself, so both the studio and freelancer paths
    get it automatically with no per-function changes. It's best-effort
    (logs and continues rather than failing the upload) since the file
    is already safely in Drive either way. Files uploaded *before* this
    fix are still private and need a manual re-share (or a one-off
    backfill script, on request) — this doesn't retroactively fix those.

Both changes verified with the same TypeScript-parser syntax check used
throughout this file (no errors) — still not a substitute for an actual
`npm run dev` / `supabase functions deploy` + a real click-through.
