// GET /patreon-callback?code=...&state=<intent id>
// Same intent-based state handling as google-drive-callback - see
// migration_oauth_intents.sql and _shared/oauth_intent.ts. Exchanges the
// code for tokens, checks whether the connecting user is currently
// entitled to the Pro tier on our campaign, sets their plan accordingly,
// encrypts and stores the refresh token, then redirects back into the app.

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

    const userId = await consumeIntentForCallback(state, "patreon");
    if (!userId) {
      return new Response(
        "This connection attempt has expired or was already completed. Go back to Settings and try again.",
        { status: 401 }
      );
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
    // Campaign id is only ever established two ways: a pre-configured
    // patreon_campaign_config row, or the PATREON_CAMPAIGN_ID env var -
    // never by auto-discovering it from whoever happens to be connecting.
    // The previous version let the *first* successful connection's own
    // Patreon /campaigns lookup silently become the permanent global
    // campaign if nothing was set yet. That "only real patrons get empty
    // results here" reasoning holds for ordinary patrons, but any patron
    // who happens to run their own unrelated Patreon campaign - a
    // genuinely common thing - would have had *their* campaign silently
    // adopted as Studio Kairegi's, breaking Pro verification for everyone
    // else. There's no way to reliably tell "the studio owner, bootstrapping
    // for the first time" apart from "an unrelated patron who owns a
    // campaign" from inside this callback, so the only safe answer is to
    // never auto-bootstrap here at all - the studio owner sets
    // PATREON_CAMPAIGN_ID (or inserts the row directly) once, by hand.
    let campaignId: string | null = null;
    const { data: campaignConfig } = await supabase
      .from("patreon_campaign_config")
      .select("campaign_id")
      .eq("id", true)
      .maybeSingle();
    if (campaignConfig?.campaign_id) campaignId = campaignConfig.campaign_id;
    if (!campaignId) campaignId = Deno.env.get("PATREON_CAMPAIGN_ID") || null;

    if (!campaignId) {
      console.error(
        "No campaign id configured. Set PATREON_CAMPAIGN_ID (or insert a row into patreon_campaign_config) as the studio owner before Patreon Pro verification can work."
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
      if (connectionError.code === "23505") {
        // patreon_user_id has a unique constraint (see migration_audit_fixes_2.sql)
        // - this specific Patreon account is already linked to a different
        // Kairil account. Without that constraint this would silently
        // create two rows sharing one patreon_user_id, and the webhook's
        // lookup-by-patreon_user_id would break for both accounts the
        // next time Patreon notified us about this patron.
        console.error("Patreon account already linked to a different Kairil user:", userId);
        return Response.redirect(`${appUrl}?patreon=already_linked`, 302);
      }
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
