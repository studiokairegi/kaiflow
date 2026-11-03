// intel-zoho-token: thin wiring only. All logic and authorization live in ../_shared/intel_zoho_logic.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText, decryptText } from "../_shared/crypto.ts";
import { handleToken } from "../_shared/intel_zoho_logic.ts";

const key = () => Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY")!;   // a NEW secret: do not reuse the Drive key

Deno.serve((req) =>
  handleToken(req, {
    env: (k) => Deno.env.get(k),
    createClient,
    service: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
    fetch: (url, init) => fetch(url, init as RequestInit),
    encrypt: (s) => encryptText(s, key()),
    decrypt: (s) => decryptText(s, key()),
    now: () => Date.now(),
  })
);
