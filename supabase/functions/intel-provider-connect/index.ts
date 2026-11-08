import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText, decryptText } from "../_shared/crypto.ts";
import { handleProviderConnect } from "../_shared/intel_provider_oauth.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const key = () => Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY")!;
Deno.serve((req) => handleProviderConnect(req, {
  env: (name) => Deno.env.get(name), createClient, service,
  fetch: (url, init) => fetch(url, init as RequestInit),
  encrypt: (value) => encryptText(value, key()), decrypt: (value) => decryptText(value, key()), now: () => Date.now(),
}));
