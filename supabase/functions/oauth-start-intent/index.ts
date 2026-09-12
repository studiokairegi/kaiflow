// POST /oauth-start-intent
// Headers: Authorization: Bearer <supabase access token>
// Body: { provider: "google_drive" | "patreon" }
//
// First step of connecting Google Drive or Patreon. The browser has to
// navigate to google-drive-connect/patreon-connect as a full-page redirect
// (they in turn redirect to the provider's consent screen), and a plain
// navigation can't carry an Authorization header - that's what previously
// forced the studio's real access token into the URL as ?token=. This
// function takes that header the normal way, over an authenticated fetch,
// and hands back a short-lived, single-use, opaque intent id instead. Only
// that id ever appears in the URL from here on.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { provider } = await req.json();
    if (provider !== "google_drive" && provider !== "patreon") {
      return new Response(JSON.stringify({ error: "Invalid provider" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: intent, error } = await supabase
      .from("oauth_connect_intents")
      .insert({ user_id: user.id, provider })
      .select("id")
      .single();
    if (error || !intent) {
      return new Response(JSON.stringify({ error: "Couldn't start connection, please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ intentId: intent.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
