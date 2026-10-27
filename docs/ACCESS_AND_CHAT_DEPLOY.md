# Access control, private directory, guest/client chat — deployment

Nothing here deploys itself. Run the steps below yourself, in order, from the project root.

## 1. Back up, then apply the two new migrations (in this order)

```cmd
supabase db push --dry-run
supabase db push
```

`db push` applies only migrations that are not yet recorded as applied. Already-applied
`20261031090000`, `20261031100000` and `20261101090000` are untouched. The new ones are:

1. `20261102090000_access_overrides_directory_privacy.sql` — per-member overrides, private directory, Master-only group creation.
2. `20261102100000_portal_guest_client_chat.sql` — portal tables, private `portal-attachments` bucket, staff and gateway functions.

Both are idempotent (tested by applying twice). If `db push` complains about history, use
`supabase migration list` first; do not edit applied migrations.

## 2. Deploy the new Edge Function

```cmd
supabase functions deploy portal-chat --no-verify-jwt
```

`--no-verify-jwt` is required: guests and clients have no Supabase login. The function authenticates
every call itself (hashed guest session, project share token, or a staff Bearer token re-checked in SQL).
Optional hardening secret (rotating it invalidates nothing stored, it only salts IP hashes):

```cmd
supabase secrets set PORTAL_HASH_PEPPER=<long-random-string>
```

Do not redeploy or change `studio-invite-accept`.

## 3. Deploy the front end

Build and deploy as you normally do (`npm run build`, then your host). New public route:
`/?guest-chat=1#t=<token>` (works on any host that already serves `index.html` at `/`).

## 4. Smoke test (about 10 minutes)

1. As Master: Teams → a member with a login → **Permissions** → confirm sources shown; turn **Create group chats** on, check it appears for them; turn it off.
2. As a Sales member: no Projects tab unless assigned to a project; People tab shows only people they already chat with.
3. As Master: Chat → Clients → open a client thread, add an internal note, create a freelancer guest link; open it in a private window, join, send a file; confirm the note is not visible there; revoke and confirm the guest is cut off within one poll.
4. Open a project's client portal link: the "Message the studio" box works; staff reply is visible.

## Rollback

The migrations are additive. To disable the features without dropping data: undeploy the function
(`supabase functions delete portal-chat`) and revoke guests from the Clients inbox.
