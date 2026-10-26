// POST /studio-invite-accept   (public: deploy with --no-verify-jwt)
// Body: { token: string (64 hex), email: string, password: string }
//
// The invite link is the credential. The invitee only types an email and a password:
// this function validates the one-time token, creates a confirmed auth user (no
// confirmation email), links it to the invited Teams roster entry through the
// service-role-only RPC, and returns ok. The browser then signs in normally.
//
//  200 { ok: true, organization_name }
//  400 invalid input | 409 account_exists (sign in and open the link again) | 410 invite expired/used

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.token || "").trim().toLowerCase();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!TOKEN_RE.test(token)) return json({ error: "invalid_invite_token" }, 400);
    if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "invalid_email" }, 400);
    if (password.length < 8 || password.length > 128) return json({ error: "weak_password" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: rows, error: lookupError } = await admin.rpc("studio_get_team_invite", { p_token: token });
    const invite = Array.isArray(rows) ? rows[0] : rows;
    if (lookupError || !invite) return json({ error: "invite_not_found_or_expired" }, 410);

    // Created already confirmed, so the invitee can sign in immediately. The invite token in
    // user metadata makes the signup trigger skip provisioning a separate studio.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: invite.display_name, studio_invite_token: token },
    });
    if (createError || !created?.user) {
      const message = String(createError?.message || "");
      const code = String((createError as { code?: string } | null)?.code || "");
      if (code === "email_exists" || /already (been )?registered|already exists/i.test(message)) {
        return json({ error: "account_exists" }, 409);
      }
      if (/password/i.test(message)) return json({ error: "weak_password" }, 400);
      return json({ error: "could_not_create_account" }, 500);
    }

    const { data: result, error: redeemError } = await admin.rpc("studio_redeem_team_invite", {
      p_token: token,
      p_user_id: created.user.id,
    });
    if (redeemError) {
      // Do not leave an orphan login with no studio behind if the invite was just used or revoked.
      await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
      const used = /invite_not_found_or_expired|team_member_already_linked/i.test(redeemError.message || "");
      return json({ error: used ? "invite_not_found_or_expired" : "could_not_join_studio" }, used ? 410 : 500);
    }
    return json({ ok: true, organization_name: result?.organization_name || invite.studio_name || null });
  } catch (_error) {
    return json({ error: "unexpected_error" }, 500);
  }
});
