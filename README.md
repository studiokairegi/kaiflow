# Shot Tracker

A commission pipeline board for Studio Kairegi. Multi-user, with email/password and Google sign-in via Supabase, deployable as a static site on Cloudflare Pages.

## 1. Set up Supabase

1. Go to supabase.com and create a free account, then create a new project.
2. Pick a database password and save it somewhere safe. You won't need it day to day.
3. Once the project finishes provisioning, go to **SQL Editor > New query**, paste the contents of `schema.sql` from this folder, and run it. This creates the `projects` and `shots` tables with row-level security, so each user only ever sees their own data.
4. Go to **Project Settings > API**. You'll need two values from this page:
   - **Project URL**
   - **anon public** key

## 2. Turn on Google sign-in (optional)

1. In Supabase, go to **Authentication > Providers > Google** and toggle it on.
2. You'll need a Google OAuth Client ID and Secret. Create one at console.cloud.google.com under **APIs & Services > Credentials > Create Credentials > OAuth client ID**, application type "Web application".
3. Add this as an **Authorized redirect URI** in the Google console (Supabase shows you the exact URL to copy on the same provider settings page, it looks like `https://<your-project>.supabase.co/auth/v1/callback`).
4. Paste the Client ID and Secret back into Supabase's Google provider settings and save.
5. Also go to **Authentication > URL Configuration** in Supabase and set your Cloudflare Pages URL (from step 4 below) as a **Redirect URL**, so Google sends people back to the right place after signing in.

Email/password sign-in works immediately with no extra setup, Supabase handles verification emails automatically.

## 3. Local development

```
npm install
```

Create a `.env.local` file in the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Then:

```
npm run dev
```

Try creating an account, adding a project, adding a shot, and dragging it between stages before deploying anywhere.

## 4. Deploy to Cloudflare Pages

1. Push this folder to a GitHub repository.
2. In the Cloudflare dashboard, go to **Workers & Pages > Create > Pages > Connect to Git**, and select the repo.
3. Build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Under **Settings > Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon public key
5. Deploy. Cloudflare gives you a `*.pages.dev` URL immediately, and you can attach `studiokairegi.com` or a subdomain like `shots.studiokairegi.com` afterward under **Custom domains**.

The anon key is safe to expose in the frontend, that's how Supabase is designed to work. Actual data access is enforced by the row-level security policies in `schema.sql`, not by hiding the key.

## Notes

- Every project and shot is tagged with the signed-in user's ID and filtered automatically by Supabase's row-level security, so two people using the same deployed app never see each other's data.
- The export/import buttons in the header still work, they read from and write to Supabase.
- If you ever want a shared team workspace instead of per-user isolation, that's a schema change (a `workspace_id` column instead of relying purely on `user_id`), just flag it and we can adjust.
