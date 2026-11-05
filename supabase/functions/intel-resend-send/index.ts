// Intelligence-only Resend proxy. The worker sends only a message id; content is loaded
// from the agent-scoped RPC after authenticating the agent JWT. RESEND_API_KEY never
// leaves Edge Function secrets. No send is possible while the database kill switch is ON.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return json({ error: "Not authenticated" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const user = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await user.auth.getUser(match[1]);
  if (authError || !auth?.user?.id) return json({ error: "Not authenticated" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ status: "rejected", error: "Resend is not configured" }, 503);

  // Read-only reconciliation for recent KairFlow sends. This calls Resend GET only;
  // it never creates or resends an email. It verifies against the exact API key
  // configured in this Edge Function, removing ambiguity about dashboard workspaces.
  if (body?.action === "audit_recent") {
    const { data: recent, error } = await user.rpc("intel_admin_resend_recent_sent", { p_limit: 20 });
    if (error) return json({ error: "Could not load recent sent-message records" }, 500);

    const results = [];
    for (const item of (Array.isArray(recent) ? recent : [])) {
      const providerId = String(item.provider_message_id || "");
      if (!providerId) {
        results.push({ message_id: item.id, state: item.state, sent_at: item.sent_at, verification: "missing_provider_id" });
        continue;
      }
      try {
        const check = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (check.status === 404) {
          results.push({ message_id: item.id, provider_message_id: providerId, state: item.state, sent_at: item.sent_at, verification: "not_found_in_configured_resend_account" });
          continue;
        }
        if (!check.ok) {
          results.push({ message_id: item.id, provider_message_id: providerId, state: item.state, sent_at: item.sent_at, verification: "resend_api_unavailable", resend_http_status: check.status });
          continue;
        }
        const found: any = await check.json();
        const verified = found?.id === providerId && !!found?.created_at;
        results.push({
          message_id: item.id,
          provider_message_id: providerId,
          state: item.state,
          sent_at: item.sent_at,
          verification: verified ? "verified_in_configured_resend_account" : "provider_id_mismatch",
          resend_created_at: found?.created_at || null,
          resend_last_event: found?.last_event || null,
        });
      } catch {
        results.push({ message_id: item.id, provider_message_id: providerId, state: item.state, sent_at: item.sent_at, verification: "resend_api_unavailable" });
      }
    }
    console.log(JSON.stringify({ event: "resend_recent_audit", checked: results.length }));
    return json({ ok: true, checked: results.length, results });
  }

  if (!/^[0-9a-f-]{36}$/i.test(String(body?.message_id || ""))) {
    return json({ error: "Invalid message id" }, 400);
  }

  if (body.action === "verify") {
    const providerId = String(body.provider_message_id || "");
    const { data: allowed, error: verifyError } = await user.rpc("intel_agent_resend_verify_context", {
      p_message_id: body.message_id,
      p_provider_message_id: providerId,
    });
    if (verifyError || allowed !== true) return json({ error: "Provider id is not eligible for verification" }, 403);

    let check: Response;
    try {
      check = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      return json({ error: "Verification unavailable" }, 503);
    }
    if (check.status === 404) return json({ verified: false }, 404);
    if (!check.ok) return json({ error: "Verification unavailable" }, 503);
    const found: any = await check.json();
    const verified = found?.id === providerId && !!found?.created_at;
    return json({
      verified,
      created_at: found?.created_at || null,
      last_event: found?.last_event || null,
    });
  }

  const { data: payload, error } = await user.rpc("intel_agent_resend_send_context", {
    p_message_id: body.message_id,
  });
  if (error || !payload) return json({ status: "rejected", error: "Message is not eligible for sending" }, 409);

  const headers: Record<string, string> = { "X-KairFlow-Intel-Token": payload.token };
  if (payload.in_reply_to) headers["In-Reply-To"] = payload.in_reply_to;
  if (payload.references_ids) headers["References"] = payload.references_ids;
  const from = payload.sender_name
    ? `${String(payload.sender_name).replace(/[<>\r\n"]/g, "")} <${payload.sender_email}>`
    : payload.sender_email;
  const rawText = String(payload.body_text || "");
  const text = rawText.includes(String(payload.token))
    ? rawText
    : `${rawText.trimEnd()}\n\nRef: ${payload.token}\n`;
  const requestBody = {
    from,
    to: [payload.to_email],
    subject: payload.subject,
    text,
    reply_to: payload.sender_email,
    headers,
  };

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `kairflow-intel-${payload.id}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    console.error(JSON.stringify({ event: "resend_send_outcome_unknown", message_id: payload.id, reason: "network_exception" }));
    return json({ status: "unknown", error: "Resend request outcome is unknown" }, 202);
  }

  let result: any = {};
  try { result = await response.json(); } catch { /* response cannot establish acceptance */ }

  if (response.ok && result?.id) {
    console.log(JSON.stringify({
      event: "resend_send_accepted",
      message_id: payload.id,
      provider_message_id: result.id,
      resend_http_status: response.status,
    }));
    return json({ ok: true, status: "sent", id: result.id });
  }

  const message = String(result?.message || result?.error || "Resend request failed").slice(0, 180);
  console.error(JSON.stringify({
    event: "resend_send_not_accepted",
    message_id: payload.id,
    resend_http_status: response.status,
    error: message,
  }));
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return json({ status: "rejected", error: message }, 422);
  }
  return json({ status: "unknown", error: message }, 202);
});
