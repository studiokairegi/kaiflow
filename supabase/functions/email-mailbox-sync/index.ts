// email-mailbox-sync: scheduled worker for general Email mailbox synchronization (Gmail/Zoho/IMAP adapters plug in through the registry).
// Not a browser endpoint: authenticated only by the shared secret EMAIL_SYNC_CRON_SECRET (header x-email-sync-secret). Deploy with --no-verify-jwt.
// Secrets: EMAIL_SYNC_CRON_SECRET (>=16 chars), EMAIL_TOKEN_ENCRYPTION_KEY (base64, 32 bytes).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { runMailboxSync, secretMatches } from "../_shared/email_mailbox_sync_runner.ts";
import { makeMailboxSyncStore, loadEmailCredentials } from "../_shared/email_mailbox_store.ts";
import { corsHeaders } from "../_shared/cors.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!secretMatches(Deno.env.get("EMAIL_SYNC_CRON_SECRET"), req.headers.get("x-email-sync-secret"))) return reply({ error: "Unauthorized" }, 401);
  const key = Deno.env.get("EMAIL_TOKEN_ENCRYPTION_KEY");
  if (!key) return reply({ error: "Mailbox credential encryption key is not configured" }, 503);
  try {
    const summary = await runMailboxSync({
      async listAccounts(limit) {
        const { data, error } = await service.from("email_accounts").select("id,organization_id,provider,address,display_name,status,connection_status")
          .eq("status", "active").eq("connection_status", "connected").order("last_validated_at", { ascending: true, nullsFirst: true }).limit(limit);
        if (error) throw new Error(`account list: ${error.message}`);
        return data || [];
      },
      async getRegistryRow(providerKey) {
        const { data, error } = await service.from("email_provider_registry").select("provider_key,adapter_key,display_name,capabilities,enabled").eq("provider_key", providerKey).maybeSingle();
        if (error) throw new Error(`provider registry: ${error.message}`);
        return data;
      },
      makeContext: () => ({
        env: (k) => Deno.env.get(k), fetch: (url, init) => fetch(url, init as RequestInit), now: () => Date.now(),
        getCredentials: (account) => loadEmailCredentials(service, { accountId: account.id, organizationId: String(account.organization_id), provider: account.provider, encryptionKey: key }),
      }),
      store: makeMailboxSyncStore(service),
    });
    return reply({ ok: true, ...summary });
  } catch (e) {
    console.error("email-mailbox-sync failed:", String((e as Error)?.message || "error").slice(0, 200));
    return reply({ ok: false, error: "Mailbox synchronization run failed" }, 500);
  }
});
