# Patreon integration setup

## 1. Register the client

Go to https://www.patreon.com/portal/registration/register-clients (signed in
as the Kairil creator account), API Version **2**.

Fill in:
- **App Name**: Kairil
- **Icon URL**: `https://kairil.studiokairegi.com/logo.png`
- **Privacy Policy URL**: `https://kairil.studiokairegi.com/privacy.html`
- **Terms of Service URL**: `https://kairil.studiokairegi.com/terms.html`
- **Redirect URIs**: `https://<your-project-ref>.supabase.co/functions/v1/patreon-callback`

Save it. You'll get a **Client ID** and **Client Secret**.

## 2. Get your Pro Tier ID

Only the tier ID matters for setup now, the campaign ID is discovered
automatically, see step 4. In your Patreon creator dashboard, your Pro
Tier ID is visible in the URL when editing that specific tier
(`/tiers/<tier_id>`).

## 3. Create the webhook

Still in the developer portal, go to the Webhooks page for this client,
create a new webhook:
- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/patreon-webhook`
- **Triggers**: select all `members:*` events (create, update, delete, pledge create/update/delete)

Save it, you'll get a **Webhook Secret**, different from the Client Secret.

## 4. Set Supabase secrets

```
supabase secrets set PATREON_CLIENT_ID=your-client-id
supabase secrets set PATREON_CLIENT_SECRET=your-client-secret
supabase secrets set PATREON_REDIRECT_URI=https://<your-project-ref>.supabase.co/functions/v1/patreon-callback
supabase secrets set PATREON_PRO_TIER_ID=your-pro-tier-id
supabase secrets set PATREON_WEBHOOK_SECRET=your-webhook-secret
```

`PATREON_CAMPAIGN_ID` is optional, you don't need to set it. The first time
you (the creator) connect Patreon from Settings, the app requests an extra
`campaigns` scope, looks up your own campaign automatically, and stores it
in the database. Every connection after that, yours or any patron's, reads
that stored value. If you'd rather set it manually anyway, you still can,
it's used as a fallback if nothing's been discovered yet.

`DRIVE_STATE_SECRET` and `DRIVE_TOKEN_ENCRYPTION_KEY` are reused from the
Google Drive setup, no need to create new ones.

## 5. Deploy the functions

**All three need `--no-verify-jwt`.** None of them are ever called with a
Supabase session token: `patreon-connect` is a plain browser redirect,
`patreon-callback` is hit by Patreon's own redirect, and `patreon-webhook`
is called server-to-server by Patreon with no Supabase auth at all.

```
supabase functions deploy patreon-connect --no-verify-jwt
supabase functions deploy patreon-callback --no-verify-jwt
supabase functions deploy patreon-webhook --no-verify-jwt
```

## 6. Run the migration

`migration_patreon.sql` in Supabase's SQL editor.

## 7. Try it

1. **Connect as yourself first.** In Kairil, open Settings, click **Connect
   Patreon**, log in as the Kairil creator account and authorize. This is
   the step that discovers and stores your campaign ID, check
   `patreon_campaign_config` afterward to confirm a row landed there.
2. If you're subscribed to your own Pro tier, your plan should flip to Pro
   immediately after the redirect back.
3. To test the webhook side without waiting for a real billing event, use
   Patreon's "Send test webhook" button on the webhook's page in the
   developer portal, then check that `patreon_connections.is_pro` and
   `user_settings.plan` updated for the matching account.

## How it stays in sync automatically

Once someone's connected, the webhook keeps their plan current without them
ever reopening the app: upgrade, downgrade, payment decline, or
cancellation all fire an event, Kairil looks up which account that Patreon
member is linked to, and updates their `plan` accordingly. Admin accounts
(`user_settings.is_admin`) are never touched by this, they always keep full
access.
