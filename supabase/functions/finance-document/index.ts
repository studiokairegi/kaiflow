// finance-document: authenticated download of an invoice or receipt PDF. The caller's own JWT is used to prove they may read the
// document (the Finance RPCs enforce organization and finance.read); the PDF itself is built from the frozen snapshot and stored once.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { attachmentFor } from "../_shared/finance_v3_email_service.ts";
import { fromBase64 } from "../_shared/finance_v3_pdf.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Sign in first." });
  const body = await req.json().catch(() => null) as any;
  const org = String(body?.organization_id || ""), id = String(body?.id || ""), kind = String(body?.kind || "");
  if (!UUID.test(org) || !UUID.test(id) || !["invoice_pdf", "receipt_pdf"].includes(kind)) return json(400, { error: "Invalid request." });

  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const probe = kind === "invoice_pdf" ? await user.rpc("fin3_get_invoice", { p_org: org, p_invoice: id }) : await user.rpc("fin3_get_receipt", { p_org: org, p_receipt: id });
  if (probe.error) return json(probe.error.code === "V3005" ? 403 : 404, { error: "Document not available." });
  try {
    const doc = await attachmentFor({ rpc: async (n, a) => { const r = await service.rpc(n, a); if (r.error) throw new Error(r.error.message); return r.data; }, send: async () => ({ ok: false, unknown: false, retryable: false, status: 0, message: "unused" }), linkBase: "" },
      org, { kind, entity_id: id });
    return new Response(fromBase64(doc.content_base64), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${doc.filename}"`, "Cache-Control": "no-store", ...CORS } });
  } catch {
    return json(500, { error: "The document could not be prepared." });
  }
});
