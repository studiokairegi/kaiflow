// resend-webhook: thin wiring only. Public endpoint: every request is rejected unless its Svix signature verifies
// (see verifySvixSignature in ../_shared/email_resend_logic.ts). Deploy with --no-verify-jwt because Resend sends no Supabase JWT.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleWebhook } from "../_shared/email_resend_logic.ts";
import { makeWebhookStore } from "../_shared/email_resend_store.ts";
import { makeIntelDeliverySink } from "../_shared/intel_resend_delivery_sink.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve((req) =>
  handleWebhook(req, {
    env: (k) => Deno.env.get(k),
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
    // Intelligence plugs its own delivery sink in here; the general Email store itself has no Intelligence code.
    store: { ...makeWebhookStore(service), applyIntelDeliveryEvent: makeIntelDeliverySink(service) },
  })
);
