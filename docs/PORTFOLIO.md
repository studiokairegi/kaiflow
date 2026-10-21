# Studio Portfolio (Google Drive edition)

Media lives in a dedicated, private Drive folder ("StudioKairegi Portfolio", created in the studio's own Drive with
the existing `drive.file` scope). Nothing is shared publicly in Drive; every byte is served through `portfolio-media`.

    Owner browser --small (<=20 MB)--> portfolio-drive --> Drive folder
                  --large (reels)----> portfolio-drive (opens a resumable session) ; browser PUTs bytes to Drive
                  --> portfolio-drive `finalize` verifies the file IN Drive (exists, not trashed, in the folder, type, size) -> row saved
    Recipient     /portfolio/{token} -> portfolio-view (token check) -> items + short-lived tickets
                  <img>/<video> -> portfolio-media?t=ticket (ticket + live DB check on EVERY request, Range supported) -> Drive

## Deploy
1. Apply migrations `20261022090000_studio_portfolio.sql` then `20261023090000_portfolio_google_drive.sql`.
2. `supabase functions deploy portfolio-drive` (JWT verification ON)
   `supabase functions deploy portfolio-view --no-verify-jwt`
   `supabase functions deploy portfolio-media --no-verify-jwt`   (**both public functions must use --no-verify-jwt**)
3. Secrets already used elsewhere and required here: `DOWNLOAD_SIGNING_KEY`, `DRIVE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. Host: rewrite `/portfolio/*` (and `/pay/*`) to `index.html`. Rate-limit `portfolio-view` and `portfolio-media`.
5. The studio must have Google Drive connected (Settings). Items uploaded before the move show "Move to Google Drive" in the tab.

## Verify in staging (cannot be tested without live Google/Supabase)
* Upload a >20 MB video: confirms the browser can PUT to the Drive resumable session (needs Google to honour the `Origin` sent at session creation). If it fails the tab shows "network error, or the browser blocked the cross-origin request" and files <=20 MB still work.
* Play a video and seek: confirms Range passthrough (`206`, `Content-Range`).
* Revoke a link while its video is playing: the next range request must fail.
