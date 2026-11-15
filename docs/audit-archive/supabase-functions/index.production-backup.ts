import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function decryptText(encoded: string, base64Key: string): Promise<string> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return json({ error: "Not authenticated" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: "Bearer " + match[1] } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(match[1]);
  const userId = userData?.user?.id;
  if (userError || !userId) return json({ error: "Not authenticated" }, 401);

  const { data: allowed, error: authzError } = await userClient.rpc("intel_is_authorized");
  if (authzError || allowed !== true) return json({ error: "KairFlow Intelligence is restricted." }, 403);
  const { data: org, error: orgError } = await userClient.rpc("intel_admin_org");
  if (orgError || !org) return json({ error: "KairFlow Intelligence is restricted." }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const accountId = String(body?.account_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return json({ error: "A valid provider account id is required" }, 400);

  const { data: account, error: accountError } = await service.from("intel_provider_accounts")
    .select("id,provider_key,mailbox,credentials_ciphertext,status")
    .eq("id", accountId).eq("organization_id", org).maybeSingle();
  if (accountError || !account) return json({ error: "Provider account was not found" }, 404);
  if (account.provider_key !== "gmail" || account.status !== "connected" || !account.credentials_ciphertext) {
    return json({ error: "A connected Gmail OAuth account is required" }, 409);
  }

  const updateHealth = async (health_status: string, last_error: string) => {
    const now = new Date().toISOString();
    const { error } = await service.from("intel_provider_accounts").update({
      health_status, last_error, last_health_check_at: now, updated_at: now,
    }).eq("id", account.id).eq("organization_id", org);
    if (error) throw new Error("health_status_update_failed");
    return now;
  };

  try {
    const key = Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY");
    const clientId = Deno.env.get("GOOGLE_GMAIL_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET");
    if (!key || !clientId || !clientSecret) throw new Error("health_check_not_configured");

    const decrypted = await decryptText(account.credentials_ciphertext, key);
    let credentials: any;
    try { credentials = JSON.parse(decrypted); }
    catch { credentials = { refresh_token: decrypted }; }
    const refreshToken = String(credentials?.refresh_token || "");
    if (!refreshToken) throw new Error("missing_refresh_token");

    const form = new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret,
    });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      const revoked = tokenData?.error === "invalid_grant";
      const health = revoked ? "unhealthy" : "degraded";
      const message = revoked
        ? "Google authorization is no longer valid; reconnect Gmail."
        : "Google token refresh failed; retry the health check.";
      const checkedAt = await updateHealth(health, message);
      return json({ ok: false, health_status: health, checked_at: checkedAt,
        error: revoked ? "Gmail authorization has expired or been revoked." : "Gmail authorization could not be refreshed." }, revoked ? 409 : 503);
    }

    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: "Bearer " + tokenData.access_token, Accept: "application/json" },
    });
    const profile = await profileResponse.json().catch(() => ({}));
    const mailbox = String(profile?.emailAddress || "").trim().toLowerCase();
    if (!profileResponse.ok || !mailbox || mailbox !== String(account.mailbox || "").trim().toLowerCase()) {
      const checkedAt = await updateHealth("unhealthy", "Gmail profile verification failed or mailbox did not match the connected account.");
      return json({ ok: false, health_status: "unhealthy", checked_at: checkedAt,
        error: "Gmail mailbox verification failed." }, 409);
    }

    const checkedAt = await updateHealth("healthy", "");
    return json({ ok: true, provider: "gmail", health_status: "healthy", checked_at: checkedAt });
  } catch (_error) {
    try { await updateHealth("degraded", "Gmail health check could not complete; retry or reconnect the account."); }
    catch { /* keep response generic */ }
    return json({ ok: false, health_status: "degraded", error: "Gmail health check could not complete." }, 503);
  }
});
