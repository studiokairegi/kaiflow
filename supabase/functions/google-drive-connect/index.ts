// GET /google-drive-connect?intent=<id from oauth-start-intent>
// Consumes the intent (proving it's a real, recent, not-yet-used connect
// attempt for this provider) and redirects to Google's consent screen,
// using that same intent id as the OAuth `state` - see
// migration_oauth_intents.sql and _shared/oauth_intent.ts for why.

import { consumeIntentForRedirect } from "../_shared/oauth_intent.ts";

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const intentId = url.searchParams.get("intent");
    if (!intentId) {
      return new Response("Missing intent", { status: 400 });
    }

    const userId = await consumeIntentForRedirect(intentId, "google_drive");
    if (!userId) {
      return new Response(
        "This connect link has expired or was already used. Go back to Settings and try again.",
        { status: 401 }
      );
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", clientId);
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");
    googleUrl.searchParams.set("scope", "openid email https://www.googleapis.com/auth/drive.file");
    googleUrl.searchParams.set("state", intentId);

    return Response.redirect(googleUrl.toString(), 302);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
