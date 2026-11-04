// intel-gmail-token: thin wiring only. All logic and authorization live in ../_shared/intel_gmail_logic.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptText, decryptText } from "../_shared/crypto.ts";
import { handleToken } from "../_shared/intel_gmail_logic.ts";
import { providerPausedResponse } from "../_shared/provider_guard.ts";

// PAUSED by flag (public.email_provider_flags): every request is refused with 410 until the flag is turned back on.
const pauseGuard = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const key = () => Deno.env.get("INTEL_TOKEN_ENCRYPTION_KEY")!;   // a NEW secret: do not reuse the Drive key

Deno.serve(async (req) =>
  (await providerPausedResponse(pauseGuard, "gmail")) ?? handleToken(req, {
    env: (k) => Deno.env.get(k),
    createClient,
    service: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
    fetch: (url, init) => fetch(url, init as RequestInit),
    encrypt: (s) => encryptText(s, key()),
    decrypt: (s) => decryptText(s, key()),
    now: () => Date.now(),
  })
);
