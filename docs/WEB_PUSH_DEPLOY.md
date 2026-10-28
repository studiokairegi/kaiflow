# Alerts when the browser is closed (Web Push) — deployment

What it covers: chat messages, client/freelancer portal messages (both directions), freelancer uploads,
client cut-review activity, focus-timer breaks, and a next-morning CRM digest. Open tabs keep using the
in-app tones; closed-browser alerts use the **device's own notification sound** (a web page cannot play
custom audio when it is not running).

## 1. Apply the migration (after the three access/chat migrations)

    supabase db push        # applies 20261103090000_web_push.sql

It is safe to run twice. It adds `push_subscriptions`, `push_jobs`, `push_config` (all locked to the
service role) and triggers on `chat_messages`, `portal_messages` and `activity_log`.

## 2. Create VAPID keys and set secrets

    npx web-push generate-vapid-keys
    supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:you@yourstudio.com

## 3. Deploy the function (no JWT check: portal visitors have no login; every action authenticates itself)

    supabase functions deploy push --no-verify-jwt

## 4. Let the database wake the sender

Enable the `pg_net` and `pg_cron` extensions (Dashboard → Database → Extensions), then run once, with your
own project URL and a random secret of at least 24 characters:

    select public.push_configure(
      'https://<project-ref>.supabase.co/functions/v1/push',
      '<long-random-secret>');
    select cron.schedule('push-dispatch', '* * * * *', $$select public.push_kick_dispatch()$$);

`push_kick_dispatch()` is also called after every queued alert, so chat alerts go out within a second or
two; the one-minute cron tick delivers timed alerts (focus timer, morning digest) and retries failures.
Without these two extensions nothing is sent.

## 5. Deploy the front end

The build now ships `public/sw.js`. Your host must serve it from the site root over HTTPS with
`Cache-Control: no-cache` (the included `public/_headers` does this on Netlify/Cloudflare Pages; add the
equivalent on other hosts).

## 6. Smoke test

1. Settings → Alerts & display → **Turn on alerts on this device** → allow → **Send a test alert**, close the tab: the alert arrives.
2. Message yourself from another account with the tab closed.
3. Open a client portal link, click **Turn on alerts**, close it, reply from the studio chat: the visitor is alerted.
4. Start a focus timer, close the tab: the break alert arrives at the end of the round (within about a minute).

## Limits you should know

- **Desktop browsers must be running** (Chrome and Edge usually keep running in the background after the last window closes; macOS Chrome does not). Phones and tablets deliver alerts with the browser app closed.
- **iPhone/iPad:** KairFlow must be added to the Home Screen first (iOS 16.4+).
- One browser holds one push subscription per site: a person who is both staff and a portal visitor in the same browser is subscribed as whichever they enabled last.
- The morning digest is built from what the app knew at your last visit; it is not recalculated on the server.
- A running focus timer alerts at the end of the current phase only; the next phase starts when the app is opened.
- While a KairFlow tab is focused, the system notification is skipped and the page shows the alert itself (with your chosen tone).

## Rollback

    select cron.unschedule('push-dispatch');
    drop trigger if exists push_chat_message on public.chat_messages;
    drop trigger if exists push_portal_message on public.portal_messages;
    drop trigger if exists push_activity on public.activity_log;

The app keeps working without push; the tables can stay.
