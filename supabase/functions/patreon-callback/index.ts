// GET /patreon-callback?code=...&state=...
// Exchanges the code for tokens, verifies the signed state to recover which
// user is connecting, checks whether they're currently entitled to the Pro
// tier on our campaign, sets their plan accordingly, encrypts and stores
// the refresh token, then redirects back into the app. Mirrors
// google-drive-callback's structure.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText } from "../_shared/crypto.ts";

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
  const appUrl = Deno.env.get("APP_URL") || "/";
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const [userId, signature] = state.split(".");

    if (!code || !userId || !signature) {
      return new Response("Missing code or state", { status: 400 });
    }

    const secret = Deno.env.get("DRIVE_STATE_SECRET")!;
    const expected = await sign(userId, secret);
    if (expected !== signature) {
      return new Response("Invalid state", { status: 401 });
    }

    const clientId = Deno.env.get("PATREON_CLIENT_ID")!;
    const clientSecret = Deno.env.get("PATREON_CLIENT_SECRET")!;
    const redirectUri = Deno.env.get("PATREON_REDIRECT_URI")!;
    const proTierId = Deno.env.get("PATREON_PRO_TIER_ID")!;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const tokenRes = await fetch("https://www.patreon.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error("Patreon token exchange failed:", tokenRes.status, body);
      return Response.redirect(`${appUrl}?patreon=error`, 302);
    }

    const tokenJson = await tokenRes.json();
    const refreshToken = tokenJson.refresh_token;
    const accessToken = tokenJson.access_token;
    if (!refreshToken || !accessToken) {
      console.error("Patreon token response missing tokens:", JSON.stringify(tokenJson));
      return Response.redirect(`${appUrl}?patreon=error`, 302);
    }

    // Resolve the campaign id: prefer whatever's already stored (discovered
    // on a previous connection), fall back to a manually-set secret if
    // someone prefers to hardcode it, and if neither exists yet, try
    // discovering it right now, this only actually returns data if the
    // person connecting happens to be the campaign's own creator. Regular
    // patrons connecting get an empty result here and that's fine, expected.
    let campaignId: string | null = null;
    const { data: campaignConfig } = await supabase
      .from("patreon_campaign_config")
      .select("campaign_id")
      .eq("id", true)
      .maybeSingle();
    if (campaignConfig?.campaign_id) campaignId = campaignConfig.campaign_id;
    if (!campaignId) campaignId = Deno.env.get("PATREON_CAMPAIGN_ID") || null;

    const campaignsRes = await fetch("https://www.patreon.com/api/oauth2/v2/campaigns", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (campaignsRes.ok) {
      const campaignsJson = await campaignsRes.json();
      const discoveredId = campaignsJson?.data?.[0]?.id;
      if (discoveredId) {
        if (!campaignId) campaignId = discoveredId;
        // Keep this current regardless, cheap to refresh and self-healing
        // if it's ever wrong.
        const { error: campaignSaveError } = await supabase
          .from("patreon_campaign_config")
          .upsert({ id: true, campaign_id: discoveredId, discovered_at: new Date().toISOString() });
        if (campaignSaveError) {
          console.error("Failed to store discovered campaign id:", campaignSaveError.message);
        }
      }
    }

    if (!campaignId) {
      console.error(
        "No campaign id available yet, connect Patreon once as the campaign creator to auto-discover it, or set PATREON_CAMPAIGN_ID manually."
      );
    }

    // Fetch identity plus their membership on our campaign, including which
    // tiers they're currently entitled to, this is what actually determines
    // Pro access, not just "did they connect an account."
    const identityUrl = new URL("https://www.patreon.com/api/oauth2/v2/identity");
    identityUrl.searchParams.set("include", "memberships.currently_entitled_tiers");
    identityUrl.searchParams.set("fields[member]", "patron_status");
    identityUrl.searchParams.set("fields[user]", "email");

    const identityRes = await fetch(identityUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let email = "";
    let patreonUserId = "";
    let isPro = false;

    if (!identityRes.ok) {
      const body = await identityRes.text();
      console.error("Patreon identity request failed:", identityRes.status, body);
      return Response.redirect(`${appUrl}?patreon=error`, 302);
    }

    const identity = await identityRes.json();
    patreonUserId = identity?.data?.id || "";
    email = identity?.data?.attributes?.email || "";

    if (!patreonUserId) {
      return Response.redirect(`${appUrl}?patreon=error`, 302);
    }

    const members = (identity.included || []).filter((item: any) => item.type === "member");
    const membershipOnOurCampaign = campaignId
      ? members.find((m: any) => m.relationships?.campaign?.data?.id === campaignId)
      : null;

    if (membershipOnOurCampaign) {
      const entitledTierIds = (membershipOnOurCampaign.relationships?.currently_entitled_tiers?.data || []).map(
        (t: any) => t.id
      );
      const isActivePatron = membershipOnOurCampaign.attributes?.patron_status === "active_patron";
      isPro = isActivePatron && entitledTierIds.includes(proTierId);
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
    const encryptedRefreshToken = await encryptText(refreshToken, encryptionKey);

    const { error: connectionError } = await supabase.from("patreon_connections").upsert({
      user_id: userId,
      patreon_user_id: patreonUserId,
      connected_email: email,
      refresh_token_encrypted: encryptedRefreshToken,
      is_pro: isPro,
    });
    if (connectionError) {
      console.error("Failed to save Patreon connection:", connectionError.message);
      return Response.redirect(`${appUrl}?patreon=error`, 302);
    }

    // is_admin accounts keep full access regardless of plan, don't downgrade them.
    const { data: settingsRow } = await supabase
      .from("user_settings")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();

    if (!settingsRow?.is_admin) {
      const { error: planError } = await supabase
        .from("user_settings")
        .update({ plan: isPro ? "pro" : "free" })
        .eq("user_id", userId);
      if (planError) {
        console.error("Failed to update plan after Patreon connect:", planError.message);
      }
    }

    return Response.redirect(`${appUrl}?patreon=connected`, 302);
  } catch (err) {
    console.error("Patreon callback error:", err.message);
    return Response.redirect(`${appUrl}?patreon=error`, 302);
  }
});
