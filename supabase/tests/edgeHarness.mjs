// Test harness that EXECUTES the Deno Edge Functions under Node (no Deno available here).
// A module-resolution hook swaps the three non-portable imports (esm.sh supabase-js, crypto.ts, final_qc.ts) for scriptable fakes;
// everything else (the function itself, google.ts, upload_recovery.ts, upload_sessions.ts, cors.ts) is the real source.
import { register } from "node:module";

const hooks = `
const FAKES = {
  "https://esm.sh/@supabase/supabase-js@2.45.0": "export const createClient = (...a) => globalThis.__edge.createClient(...a);",
  "crypto.ts": "export const decryptText = async () => 'refresh-token-1'; export const encryptText = async (t) => t;",
  "final_qc.ts": "export const cleanFolderName = (t, f) => (t || f); export const ensureFinalQcFolders = (...a) => globalThis.__edge.ensureFolders(...a);",
};
export async function resolve(specifier, context, next) {
  for (const [k, v] of Object.entries(FAKES)) if (specifier === k || (k.endsWith('.ts') && specifier.endsWith('/_shared/' + k))) return { url: 'edge-fake:' + encodeURIComponent(k), shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('edge-fake:')) return { format: 'module', source: FAKES[decodeURIComponent(url.slice(10))], shortCircuit: true };
  return next(url, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);

/** Chainable, thenable query builder; `handler(table, ops)` returns {data, error}. */
function builder(edge, table) {
  const ops = { table, method: "select", filters: [], payload: null, single: false };
  const q = {
    select() { return q; },
    update(payload) { ops.method = "update"; ops.payload = payload; return q; },
    insert(payload) { ops.method = "insert"; ops.payload = payload; return q; },
    eq(c, v) { ops.filters.push(["eq", c, v]); return q; },
    is(c, v) { ops.filters.push(["is", c, v]); return q; },
    or(expr) { ops.filters.push(["or", expr]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle() { ops.single = true; return q; },
    then(resolve, reject) {
      let out = edge.handler(table, ops) || { data: null, error: null };
      if (ops.single && Array.isArray(out.data)) out = { ...out, data: out.data[0] ?? null };
      return Promise.resolve({ error: null, ...out }).then(resolve, reject);
    },
  };
  return q;
}

export function installEdgeEnvironment(env = {}) {
  const edge = {
    handler: () => ({ data: null, error: null }),
    rpcs: [],
    rpcHandler: () => ({ data: null, error: null }),
    foldersCalls: 0,
    user: { id: "user-1" },
    createClient() {
      return {
        from: (table) => builder(edge, table),
        rpc: async (name, args) => { edge.rpcs.push({ name, args }); return { error: null, data: null, ...(edge.rpcHandler(name, args) || {}) }; },
        auth: { getUser: async () => ({ data: { user: edge.user }, error: null }) },
      };
    },
    ensureFolders: async () => { edge.foldersCalls++; return { projectFolderId: "projfolder1", cutFolderId: "cutfolder12" }; },
    served: null,
  };
  globalThis.__edge = edge;
  const vars = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc", SUPABASE_ANON_KEY: "anon", DRIVE_TOKEN_ENCRYPTION_KEY: "k", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", ...env };
  globalThis.Deno = { env: { get: (k) => vars[k] }, serve: (fn) => { edge.served = fn; } };
  return edge;
}

/** Scriptable Google: OAuth, Drive metadata, listing, resumable session, permissions, trash. */
export function installGoogle(script = {}) {
  const g = { calls: [], tokenCalls: 0, meta: script.meta || {}, list: script.list || [], permissionStatus: script.permissionStatus ?? 200 };
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    g.calls.push({ url, method: init.method || "GET", body: init.body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) { g.tokenCalls++; return Response.json({ access_token: "access-1", expires_in: 3600 }); }
    if (url.includes("/upload/drive/v3/files") && url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://upload.example/session-1" } });
    if (/\/permissions/.test(url)) return new Response("{}", { status: g.permissionStatus });
    if ((init.method || "GET") === "PATCH") return Response.json({ id: "x" });
    const metaMatch = /\/drive\/v3\/files\/([^/?]+)\?/.exec(url);
    if (metaMatch) return g.meta[metaMatch[1]] ? Response.json(g.meta[metaMatch[1]]) : new Response("{}", { status: 404 });
    if (/\/drive\/v3\/files\?q=/.test(url)) return Response.json({ files: typeof g.list === "function" ? g.list(decodeURIComponent(url)) : g.list });
    throw new Error("unexpected fetch " + url);
  };
  g.restore = () => { globalThis.fetch = orig; };
  return g;
}

export const post = (body, headers = {}) => new Request("https://fn.example/", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://portal.example", ...headers }, body: JSON.stringify(body) });

const handlers = new Map();
/** Imports an Edge Function once (Deno.serve registers a handler at import time) and returns its handler.
 * The handler reads Deno/env/db at CALL time, so later installEdgeEnvironment() calls re-script it. */
export async function loadFunction(path) {
  if (!handlers.has(path)) {
    const edge = globalThis.__edge; edge.served = null;
    await import(path);
    if (!edge.served) throw new Error("function did not call Deno.serve: " + path);
    handlers.set(path, edge.served);
  }
  return handlers.get(path);
}
