# Direct-to-Drive uploads: audit fixes (C1-C3, P2-P10)

Baseline: Phase 7 full repo + `PRODUCTION_READINESS_AUDIT_UPLOADS.md`. `npm test`: 1,232 pass, 0 fail (1,208 existing + 24 new in `src/uploadAuditFixes.test.mjs`).
Eight of the new tests EXECUTE `freelancer-drive-upload`, `final-qc-upload` and `drive-upload-cleanup` under Node (`supabase/tests/edgeHarness.mjs` swaps only supabase-js, `crypto.ts` and `final_qc.ts` for fakes). The SQL migration was only text-checked (no Postgres in the build sandbox).

## What changed

| Finding | Fix |
|---|---|
| C1 fingerprint blind spot | Browser streams a full-file MD5 (`src/uploadHash.js`, ~180 MB/s, started when bytes start flowing so it normally adds no wall-clock time). Server compares with Drive's `md5Checksum` before registering: 428 `md5_required`, 503 `checksum_pending` (client retries 1s/3s/6s), 409 `file_mismatch`. MD5 is cached in saved state. Final QC rotates its upload key after a mismatch. |
| C2 stale JWT | `headers` may be an async function, resolved for every request. `uploadFinalFile` passes one. |
| C3 Shared Drives | `supportsAllDrives=true` on every Drive file call in `google.ts`; both file listings also use `corpora=allDrives&includeItemsFromAllDrives=true`. |
| P2 deploy coupling | Old multipart clients get 426 `client_outdated` ("reload"). New client explains a mid-deploy mismatch. Deploy order below. |
| P3 ordering | Freelancer submission is registered before the deliverable is appended; a refused gate leaves no orphan deliverable. |
| P4 share failure | `shareFileWithAnyone` retries 5xx/429 (3 tries); response carries `shared`; freelancer UI warns when `false`. |
| P5 rate limit | `register_upload_session` RPC: max NEW sessions per hour (freelancer 20 per shot, `FREELANCER_UPLOAD_INITS_PER_HOUR`; Final QC 60 per user, `FINAL_QC_UPLOAD_INITS_PER_HOUR`). 429 + `Retry-After`. Fails open if the migration is missing (logged). |
| P6 orphans | New `drive-upload-cleanup` function trashes (never deletes) unreferenced files: abandoned/rejected after 8 days, duplicates of a finalized upload after 1 day. Skips any file the app still references. |
| P7 two tabs | Web Locks per scope + file; second tab gets `upload_in_progress`. |
| P8 silent waits | `onStatus` phases (checking / uploading / verifying % / finalizing) shown in both UIs. |
| P9 insecure context | SHA-256 and UUID fallbacks when `crypto.subtle` / `randomUUID` are missing. |
| P10 repeated work | Google access token cached per isolate; Final QC folder ids cached 5 min (dropped on error). |

## NOT fixable by code: P1 (blocking), plus audit blockers 1-4
Browser PUT / `Range` readability on a 308 / CORS against real Drive, `deno check`, `npm run build` and the live end-to-end run were not possible here. They remain GO/NO-GO gates. Run them in staging (checklist below). If `Range` turns out to be unreadable, the client restarts from byte 0 (safe, but slow for huge files).

## Deploy (one unit, in this order)
1. Migration `20270107100000_upload_sessions.sql` (after `20270106100000_append_shot_deliverable_once.sql`).
2. Secrets: `UPLOAD_CLEANUP_SECRET` (required for cleanup); optional `FREELANCER_UPLOAD_INITS_PER_HOUR`, `FINAL_QC_UPLOAD_INITS_PER_HOUR`.
3. Functions: `freelancer-drive-upload`, `final-qc-upload`, `drive-upload-cleanup` (`--no-verify-jwt` for freelancer and cleanup, already in `config.toml`).
4. Frontend build. Rollback = frontend + functions together (migration is additive; rollback SQL is in its header).
5. Schedule cleanup (SQL editor; replace ref and secret):
```sql
select cron.schedule('drive-upload-cleanup', '17 3 * * *', $$
  select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/drive-upload-cleanup',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<UPLOAD_CLEANUP_SECRET>'), body := '{}'::jsonb) $$);
```

## Staging checklist (blocking)
1. Freelancer link and Final QC: upload a real file from the real portal origin; confirm it completes (CORS PUT works) and `md5Checksum` matches (no `file_mismatch`).
2. Interrupt mid-transfer (DevTools offline), reload, re-select the same file: confirm it resumes. To inspect `Range` readability, copy `uploadUrl` from the `init-upload` response and run in the portal's console:
```js
const x = new XMLHttpRequest(); x.open("PUT", UPLOAD_URL); x.setRequestHeader("Content-Range", "bytes */" + FILE_SIZE);
x.onload = () => console.log(x.status, x.getResponseHeader("Range")); x.onerror = () => console.log("blocked"); x.send();
```
   Expect `308` with `bytes=0-N` mid-transfer; `200/201` after completion.
3. Edit one byte deep inside a copy of the file after a partial upload, re-select: expect the mismatch message and a clean re-upload.
4. If the studio uses a Shared Drive, repeat 1 there.
5. `deno check` on the three functions; `npm run build`.
6. Call the cleanup function once manually with the secret header and read its JSON summary.
