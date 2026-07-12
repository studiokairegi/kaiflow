// GET /google-drive-connect?token=<supabase access token>
// Verifies the studio user's identity, then redirects them to Google's
// consent screen. The user's id is embedded in a signed `state` value so
// the callback function can trust it without needing a session.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response("Missing token", { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return new Response("Invalid session", { status: 401 });
    }

    const secret = Deno.env.get("DRIVE_STATE_SECRET")!;
    const signature = await sign(user.id, secret);
    const state = `${user.id}.${signature}`;

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", clientId);
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");
    googleUrl.searchParams.set("scope", "https://www.googleapis.com/auth/drive.file");
    googleUrl.searchParams.set("state", state);

    return Response.redirect(googleUrl.toString(), 302);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
