// GET /google-drive-callback?code=...&state=<intent id>
// Exchanges the authorization code for tokens, consumes the intent to
// recover which studio user is connecting (see migration_oauth_intents.sql
// and _shared/oauth_intent.ts - this is what makes state genuinely
// one-time instead of a signature that stays valid forever), encrypts the
// refresh token, and stores it. Then redirects back into the app.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText } from "../_shared/crypto.ts";
import { consumeIntentForCallback } from "../_shared/oauth_intent.ts";

Deno.serve(async (req) => {
  const appUrl = Deno.env.get("APP_URL") || "/";
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";

    if (!code || !state) {
      return new Response("Missing code or state", { status: 400 });
    }

    const userId = await consumeIntentForCallback(state, "google_drive");
    if (!userId) {
      return new Response(
        "This connection attempt has expired or was already completed. Go back to Settings and try again.",
        { status: 401 }
      );
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return new Response(`Token exchange failed: ${body}`, { status: 500 });
    }

    const tokenJson = await tokenRes.json();
    const refreshToken = tokenJson.refresh_token;
    if (!refreshToken) {
      // Google only returns a refresh_token on the first consent for an
      // account. If the studio already connected before and revoked
      // consent was never given, this can happen, send them back with a
      // note rather than silently failing.
      return Response.redirect(`${appUrl}?drive=needs_reconsent`, 302);
    }

    let email = "";
    try {
      const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        email = info.email || "";
      } else {
        console.error("userinfo request failed:", infoRes.status, await infoRes.text());
      }
    } catch (e) {
      // non-fatal, connection still works without the display email
      console.error("userinfo request threw:", e.message);
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
    const encrypted = await encryptText(refreshToken, encryptionKey);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { error } = await supabase.from("google_drive_connections").upsert({
      user_id: userId,
      refresh_token_encrypted: encrypted,
      connected_email: email,
    });

    if (error) {
      return new Response(`Failed to save connection: ${error.message}`, { status: 500 });
    }

    return Response.redirect(`${appUrl}?drive=connected`, 302);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
