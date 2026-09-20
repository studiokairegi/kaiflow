// GET /google-drive-connect?token=<supabase access token>
// Verifies the studio user's identity, then redirects them to Google's
// consent screen. The user's id is embedded in a signed `state` value so
// the callback function can trust it without needing a session.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { consumeIntentForRedirect } from "../_shared/oauth_intent.ts";

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const intentId = url.searchParams.get("intent") || "";
    if (!intentId) {
      return new Response("Missing intent", { status: 400 });
    }

    const userId = await consumeIntentForRedirect(intentId, "google_drive");
    if (!userId) {
      return new Response("This connection attempt has expired or was already completed. Go back to Settings and try again.", { status: 401 });
    }

    const state = intentId;

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", clientId);
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");
    googleUrl.searchParams.set("scope", "openid email https://www.googleapis.com/auth/drive.file");
    googleUrl.searchParams.set("state", state);

    return Response.redirect(googleUrl.toString(), 302);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
