// Intelligence-only Resend proxy. The worker sends only a message id; content is loaded
// from the agent-scoped RPC after authenticating the agent JWT. RESEND_API_KEY never
// leaves Edge Function secrets. No send is possible while the database kill switch is ON.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return json({ error: "Not authenticated" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const user = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${match[1]}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await user.auth.getUser(match[1]);
  if (authError || !auth?.user?.id) return json({ error: "Not authenticated" }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  if (!/^[0-9a-f-]{36}$/i.test(String(body?.message_id || ""))) return json({ error: "Invalid message id" }, 400);
  if (body.action === "verify") {
    const providerId = String(body.provider_message_id || "");
    const { data: allowed, error: verifyError } = await user.rpc("intel_agent_resend_verify_context", { p_message_id: body.message_id, p_provider_message_id: providerId });
    if (verifyError || allowed !== true) return json({ error: "Provider id is not eligible for verification" }, 403);
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ error: "Resend is not configured" }, 503);
    let check: Response;
    try { check = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, { headers: { Authorization: `Bearer ${key}` } }); }
    catch { return json({ error: "Verification unavailable" }, 503); }
    if (check.status === 404) return json({ verified: false }, 404);
    if (!check.ok) return json({ error: "Verification unavailable" }, 503);
    const found: any = await check.json();
    return json({ verified: found?.id === providerId && !!found?.created_at });
  }
  const { data: payload, error } = await user.rpc("intel_agent_resend_send_context", { p_message_id: body.message_id });
  if (error || !payload) return json({ status: "rejected", error: "Message is not eligible for sending" }, 409);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ status: "rejected", error: "Resend is not configured" }, 503);

  const headers: Record<string, string> = { "X-KairFlow-Intel-Token": payload.token };
  if (payload.in_reply_to) headers["In-Reply-To"] = payload.in_reply_to;
  if (payload.references_ids) headers["References"] = payload.references_ids;
  const from = payload.sender_name ? `${String(payload.sender_name).replace(/[<>\r\n"]/g, "")} <${payload.sender_email}>` : payload.sender_email;
  const rawText = String(payload.body_text || "");
  const text = rawText.includes(String(payload.token)) ? rawText : `${rawText.trimEnd()}\n\nRef: ${payload.token}\n`;
  const requestBody = { from, to: [payload.to_email], subject: payload.subject, text,
    reply_to: payload.sender_email, headers };
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `kairflow-intel-${payload.id}` },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return json({ status: "unknown", error: "Resend request outcome is unknown" }, 202);
  }
  let result: any = {};
  try { result = await response.json(); } catch { /* response cannot establish acceptance */ }
  if (response.ok && result?.id) return json({ ok: true, status: "sent", id: result.id });
  const message = String(result?.message || result?.error || "Resend request failed").slice(0, 180);
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return json({ status: "rejected", error: message }, 422);
  }
  return json({ status: "unknown", error: message }, 202);
});
