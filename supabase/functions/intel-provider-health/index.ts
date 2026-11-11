import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const ZOHO_DATA_CENTERS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"];

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

const service = createClient(
  supabaseUrl,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return json({ error: "Not authenticated" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: "Bearer " + match[1] } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(match[1]);
  const userId = userData?.user?.id;

  if (userError || !userId) {
    return json({ error: "Not authenticated" }, 401);
  }

  const { data: allowed, error: authzError } =
    await userClient.rpc("intel_is_authorized");

  if (authzError || allowed !== true) {
    return json({ error: "KairFlow Intelligence is restricted." }, 403);
  }

  const { data: org, error: orgError } = await userClient.rpc("intel_admin_org");

  if (orgError || !org) {
    return json({ error: "KairFlow Intelligence is restricted." }, 403);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const accountId = String(body?.account_id || "");

  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    return json({ error: "A valid provider account id is required" }, 400);
  }

  const { data: account, error: accountError } = await service
    .from("intel_provider_accounts")
    .select("id,provider_key,mailbox,credentials_ciphertext,status,data_center")
    .eq("id", accountId)
    .eq("organization_id", org)
    .maybeSingle();

  if (accountError || !account) {
    return json({ error: "Provider account was not found" }, 404);
  }

  const provider = String(account.provider_key || "");

  if (
    !["gmail", "zoho"].includes(provider) ||
    account.status !== "connected" ||
    !account.credentials_ciphertext
  ) {
    return json({ error: "A connected Gmail or Zoho OAuth account is required" }, 409);
  }

  const providerName = provider === "zoho" ? "Zoho" : "Gmail";

  const updateHealth = async (healthStatus: string, lastError: string) => {
    const now = new Date().toISOString();

    const { error } = await service
      .from("intel_provider_accounts")
      .update({
        health_status: healthStatus,
        last_error: lastError,
        last_health_check_at: now,
        updated_at: now,
      })
      .eq("id", account.id)
      .eq("organization_id", org);

    if (error) throw new Error("health_status_update_failed");

    return now;
  };

  try {
    const key = Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY");

    if (!key) throw new Error("health_check_not_configured");

    const decrypted = await decryptText(account.credentials_ciphertext, key);

    let credentials: any;
    try {
      credentials = JSON.parse(decrypted);
    } catch {
      credentials = { refresh_token: decrypted };
    }

    const refreshToken = String(credentials?.refresh_token || "");

    if (!refreshToken) throw new Error("missing_refresh_token");

    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let tokenUrl: string;
    let tokenForm: URLSearchParams;
    let dataCenter = "";

    if (provider === "gmail") {
      clientId = Deno.env.get("GOOGLE_GMAIL_CLIENT_ID");
      clientSecret = Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        throw new Error("health_check_not_configured");
      }

      tokenUrl = "https://oauth2.googleapis.com/token";
    } else {
      clientId = Deno.env.get("ZOHO_CLIENT_ID");
      clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        throw new Error("health_check_not_configured");
      }

      dataCenter = String(
        credentials?.data_center || account.data_center || "",
      ).trim().toLowerCase();

      if (!ZOHO_DATA_CENTERS.includes(dataCenter)) {
        const checkedAt = await updateHealth(
          "degraded",
          "Zoho data center is missing or invalid; reconnect the Zoho account.",
        );

        return json({
          ok: false,
          health_status: "degraded",
          checked_at: checkedAt,
          error: "Zoho data center is missing or invalid. Reconnect the Zoho account.",
        }, 409);
      }

      tokenUrl = `https://accounts.zoho.${dataCenter}/oauth/v2/token`;
    }

    tokenForm = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    });

    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenData.access_token) {
      const revoked = tokenData?.error === "invalid_grant";
      const health = revoked ? "unhealthy" : "degraded";

      const message = revoked
        ? `${providerName} authorization is no longer valid; reconnect the account.`
        : `${providerName} token refresh failed; retry the health check.`;

      const checkedAt = await updateHealth(health, message);

      return json({
        ok: false,
        health_status: health,
        checked_at: checkedAt,
        error: revoked
          ? `${providerName} authorization has expired or been revoked.`
          : `${providerName} authorization could not be refreshed.`,
      }, revoked ? 409 : 503);
    }

    const accessToken = String(tokenData.access_token);
    let mailbox = "";

    if (provider === "gmail") {
      const profileResponse = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: {
            Authorization: "Bearer " + accessToken,
            Accept: "application/json",
          },
        },
      );

      const profile = await profileResponse.json().catch(() => ({}));
      mailbox = String(profile?.emailAddress || "").trim().toLowerCase();

      if (
        !profileResponse.ok ||
        !mailbox ||
        mailbox !== String(account.mailbox || "").trim().toLowerCase()
      ) {
        const checkedAt = await updateHealth(
          "unhealthy",
          "Gmail profile verification failed or mailbox did not match the connected account.",
        );

        return json({
          ok: false,
          health_status: "unhealthy",
          checked_at: checkedAt,
          error: "Gmail mailbox verification failed.",
        }, 409);
      }
    } else {
      const accountsResponse = await fetch(
        `https://mail.zoho.${dataCenter}/api/accounts`,
        {
          headers: {
            Authorization: "Zoho-oauthtoken " + accessToken,
            Accept: "application/json",
          },
        },
      );

      const accountsData = await accountsResponse.json().catch(() => ({}));
      const rows = accountsData?.data;
      const zohoAccount = Array.isArray(rows) ? rows[0] : null;

      mailbox = String(
        zohoAccount?.primaryEmailAddress ||
        zohoAccount?.mailboxAddress ||
        zohoAccount?.emailAddress ||
        "",
      ).trim().toLowerCase();

      if (
        !accountsResponse.ok ||
        !zohoAccount?.accountId ||
        !mailbox ||
        mailbox !== String(account.mailbox || "").trim().toLowerCase()
      ) {
        const checkedAt = await updateHealth(
          "unhealthy",
          "Zoho account verification failed or mailbox did not match the connected account.",
        );

        return json({
          ok: false,
          health_status: "unhealthy",
          checked_at: checkedAt,
          error: "Zoho mailbox verification failed.",
        }, 409);
      }
    }

    const checkedAt = await updateHealth("healthy", "");

    return json({
      ok: true,
      provider,
      health_status: "healthy",
      checked_at: checkedAt,
    });
  } catch (_error) {
    try {
      await updateHealth(
        "degraded",
        `${providerName} health check could not complete; retry or reconnect the account.`,
      );
    } catch {
      // Keep response generic.
    }

    return json({
      ok: false,
      health_status: "degraded",
      error: `${providerName} health check could not complete.`,
    }, 503);
  }
});