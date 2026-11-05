# KairFlow Resend audit patch

This is a four-file patch for the existing KairFlow repository. It does not send
emails, change autonomy, change the kill switch, change daily limits, or alter
the worker's send/retry behavior.

## What it adds

- A **Verify recent sends** button in Intelligence → Settings.
- A read-only audit of up to 20 recent KairFlow outbound messages marked `sent`.
- Each saved Resend provider ID is checked with `GET /emails/{id}` using the
  exact `RESEND_API_KEY` configured in the `intel-resend-send` Edge Function.
- The send Edge Function writes structured logs containing the KairFlow message
  ID, Resend provider ID, and Resend HTTP status. It never logs the API key or
  recipient address.
- Already-sent messages can now be verified. Previously, the verification RPC
  only allowed `sending` and `unknown` states.

## Apply

1. Extract this ZIP into the **repository root**, preserving folders and allowing
   the four files to overwrite their matching files.
2. Open `supabase/migrations/20261115100000_intelligence_resend_audit.sql`,
   copy its full contents into Supabase SQL Editor, and run it against the
   `kaiflow` production project.
3. From the repository root, deploy the updated Edge Function:

   ```powershell
   node "$env:APPDATA\npm\node_modules\supabase\dist\supabase.js" functions deploy intel-resend-send --project-ref hlplzosdgciavucaebfd
   ```

4. Build and run the repository tests:

   ```powershell
   npm run build
   npm test
   ```

5. Open KairFlow → Intelligence → Settings → **Resend delivery verification**
   and click **Verify recent sends**.

## Interpret the result

- `verified_in_configured_resend_account`: Resend's API, using the key stored in
  this Supabase project, can retrieve that exact provider ID. If the Resend
  dashboard still shows no emails, the dashboard is likely on another workspace
  or has a filter/date range applied.
- `not_found_in_configured_resend_account`: that key cannot retrieve the saved
  ID. Do not resend the message. Check the API key/workspace configuration.
- `missing_provider_id`: KairFlow has a sent record but no Resend provider ID
  was saved, so KairFlow cannot prove Resend acceptance for that record.
- `resend_api_unavailable`: the audit could not obtain a definitive answer.

The audit is read-only. It does not retry, resend, or change message states.
