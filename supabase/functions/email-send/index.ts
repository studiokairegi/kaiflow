// email-send: thin wiring only. Logic, validation and limits live in ../_shared/email_resend_logic.ts.
// Signed-in person only (admin + active Master User, the same rule as Intelligence); provider credentials never leave the server.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleSend } from "../_shared/email_resend_logic.ts";
import { makeSendStore } from "../_shared/email_resend_store.ts";
import { getSharedProviderAccessToken } from "../_shared/intel_provider_oauth.ts";
import { encryptText, decryptText } from "../_shared/crypto.ts";

// The user-scoped client needs the project's public (anon / publishable) key. Prefer the classic SUPABASE_ANON_KEY when it has a value;
// otherwise use the default key from SUPABASE_PUBLISHABLE_KEYS (a JSON object). A missing key fails with a message that names the cause.
function getSupabasePublicKey(): string {
  const legacy = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) {
    try {
      const key = JSON.parse(raw)?.default;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch { /* fall through to the error below */ }
  }
  throw new Error("Supabase public key is not configured for email-send (SUPABASE_ANON_KEY and SUPABASE_PUBLISHABLE_KEYS are both empty)");
}

function requireEnv(name: string): string {
  const v = (Deno.env.get(name) || "").trim();
  if (!v) throw new Error(`${name} is not configured for email-send`);
  return v;
}

// The credential key must be base64 for a 16, 24 or 32 byte AES key. Checked here, BEFORE token resolution, because the shared
// resolver reports any decrypt failure as "reconnect this account", which would hide a missing or malformed server secret.
function requireTokenKey(): string {
  const v = (Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY") || "").trim();
  let bytes = 0;
  try { bytes = atob(v).length; } catch { /* malformed base64 */ }
  if (![16, 24, 32].includes(bytes)) {
    console.error("email-send config: INTEL_TOKEN_ENCRYPTION_KEY is missing or not a base64 AES key", JSON.stringify({ present: v.length > 0 }));
    throw new Error("Server credential key is not configured correctly");
  }
  return v;
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const service = createClient(supabaseUrl, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const oauthDeps = {
  env: (name: string) => Deno.env.get(name), createClient, service,
  fetch: (url: string, init?: Record<string, unknown>) => fetch(url, init as RequestInit),
  encrypt: (value: string) => encryptText(value, requireTokenKey()),
  decrypt: (value: string) => decryptText(value, requireTokenKey()), now: () => Date.now(),
};

Deno.serve((req) =>
  handleSend(req, {
    env: (k) => Deno.env.get(k),
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
    store: makeSendStore(service),
    // The Gmail/Zoho adapters swallow token errors (the person only sees "check the connection"), so log the cause here.
    // Messages from the token gateway are fixed, user-safe strings; nothing secret is ever in them.
    getProviderAccessToken: async (account, operation) => {
      try {
        requireTokenKey();
        return await getSharedProviderAccessToken({
          accountId: account.id, organizationId: String(account.organization_id || ""),
          provider: account.provider as "gmail" | "zoho", operation,
        }, oauthDeps);
      } catch (e) {
        console.error("email-send token resolution failed:", String((e as Error)?.message || "error").slice(0, 200), JSON.stringify({ provider: account.provider, operation }));
        throw e;
      }
    },
    async authenticate(r) {
      const m = /^Bearer\s+(\S+)$/i.exec(r.headers.get("Authorization") || "");
      if (!m) return { ok: false, status: 401, error: "Not authenticated" };
      // The caller's own JWT with the project's public key (anon / publishable): auth.uid() and the access check see the real person, never the service role.
      const user = createClient(supabaseUrl, getSupabasePublicKey(), {
        global: { headers: { Authorization: `Bearer ${m[1]}` } }, auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: u, error } = await user.auth.getUser(m[1]);
      // A rejected token is a 401. A network or server failure is not the person's fault: throw so it is a logged 500, not a false 401/403.
      const authStatus = (error as { status?: number } | null)?.status ?? 0;
      if (error && (authStatus === 0 || authStatus >= 500)) throw new Error("Session check unavailable");
      if (error || !u?.user?.id) return { ok: false, status: 401, error: "Not authenticated" };
      const { data: allowed, error: accessErr } = await user.rpc("email_has_access");
      if (accessErr) throw new Error("Access check unavailable");
      if (allowed !== true) return { ok: false, status: 403, error: "Email is restricted." };
      const { data: org, error: orgErr } = await user.rpc("email_require_access");
      if (orgErr) throw new Error("Access check unavailable");
      if (!org) return { ok: false, status: 403, error: "Email is restricted." };
      return { ok: true, userId: u.user.id, organizationId: String(org) };
    },
  })
);
