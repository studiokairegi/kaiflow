// POST /patreon-webhook
// Patreon calls this whenever a patron's membership changes (new pledge,
// upgrade/downgrade, decline, cancellation). This is what keeps someone's
// plan in sync automatically without them ever reopening the app.
//
// Deploy with --no-verify-jwt: Patreon calls this with no Supabase auth
// header at all, authenticity is instead proven by the signature below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// Web Crypto (crypto.subtle) doesn't support MD5, Patreon's webhook
// signature scheme requires it, so this one piece uses Deno's Node
// compatibility layer instead of the shared Web Crypto helpers.
import { createHmac } from "node:crypto";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Signature is computed over the exact raw body bytes, so this must be
    // read as text before any JSON parsing touches it.
    const rawBody = await req.text();
    const signature = req.headers.get("X-Patreon-Signature") || "";
    const webhookSecret = Deno.env.get("PATREON_WEBHOOK_SECRET")!;

    const expected = createHmac("md5", webhookSecret).update(rawBody).digest("hex");
    if (expected !== signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const member = payload?.data;
    if (!member || member.type !== "member") {
      // Not a member-related event we care about, acknowledge and ignore.
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    const patreonUserId = member.relationships?.user?.data?.id || "";
    if (!patreonUserId) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: campaignConfig } = await supabase
      .from("patreon_campaign_config")
      .select("campaign_id")
      .eq("id", true)
      .maybeSingle();
    const campaignId = campaignConfig?.campaign_id || Deno.env.get("PATREON_CAMPAIGN_ID") || null;
    const proTierId = Deno.env.get("PATREON_PRO_TIER_ID")!;
    const eventCampaignId = member.relationships?.campaign?.data?.id;

    let isPro = false;
    if (!campaignId || !eventCampaignId || eventCampaignId === campaignId) {
      const entitledTierIds = (member.relationships?.currently_entitled_tiers?.data || []).map(
        (t: any) => t.id
      );
      const isActivePatron = member.attributes?.patron_status === "active_patron";
      isPro = isActivePatron && entitledTierIds.includes(proTierId);
    }

    const { data: connection, error: lookupError } = await supabase
      .from("patreon_connections")
      .select("user_id")
      .eq("patreon_user_id", patreonUserId)
      .maybeSingle();

    if (lookupError) {
      console.error("Patreon connection lookup failed:", lookupError.message);
      return new Response("Lookup failed", { status: 500 });
    }
    if (!connection) {
      // Someone whose Patreon account isn't linked to any Kairil account,
      // e.g. a patron who hasn't ever connected. Nothing to update.
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    const { error: updateError } = await supabase
      .from("patreon_connections")
      .update({ is_pro: isPro })
      .eq("user_id", connection.user_id);
    if (updateError) {
      console.error("Failed to update patreon_connections.is_pro:", updateError.message);
    }

    // is_admin accounts always keep full access, don't let a plan sync ever
    // downgrade one of those.
    const { data: settingsRow } = await supabase
      .from("user_settings")
      .select("is_admin")
      .eq("user_id", connection.user_id)
      .maybeSingle();

    if (!settingsRow?.is_admin) {
      const { error: planError } = await supabase
        .from("user_settings")
        .update({ plan: isPro ? "pro" : "free" })
        .eq("user_id", connection.user_id);
      if (planError) {
        console.error("Failed to update plan from webhook:", planError.message);
      }
    }

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("Patreon webhook error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
});
