# Kairil

A studio operating system for Studio Kairegi: CRM and lead pipeline, project and
shot tracking, budget planning, invoicing and finance, team/crew management,
client and freelancer portals, Google Drive integration, Patreon-backed Pro
plans, and time tracking.

Built with React + Vite on Supabase (Postgres, Auth, Edge Functions), deployed
as a static site on Cloudflare Pages.

> Each account is its own isolated studio workspace: every record is tagged with
> the signed-in user's ID and filtered by row-level security. This is *not* a
> shared multi-user workspace where several people collaborate inside one
> studio's data - that would be a `workspace_id` schema change.

## Modules

| Module | What it does |
| --- | --- |
| Dashboard | KPIs, needs-attention queue, charts, greeting, Studio Time clock |
| Projects / Shots | Kanban board across the anime production pipeline, per-shot review + revisions |
| Leads (CRM) | Full lifecycle, 5-step follow-up cadence, duplicate detection, activity log, auto-archiving |
| Budget Planner | Department budget splits, crew cost + fit scoring, scope/timeline, templates, convert-to-project |
| Finance | Multi-currency expenses, invoices, milestones, profitability analytics |
| Teams | Crew roster with skills, rates, capacity, availability, dependability |
| Client Portal | Public read-only project view via share link (Pro) |
| Freelancer Portal | Public per-shot brief + Drive upload via share token (Pro) |
| Studio Time | Clock in/out, Pomodoro focus sessions, weekly/monthly summaries, pop-out timer |

## 1. Set up the database

**Migration order matters.** Run `schema.sql` first, then every
`migration_*.sql` file. Most are idempotent (`if not exists` / `or replace`), so
re-running them is safe - but the `migration_audit_fixes_*.sql` files correct
earlier ones and must run **after** the migrations they fix.

Safe order:

1. `schema.sql`
2. All other `migration_*.sql` files (alphabetical is fine)
3. Then, strictly in this order, last:
   - `migration_security_hardening.sql`
   - `migration_audit_fixes_2.sql`
   - `migration_audit_fixes_3.sql`
   - `migration_drive_uploads.sql`
   - `migration_oauth_intents.sql`
   - `migration_audit_fixes_5.sql`
   - `migration_audit_fixes_6.sql`
   - `migration_audit_fixes_7.sql`
   - `migration_audit_fixes_8.sql`
   - `migration_audit_fixes_9.sql`
   - `migration_audit_fixes_10.sql`
   - `migration_audit_fixes_11.sql`
   - `migration_audit_fixes_12.sql`
   - `migration_project_client_billing_rpc.sql` (must come after
     `migration_audit_fixes_8.sql`, which creates the function it replaces)

(There is no `migration_audit_fixes_1.sql` or `_4.sql` - those numbers were
skipped, nothing is missing.)

Then grab **Project Settings > API**: the **Project URL** and **anon public**
key.

### Post-migration manual steps

- **Lead auto-archiving needs pg_cron.** Enable it under **Database >
  Extensions**, then re-run `migration_audit_fixes_2.sql` (it schedules the job
  automatically once pg_cron exists, and prints instructions if it doesn't).
  Verify with `select * from cron.job;`
- **Patreon campaign ID must be set by hand.** Set the `PATREON_CAMPAIGN_ID`
  Edge Function secret (or insert a row into `patreon_campaign_config`) as the
  studio owner. This is deliberately never auto-discovered - see the comment in
  `supabase/functions/patreon-callback/index.ts`.
- **Financial CHECK constraints ship as `NOT VALID`** so they can't fail against
  existing data. Once you've confirmed no bad rows exist (the queries are in
  `migration_audit_fixes_3.sql`), validate them.

## 2. Auth

Email/password works immediately. For Google sign-in: **Authentication >
Providers > Google**, create an OAuth client at console.cloud.google.com, add
Supabase's callback URL as an authorized redirect URI, then set your deployed
URL under **Authentication > URL Configuration**.

## 3. Edge Functions

Deploy everything under `supabase/functions/` with the Supabase CLI:

```
supabase functions deploy <name>
```

Functions: `oauth-start-intent`, `google-drive-connect`,
`google-drive-callback`, `google-drive-create-folders`, `studio-drive-upload`,
`studio-drive-delete`, `freelancer-drive-upload`, `patreon-connect`,
`patreon-callback`, `patreon-webhook`.

Required secrets:

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | all |
| `APP_URL` | OAuth callbacks (where to redirect back to) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Drive |
| `DRIVE_TOKEN_ENCRYPTION_KEY` | Drive (encrypts refresh tokens at rest) |
| `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_REDIRECT_URI` | Patreon |
| `PATREON_CAMPAIGN_ID` | Patreon (see above - set this by hand) |
| `PATREON_PRO_TIER_ID`, `PATREON_WEBHOOK_SECRET` | Patreon |

See `GOOGLE_DRIVE_SETUP.md` and `PATREON_SETUP.md` for the full provider setup.

## 4. Local development

```
npm install
```

Create `.env.local`:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Then `npm run dev`.

> `npm run dev` serves **only** at `http://localhost:5173`. It does not affect
> the deployed site - that updates when you push to the connected GitHub repo.

## 5. Deploy (Cloudflare Pages)

Push to GitHub, then **Workers & Pages > Create > Pages > Connect to Git**.

- **Framework preset:** Vite
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Environment variables:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

The anon key is safe to expose - data access is enforced by row-level security,
not by hiding the key.

## Storage architecture

**Google Drive is the source of truth for production files. Supabase stores
metadata only.** Studio attachments and freelancer deliverables both upload to
the project's Drive folder; Supabase keeps the file name, Drive file ID, and
URL. The legacy public `attachments` bucket is no longer written to.

Uploads are capped at 50MB (Edge Function memory limit). Larger files need
Drive's resumable upload API.

## Free vs Pro

Free: 3 active projects, 3 budget plans. Pro unlocks those plus Teams, Client
Portal, Freelancer links, milestones, multi-currency, planner crew intelligence,
scope/timeline, and templates.

Pro comes from a Patreon subscription (synced via OAuth + webhook) or an admin
override. Limits and Pro gating are enforced by database triggers, not just the
UI - `is_admin` and `plan` on `user_settings` cannot be modified by the client.
