# Teams & one-time invites (refined multi-user)

**Model.** The first account is the master user. People are added in **Teams** only; an employee
never needs an account to be assigned to shots. Each roster card has an access control:

| Roster card shows | Meaning |
| --- | --- |
| *Freelancer portal* ▾ + **Copy invite link** | No login yet. Pick where they work, copy a one-time link. |
| *Invite pending* · **New link** · **Revoke** | Link created, not used yet (single use, 7 days). |
| *Has login* + department ▾ + **Pause** | Move them between the freelancer portal and a department any time. |

No department = the current freelancer experience (only assigned projects/shots). A department =
a dedicated view: a home screen for that login, only the modules the department is switched on
for (Teams → **Departments**), their own settings, and the floating chat.

**Invite flow.** The invitee opens the link, types an email and a password, and is in. No email
confirmation, no roster email needed. If that email already has an account they are asked to sign
in instead, and the invite is added to that account.

## Deploy (in order)
1. Run `supabase/migrations/20261101090000_frictionless_team_invites.sql` (SQL editor or `supabase db push`).
2. `supabase functions deploy studio-invite-accept --no-verify-jwt`
   (needs the default `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` secrets).
3. Deploy the front end.

## Security notes
The link is the credential: 256-bit random token, only its SHA-256 is stored, single use, 7-day expiry,
revocable. Anyone holding an unused link can claim that roster seat with any email, so send it privately.
Raw tokens never leave the browser that created them; a lost link is replaced with **New link**.
