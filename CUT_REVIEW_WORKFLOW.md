# Cut review → Final QC → client delivery

## Lifecycle
1. **Freelancer submits** (portal upload) → `cut_submissions` row, cut becomes **Pending Review**.
2. **Internal QC** (Review & delivery section of the cut editor, or click the Pending Review badge on the board):
   approve → *QC Adjustments & Final Upload*; or request corrections (notes required) → back to *In Progress*, notes shown in the freelancer portal.
3. **Final upload** goes to `<Project>/Final QC/<Cut>/` (private; never "anyone with the link"). Validated against Drive. Upload ≠ release.
4. **Release to client** is a separate confirmed action. Only then can the client download that exact version.
5. **Client** (project share link) downloads, comments (optional `mm:ss` timestamp), requests revisions (notes required) or approves — all against the exact released version.
6. **Studio routes a revision request**: back to the freelancer (with notes you choose to share) or handled internally. Never automatic.

## State fields
- `shots.workflow_state` (internal, server-controlled): `in_progress | pending_review | qc_adjustments | ready_for_client | released`
- `shots.review_status` (existing, client-facing): `in_progress | waiting | revisions | approved`; server-controlled once a cut has been released.
- Download gating comes ONLY from `cut_final_versions.delivery_state = 'released'`.

## Deploy
1. Apply `supabase/migrations/20261012090000_cut_review_final_delivery.sql` (after all existing migrations). Optionally run `cut_review_tests.sql` first on a non-production project.
2. Set secret `DOWNLOAD_SIGNING_KEY` (long random string).
3. `supabase functions deploy final-qc-upload`
   `supabase functions deploy client-final-download --no-verify-jwt`
   `supabase functions deploy freelancer-drive-upload`
4. Deploy the front end.

The freelancer function and client portal degrade to previous behaviour if the migration isn't applied yet.

## Known limitations
- Clients have no accounts in Kairil: access = the project share token (existing model). Comment/approval authorship is the name the client types, not a verified identity.
- Downloads are proxied through an Edge Function (50 MB limit, same as uploads). The "download started" event cannot prove completion.
- No client email/push notification channel exists in the app; the studio is notified via the existing realtime/browser-notification path (new "Client feedback on cuts" category).
- Timestamped comments are typed `mm:ss`; there is no in-portal video player.
- Existing cuts start as `in_progress`; their pre-existing `deliverables` are not back-filled as submissions.
- Pre-existing behaviour kept: freelancer and studio attachment files are still shared as "anyone with the link" in Drive.
