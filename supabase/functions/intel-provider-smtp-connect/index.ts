import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText } from "../_shared/crypto.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { requireIntelligenceAdmin } from "../_shared/intel_auth.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await requireIntelligenceAdmin(req, { createClient, url: Deno.env.get("SUPABASE_URL"), anonKey: Deno.env.get("SUPABASE_ANON_KEY") });
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const mailbox = String(body?.mailbox || "").trim().toLowerCase();
  const host = String(body?.host || "").trim().toLowerCase();
  const port = Number(body?.port);
  const username = String(body?.username || "").trim();
  const password = String(body?.password || "");
  const tls_mode = String(body?.tls_mode || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) || !/^(?=.{1,253}$)[a-z0-9.-]+$/.test(host) ||
      ![465, 587].includes(port) || !username || username.length > 320 || !password || password.length > 2048 || !["ssl", "starttls"].includes(tls_mode))
    return json({ error: "Provide a valid mailbox, hostname, port 465/587, username, password and TLS mode" }, 400);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data: org, error: orgError } = await user.rpc("intel_admin_org");
  if (orgError || !org) return json({ error: "KairFlow Intelligence is restricted." }, 403);
  const { data: provider } = await service.from("intel_email_provider_registry").select("enabled").eq("provider_key", "smtp").maybeSingle();
  if (!provider?.enabled) return json({ error: "SMTP is not enabled in the server catalogue" }, 409);
  const key = Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY");
  if (!key) return json({ error: "Credential encryption is not configured" }, 503);
  const credentials_ciphertext = await encryptText(JSON.stringify({ host, port, username, password, tls_mode }), key);
  const { data, error } = await service.from("intel_provider_accounts").upsert({
    organization_id: org, provider_key: "smtp", external_account_id: mailbox, mailbox,
    display_name: mailbox, auth_method: "smtp_password", scopes: "smtp-submit", credentials_ciphertext,
    status: "connected", health_status: "unknown", is_enabled: false, send_enabled: false,
    allowed_message_purposes: ["business_correspondence"], connected_by: auth.userId,
    daily_send_limit: 25, hourly_send_limit: 5, minute_send_limit: 1,
    last_error: "", disconnected_at: null,
  }, { onConflict: "organization_id,provider_key,mailbox" }).select("id,mailbox,provider_key,status,is_enabled,send_enabled").single();
  if (error || !data) return json({ error: "Could not save SMTP account credentials" }, 500);
  return json({ ok: true, account: data });
});
