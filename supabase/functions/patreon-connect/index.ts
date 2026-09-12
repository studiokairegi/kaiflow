// GET /patreon-connect?intent=<id from oauth-start-intent>
// Same intent-based flow as google-drive-connect - see
// migration_oauth_intents.sql and _shared/oauth_intent.ts.

import { consumeIntentForRedirect } from "../_shared/oauth_intent.ts";

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const intentId = url.searchParams.get("intent");
    if (!intentId) {
      return new Response("Missing intent", { status: 400 });
    }

    const userId = await consumeIntentForRedirect(intentId, "patreon");
    if (!userId) {
      return new Response(
        "This connect link has expired or was already used. Go back to Settings and try again.",
        { status: 401 }
      );
    }

    const clientId = Deno.env.get("PATREON_CLIENT_ID")!;
    const redirectUri = Deno.env.get("PATREON_REDIRECT_URI")!;

    const patreonUrl = new URL("https://www.patreon.com/oauth2/authorize");
    patreonUrl.searchParams.set("response_type", "code");
    patreonUrl.searchParams.set("client_id", clientId);
    patreonUrl.searchParams.set("redirect_uri", redirectUri);
    patreonUrl.searchParams.set("scope", "identity identity.memberships campaigns");
    patreonUrl.searchParams.set("state", intentId);

    return Response.redirect(patreonUrl.toString(), 302);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
