// email-mailbox-sync: scheduled worker for general Email mailbox synchronization (Gmail/Zoho/IMAP adapters plug in through the registry).
// Not a browser endpoint: authenticated only by the shared secret EMAIL_SYNC_CRON_SECRET (header x-email-sync-secret). Deploy with --no-verify-jwt.
// Secrets: EMAIL_SYNC_CRON_SECRET (>=16 chars), INTEL_TOKEN_ENCRYPTION_KEY (existing Intelligence credential key).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { runMailboxSync, secretMatches } from "../_shared/email_mailbox_sync_runner.ts";
import { makeMailboxSyncStore, loadSharedIntelligenceCredentials } from "../_shared/email_mailbox_store.ts";
import { getSharedProviderAccessToken } from "../_shared/intel_provider_oauth.ts";
import { createProviderTokenCache } from "../_shared/email_provider_token_cache.ts";
import { encryptText, decryptText } from "../_shared/crypto.ts";
import { corsHeaders } from "../_shared/cors.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const oauthDeps = {
  env: (name: string) => Deno.env.get(name), createClient, service,
  fetch: (url: string, init?: Record<string, unknown>) => fetch(url, { ...(init as RequestInit), signal: (init as RequestInit)?.signal || AbortSignal.timeout(15_000) }),
  encrypt: (value: string) => encryptText(value, Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY") || ""),
  decrypt: (value: string) => decryptText(value, Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY") || ""), now: () => Date.now(),
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!secretMatches(Deno.env.get("EMAIL_SYNC_CRON_SECRET"), req.headers.get("x-email-sync-secret"))) return reply({ error: "Unauthorized" }, 401);
  const key = Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY");
  if (!key) return reply({ error: "Intelligence mailbox credential encryption key is not configured" }, 503);
  try {
    const summary = await runMailboxSync({
      async listAccounts(limit) {
        // The database applies account opt-in, provider registry/capability, retry and lease
        // eligibility in one authoritative query. Claim/renew re-check the same predicate.
        const { data, error } = await service.rpc("email_list_sync_accounts", { p_limit: limit });
        if (error) throw new Error(`account list: ${error.message}`);
        return data || [];
      },
      async getRegistryRow(providerKey) {
        const { data, error } = await service.from("email_provider_registry").select("provider_key,adapter_key,display_name,capabilities,enabled").eq("provider_key", providerKey).maybeSingle();
        if (error) throw new Error(`provider registry: ${error.message}`);
        return data;
      },
      makeContext: () => {
        const getCachedProviderToken = createProviderTokenCache((account, operation) => getSharedProviderAccessToken({
          accountId: account.id, organizationId: String(account.organization_id || ""),
          provider: account.provider as "gmail" | "zoho", operation,
        }, oauthDeps));
        return ({
        env: (k) => Deno.env.get(k), fetch: (url, init) => fetch(url, { ...(init as RequestInit), signal: (init as RequestInit)?.signal || AbortSignal.timeout(20_000) }), now: () => Date.now(),
        getCredentials: (account) => loadSharedIntelligenceCredentials(service, { accountId: account.id, organizationId: String(account.organization_id), provider: account.provider, encryptionKey: key }),
        getProviderAccessToken: getCachedProviderToken,
      });
      },
      store: makeMailboxSyncStore(service),
    });
    return reply({ ok: true, ...summary });
  } catch (e) {
    console.error("email-mailbox-sync failed:", String((e as Error)?.message || "error").slice(0, 200));
    return reply({ ok: false, error: "Mailbox synchronization run failed" }, 500);
  }
});
