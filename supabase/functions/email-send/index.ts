// email-send: thin wiring only. Logic, validation and limits live in ../_shared/email_resend_logic.ts.
// Signed-in person only (admin + active Master User, the same rule as Intelligence); the Resend key never leaves the server.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleSend } from "../_shared/email_resend_logic.ts";
import { makeSendStore } from "../_shared/email_resend_store.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve((req) =>
  handleSend(req, {
    env: (k) => Deno.env.get(k),
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
    store: makeSendStore(service),
    async authenticate(r) {
      const m = /^Bearer\s+(\S+)$/i.exec(r.headers.get("Authorization") || "");
      if (!m) return { ok: false, status: 401, error: "Not authenticated" };
      // The caller's own JWT with the ANON key: auth.uid() and the access check see the real person, never the service role.
      const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${m[1]}` } }, auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: u, error } = await user.auth.getUser(m[1]);
      if (error || !u?.user?.id) return { ok: false, status: 401, error: "Not authenticated" };
      const { data: allowed } = await user.rpc("email_has_access");
      if (allowed !== true) return { ok: false, status: 403, error: "Email is restricted." };
      const { data: org, error: orgErr } = await user.rpc("email_require_access");
      if (orgErr || !org) return { ok: false, status: 403, error: "Email is restricted." };
      return { ok: true, userId: u.user.id, organizationId: String(org) };
    },
  })
);
