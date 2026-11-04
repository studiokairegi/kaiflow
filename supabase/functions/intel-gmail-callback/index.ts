// intel-gmail-callback: thin wiring only. All logic and authorization live in ../_shared/intel_gmail_logic.ts.
// Deploy with --no-verify-jwt: Google's redirect carries no Supabase session. Trust comes from the single-use state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText, decryptText } from "../_shared/crypto.ts";
import { handleCallback } from "../_shared/intel_gmail_logic.ts";

const key = () => Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY")!;   // a NEW secret: do not reuse the Drive key

Deno.serve((req) =>
  handleCallback(req, {
    env: (k) => Deno.env.get(k),
    createClient,
    service: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
    fetch: (url, init) => fetch(url, init as RequestInit),
    encrypt: (s) => encryptText(s, key()),
    decrypt: (s) => decryptText(s, key()),
    now: () => Date.now(),
  })
);
