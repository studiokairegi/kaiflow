# Freelancer + Final QC Upload Pipeline Fix

## Scope

Updated both upload paths to transfer file bytes directly from the browser to Google Drive using the existing shared Drive resumable-session helper. The Supabase Edge Functions now handle authorization, session creation, Drive verification, and database registration only; they no longer parse or relay the uploaded file body.

## Changes

### 1. Freelancer uploads

- Removed the 50 MB multipart Edge Function upload path.
- Added `init-upload`, `finalize`, and `recover-upload` JSON actions.
- The share token remains the freelancer's capability credential and is revalidated for every action.
- The function rechecks the shot workflow gate and resolves the same per-shot Deliverables folder with the existing project-level fallback.
- Browser transfers bytes directly to a Google Drive resumable session.
- Drive files are tagged with the private `freelancerUpload` app property and must match that tag, folder, and exact size before registration.
- Existing freelancer behavior is preserved: deliverables remain link-viewable using the existing best-effort Anyone-with-the-link permission behavior.
- Finalization checks for an existing `driveFileId` before appending, so retrying after a lost response does not append the same deliverable twice.
- Existing `register_freelancer_submission` workflow and activity logging are retained.
- The portal retains the upload ID for a same-file retry during the current page session and displays upload progress.

### 2. Final QC uploads

- Removed multipart parsing and the Edge Function's full-file Drive transfer.
- Added `init-upload`, `finalize`, and `recover-upload` actions.
- Existing studio JWT authentication, shot ownership, workflow-state gate, QC approval requirement, Final QC folder layout, and `register_final_version` RPC remain in place.
- Browser transfers bytes directly to a private Google Drive resumable session.
- Drive files are tagged with `finalQcUpload`; finalization verifies the tag, exact folder, file identity, and size before registration.
- Final QC files remain private; upload does not release a file to the client.
- A transient database-registration failure no longer trashes the completed Drive file. The upload can be recovered and finalized again with the same upload key.

### 3. Shared Drive helper and browser client

- Extended `getDriveFileMeta` to retrieve Drive `appProperties` for upload-session ownership checks.
- Added `src/resumableDriveUpload.js` for direct browser PUT, progress events, lost-response recovery, and idempotent finalization retries.
- Updated `src/cutWorkflowApi.js` and `src/SharedViews.jsx` to use the resumable client.

## Files changed

- `supabase/functions/freelancer-drive-upload/index.ts`
- `supabase/functions/final-qc-upload/index.ts`
- `supabase/functions/_shared/google.ts`
- `src/resumableDriveUpload.js` (new)
- `src/resumableDriveUpload.test.mjs` (new)
- `src/cutWorkflowApi.js`
- `src/SharedViews.jsx`

No database migration or schema change is required.

## Verification

- `npm test`: **1,194 passed, 0 failed**.
- Node TypeScript syntax checks passed for both changed Edge Functions and the shared Google helper.
- Node syntax checks passed for the non-JSX browser modules.
- Added regression tests covering direct-to-Drive transfer, recovery without re-uploading, and ensuring neither Edge Function parses or relays multipart file bodies.

### Not verified in this environment

- `npm run build` could not run because this archive does not include `node_modules` and `node_modules/vite/bin/vite.js` is unavailable.
- Deno CLI is not installed here, so `deno check` was not run.
- No live Supabase deployment, Google OAuth/Drive upload, or browser end-to-end upload was performed. The changes are source-level fixes and require deployment before they affect the live application.

## Deployment

Deploy the updated `freelancer-drive-upload` and `final-qc-upload` functions together with the frontend release. Preserve the existing function JWT configuration: `freelancer-drive-upload` remains `verify_jwt = false` because its per-shot share token is the capability credential; `final-qc-upload` continues to require a valid studio JWT and should retain JWT verification.

No new environment variables or secrets are introduced. Existing Google Drive OAuth scopes must continue to allow file creation, metadata reads, and permission updates for freelancer deliverables.


---

## Corrective pass: audit findings fixed

