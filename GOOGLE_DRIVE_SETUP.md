# Google Drive integration setup

This feature needs three things: a Google Cloud OAuth app, some Supabase secrets,
and deploying the Edge Functions. More steps than anything else in KaiFlow so far,
but each one is small.

## 1. Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a new project (or use an existing one).
2. **APIs & Services > Library**, search for "Google Drive API", click **Enable**.
3. **APIs & Services > OAuth consent screen**:
   - User type: External
   - App name: KaiFlow (or Studio Kairegi)
   - Scopes: add `https://www.googleapis.com/auth/drive.file`
   - Add yourself as a test user if the app stays in "Testing" mode (fine for just your own studio use)
4. **APIs & Services > Credentials > Create Credentials > OAuth client ID**:
   - Application type: Web application
   - Authorized redirect URI: `https://<your-project-ref>.supabase.co/functions/v1/google-drive-callback`
   - Save the **Client ID** and **Client Secret** shown after creation

## 2. Supabase secrets

You'll need the Supabase CLI. If you don't have it:
```
npm install -g supabase
```

Log in and link your project:
```
supabase login
supabase link --project-ref <your-project-ref>
```

Set the secrets (replace each value):
```
supabase secrets set GOOGLE_CLIENT_ID=your-client-id
supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
supabase secrets set GOOGLE_REDIRECT_URI=https://<your-project-ref>.supabase.co/functions/v1/google-drive-callback
supabase secrets set APP_URL=https://your-cloudflare-site.pages.dev
supabase secrets set DRIVE_STATE_SECRET=$(openssl rand -hex 32)
supabase secrets set DRIVE_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

`DRIVE_STATE_SECRET` and `DRIVE_TOKEN_ENCRYPTION_KEY` are random keys the functions generate and use internally, the two commands above generate and set them in one step.

## 3. Deploy the Edge Functions

From the project folder (where the `supabase/` folder lives):
```
supabase functions deploy google-drive-connect
supabase functions deploy google-drive-callback
supabase functions deploy google-drive-create-folders
supabase functions deploy freelancer-drive-upload --no-verify-jwt
```

That last flag matters: `freelancer-drive-upload` is called by freelancers who have no login at all, so it has to skip Supabase's usual JWT check. The other three are called by you while signed in, so they keep the default verification.

## 4. Run the database migration

`migration_google_drive.sql` in Supabase's SQL editor, same as always.

## 5. Try it

1. In KaiFlow, open Settings, click **Connect Google Drive**, sign in and grant access.
2. Open any project, click **Create Drive folders**. A "KaiFlow Projects" folder appears in your Drive, with this project's folder inside it (References / Cuts / Deliverables).
3. Open a shot, generate its freelancer link, and try uploading a test file from that link. It should land directly in that project's Deliverables folder.

If a project hasn't had its Drive folders created yet, freelancer uploads for it will automatically fall back to the in-app storage instead of failing, so nothing breaks for projects you haven't set up yet.
