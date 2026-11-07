// Intelligence-only inbound Resend webhook. Configure a Resend webhook subscription
// for email.received pointing here. It intentionally does not use normal Inbox routing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifySvixSignature } from "../_shared/email_resend_logic.ts";
import { normalizeIntelReply, ingestIntelReply } from "../_shared/intel_resend_logic.ts";

const asText = (v: unknown) => typeof v === "string" ? v : v == null ? "" : String(v);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET"), apiKey = Deno.env.get("RESEND_API_KEY");
  if (!secret || !apiKey) return json({ error: "Webhook is not configured" }, 503);
  if (Number(req.headers.get("content-length") || 0) > 1_000_000) return json({ error: "Payload too large" }, 413);
  const raw = await req.text();
  if (raw.length > 1_000_000) return json({ error: "Payload too large" }, 413);
  const id = req.headers.get("svix-id") || "", timestamp = req.headers.get("svix-timestamp") || "", signature = req.headers.get("svix-signature") || "";
  const valid = await verifySvixSignature({ secret, id, timestamp, signature, body: raw, nowMs: Date.now() });
  if (!valid) return json({ error: "Invalid signature" }, 401);
  let event: any;
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid payload" }, 400); }
  if (event?.type !== "email.received") return json({ ok: true, ignored: "unsupported event" });
  const emailId = asText(event?.data?.email_id || event?.data?.id);
  if (!emailId) return json({ error: "Missing received email id" }, 400);

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const fetched = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!fetched.ok) return json({ error: "Could not retrieve received email" }, 502);
    const full: any = await fetched.json();
    const inbound = normalizeIntelReply(full, event.data);
    // No valid Intelligence token: this is a normal Inbox message, not an Intelligence reply.
    if (!inbound) return json({ ok: true, ignored: "not an Intelligence reply" });
    const { data, error } = await ingestIntelReply(inbound, async (payload) => {
      const result = await service.rpc("intel_resend_record_inbound", payload);
      if (result.error) throw result.error;
      return result.data;
    });
    return json({ ok: true, ...data });
  } catch (e) {
    // Do not log message content, recipient addresses, signatures, or credentials.
    console.error("intel-resend-webhook processing failed:", String((e as Error)?.message || "error").slice(0, 180));
    return json({ error: "Processing failed" }, 500);
  }
});
