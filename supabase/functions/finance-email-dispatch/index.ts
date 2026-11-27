// finance-email-dispatch: sends queued Finance V3 emails through Resend. Called by a scheduler (header x-cron-secret =
// FINANCE_EMAIL_CRON_SECRET) or by a signed-in user who may send Finance email (a "send now" nudge). Deploy with --no-verify-jwt:
// the cron path has no JWT, and the user path is verified here with the caller's token.
//
// The dispatcher can only read queued messages and record attempts; it has no access to any money function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { dispatchDue, type SendOutcome } from "../_shared/finance_v3_email_service.ts";
import { sendViaResend } from "../_shared/email_adapter_resend.ts";
import { constantTimeEqual } from "../_shared/paystack_core.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json(503, { error: "Email is not configured." });

  // Authorization: cron secret OR a user with finance.send_email in the organization named in the body.
  const secret = Deno.env.get("FINANCE_EMAIL_CRON_SECRET") || "";
  const provided = req.headers.get("x-cron-secret") || "";
  let allowed = !!secret && !!provided && constantTimeEqual(secret, provided);
  if (!allowed) {
    const auth = req.headers.get("authorization") || "";
    const body = await req.clone().json().catch(() => ({} as any));
    const org = String(body?.organization_id || "");
    if (auth.startsWith("Bearer ") && /^[0-9a-f-]{36}$/i.test(org)) {
      const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
      const { data, error } = await user.rpc("fin3_my_permissions", { p_org: org });
      allowed = !error && JSON.stringify(data || "").includes("finance.send_email");
    }
  }
  if (!allowed) return json(401, { error: "Not authorized." });

  const linkBase = (Deno.env.get("FINANCE_PUBLIC_BASE_URL") || `${Deno.env.get("SUPABASE_URL")}/functions/v1/finance-public`).replace(/\/+$/, "");
  const stats = await dispatchDue({
    rpc: async (name, args) => { const r = await service.rpc(name, args); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.data; },
    send: async (payload, key): Promise<SendOutcome> => {
      const o = await sendViaResend(fetch, apiKey, payload, key);
      return o.ok ? { ok: true, id: o.id } : { ok: false, unknown: !!o.unknown, retryable: !!o.retryable, status: o.status, message: o.message };
    },
    linkBase,
    log: (m, extra) => console.error(m, extra),
  }, { limit: 10 });
  return json(200, stats);
});
