// Authorizes the CALLER of an Intelligence Edge Function. Use before any service-role work:
// the service-role key bypasses RLS, so this check is the only thing standing between a request
// and privileged access.
//
//   const auth = await requireIntelligenceAdmin(req, { createClient, url, anonKey });
//   if (!auth.ok) return json({ error: auth.error }, auth.status);
//
// The decision is made by the database function public.intel_is_authorized() running under the
// caller's own JWT, so it cannot be influenced by anything in the request body, query string,
// headers other than the bearer token, or a client-supplied user id or admin flag.

export type IntelAuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 | 500; error: string };

export interface IntelAuthDeps {
  // createClient from @supabase/supabase-js (injected so this is testable without a network)
  createClient: (url: string, key: string, options?: Record<string, unknown>) => any;
  url: string | undefined;
  anonKey: string | undefined;
}

export async function requireIntelligenceAdmin(req: Request, deps: IntelAuthDeps): Promise<IntelAuthResult> {
  try {
    const header = req.headers.get("Authorization") || "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return { ok: false, status: 401, error: "Not authenticated" };
    if (!deps.url || !deps.anonKey) return { ok: false, status: 500, error: "Authorization is not configured" };

    // ANON key + the caller's JWT: RLS and auth.uid() see the real user. Never the service-role key.
    const userClient = deps.createClient(deps.url, deps.anonKey, {
      global: { headers: { Authorization: `Bearer ${match[1]}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser(match[1]);
    const userId = userData?.user?.id;
    if (userError || !userId) return { ok: false, status: 401, error: "Not authenticated" };

    const { data: allowed, error: rpcError } = await userClient.rpc("intel_is_authorized");
    if (rpcError) return { ok: false, status: 403, error: "KairFlow Intelligence is restricted." };
    if (allowed !== true) return { ok: false, status: 403, error: "KairFlow Intelligence is restricted." };
    return { ok: true, userId };
  } catch {
    return { ok: false, status: 403, error: "KairFlow Intelligence is restricted." };
  }
}