| Finding | Fix |
|---|---|
| BUG 1 recovery missed a completed upload | After an interrupted PUT the client first asks the **Drive session itself** (`Content-Range: bytes */size`), which is authoritative and has no listing lag. Listing recovery is retried with 1s/3s/6s backoff. "Missing" vs "uncertain" is distinguished: if Drive can't be confirmed either way the client throws `upload_uncertain` and **never opens a second session**. |
| BUG 2 duplicate freelancer deliverables | New migration `20270106100000_append_shot_deliverable_once.sql`: one `UPDATE ... WHERE NOT EXISTS (driveFileId)` returning whether it appended. The function no longer does check-then-append; the activity log is written only when the row was actually appended. |
| BUG 3 retry matched a different file | The browser computes a content fingerprint (SHA-256 of size + head + tail + 8 evenly spaced 256 KB samples). It is stored on the Drive file (`appProperties.fp`) and checked on recover/finalize (`file_mismatch`, 409). Pending state is keyed by fingerprint, not name/size/mtime. When several files carry one upload id, the oldest file matching fingerprint + size is chosen deterministically instead of failing as ambiguous. |
| BUG 4 recovery lost on reload | Upload id, fingerprint, Drive session URI and (once complete) Drive file id are persisted in `localStorage` per share token / per shot, expiring after 6 days. After a reload, re-selecting the same file resumes: completed session -> finalize only; partial -> `PUT` of the remaining bytes with `Content-Range`; expired -> listing check, then a new session. Final QC reuses the stored upload key over the one passed in. |

### Deploy notes (changed from the original handoff)
- **A migration is now required**: run `20270106100000_append_shot_deliverable_once.sql` **before** deploying `freelancer-drive-upload`. It assumes `shots.id` is `uuid` and `shots.deliverables` is `jsonb`; adjust the parameter type if your schema differs.
- Deploy frontend and both functions together: `init-upload` now requires a `fingerprint`.
- New shared module: `supabase/functions/_shared/upload_recovery.ts`.
- The Drive session URI is a capability URL kept in the uploader's own browser storage (it only allows continuing that one upload).

### Still unverified here
Live Drive/Supabase execution, `deno check`, a browser end-to-end run, and `npm run build`. In particular, reading the `Range` header on a `308` status reply in the browser depends on Drive's CORS exposure for that session; if it is not readable the client treats offset as 0 and, if that fails, falls back to the listing check rather than opening a duplicate session.
- Only the new tests were run (13 pass); the full 1,194-test suite requires the original repository.

## Audit pass (freelancer + Final QC)
- Freelancer `init-upload` now enforces a size cap (default 10 GiB; override with the `FREELANCER_UPLOAD_MAX_BYTES` secret). The old 50 MB cap disappeared with the multipart path, leaving the share link able to reserve unlimited Drive space.
- Browser-supplied MIME types are validated before becoming the `X-Upload-Content-Type` header (both functions).
- Final QC: a used upload key can no longer be re-initialised (`upload_key_used`, 409); after a validation rejection the panel rotates to a new key, since the server permanently binds a rejected file to its key.
- Freelancer finalize returns 409 `not_accepting` (instead of a misleading 500 "retry") if the cut stops accepting submissions between upload and registration.
- Verified against `schema.sql` / `migration_drive_uploads.sql`: `shots.id` is `uuid`, `shots.deliverables` is `jsonb not null`; the new RPC matches `append_shot_file`'s grants.
- Known/accepted: the deliverable is appended before `register_freelancer_submission` (original order), so a gate change between the two leaves a deliverable without a submission; there is no per-token rate limit on `init-upload`.

## Re-audit pass
- A Drive session that definitively rejects the upload (4xx/expired) is now forgotten, so the retry opens a fresh session instead of looping on the dead one (user cancel keeps the session).
- The content fingerprint now also covers file name and last-modified time, so two different exports can never be conflated (stricter only).
- Known limit: `crypto.subtle` needs a secure context (https/localhost); the portal is https.
