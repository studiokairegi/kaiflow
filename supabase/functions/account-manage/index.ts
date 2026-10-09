// POST /account-manage
// Headers: Authorization: Bearer <supabase access token>
// Body: { action: "disconnect_drive" | "disconnect_patreon" | "delete_account", confirmEmail?: string }
//
// These actions need the service role (the plan column is deliberately not writable
// by a normal user, and deleting an auth user is an admin API), so they can't run
// from the browser. Identity always comes from the verified token, never the body.
//
//  disconnect_drive    revokes the stored refresh token at Google (best effort), then
//                      deletes the connection row. Files already in Drive are untouched.
//  disconnect_patreon  deletes the connection. If that connection was what made the
//                      account Pro (and the account isn't an admin), the plan returns to
//                      free so disconnecting can't be used to keep Pro for free.
//  delete_account      requires confirmEmail to match the account email. Revokes Drive,
//                      then deletes the auth user; every row owned by the user cascades.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function revokeDriveToken(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data: row } = await supabase.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id", userId).maybeSingle();
  if (!row) return { had: false, revoked: false };
  let revoked = false;
  try {
    const key = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY");
    if (key) {
      const token = await decryptText(row.refresh_token_encrypted, key);
      const res = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
      revoked = res.ok;
    }
  } catch (_e) { /* revocation is best effort; the stored token is deleted regardless */ }
  return { had: true, revoked };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return json({ error: "Missing Authorization header" }, 401);

    const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const { action, confirmEmail } = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (action === "disconnect_drive") {
      const r = await revokeDriveToken(supabase, user.id);
      const { error } = await supabase.from("google_drive_connections").delete().eq("user_id", user.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, ...r });
    }

    if (action === "disconnect_patreon") {
      const { data: conn } = await supabase.from("patreon_connections").select("is_pro").eq("user_id", user.id).maybeSingle();
      const { error } = await supabase.from("patreon_connections").delete().eq("user_id", user.id);
      if (error) return json({ error: error.message }, 500);
      let downgraded = false;
      if (conn?.is_pro) {
        const { data: s } = await supabase.from("user_settings").select("is_admin").eq("user_id", user.id).maybeSingle();
        if (!s?.is_admin) {
          const { error: planError } = await supabase.from("user_settings").update({ plan: "free" }).eq("user_id", user.id);
          if (planError) return json({ error: planError.message }, 500);
          downgraded = true;
        }
      }
      return json({ ok: true, downgraded });
    }

    if (action === "delete_account") {
      if (!confirmEmail || String(confirmEmail).trim().toLowerCase() !== String(user.email || "").toLowerCase()) {
        return json({ error: "The email you typed doesn't match this account." }, 400);
      }
      await revokeDriveToken(supabase, user.id);
      const { error } = await supabase.auth.admin.deleteUser(user.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
