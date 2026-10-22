// Turns an UPSTREAM media response (Google Drive, or the legacy Supabase Storage bucket) into the response
// sent to the browser. Pure (no Deno globals, no network of its own: the upstream fetch is injected) so it is
// unit-tested with node.
//
// The rule: a `206` is only ever emitted when the upstream response genuinely IS the requested byte range.
// If upstream ignored the Range header (200), answered a different range, or its length headers disagree with
// what we know about the file, we fail with a 502 instead of sending misleading partial-content headers. The
// body is never buffered: it is piped through a byte counter so a truncated/oversized upstream stream errors
// out instead of silently delivering a corrupt file.
import type { RangeResult } from "./range.ts";
import { kindFromMime } from "./validate.ts";

export type ServeOptions = {
  size: number;                                            // known file size (DB), bytes
  mimeType?: string | null;                                // DB mime type (only allowed media types are echoed back)
  range: RangeResult;                                      // parseRange() result for the incoming request
  baseHeaders: Record<string, string>;                     // CORS headers
  // `range` is an HTTP Range value, e.g. "bytes=0-99". `signal` aborts the upstream request/body (timeouts, client gone).
  fetchUpstream: (range?: string, signal?: AbortSignal) => Promise<Response>;
  limits?: Partial<Limits>;
};

// Bounds on how long one response may hold an Edge Function invocation and an upstream connection.
export type Limits = {
  headerMs: number;   // waiting for upstream to start answering
  idleMs: number;     // longest gap between upstream chunks while the client is reading
  totalMs: number;    // whole response, however slowly the client reads (ranged responses are <= 16 MB)
};
export const DEFAULT_LIMITS: Limits = { headerMs: 20_000, idleMs: 30_000, totalMs: 300_000 };

const json = (base: Record<string, string>, status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...base, "Content-Type": "application/json", "Cache-Control": "no-store" } });

// "bytes 0-99/1000" -> { start, end, total }.  total is null for "*" (unknown).
export function parseContentRange(h: string | null | undefined): { start: number; end: number; total: number | null } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(h ?? "").trim());
  if (!m) return null;
  const start = Number(m[1]); const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end, total: m[3] === "*" ? null : Number(m[3]) };
}

// Streams `body` through, erroring the stream if it delivers more or fewer than `expected` bytes.
export function guardLength(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const room = expected - seen;
      if (chunk.byteLength > room) {
        if (room > 0) controller.enqueue(chunk.subarray(0, room));
        seen = expected;
        controller.error(new Error("upstream sent more bytes than expected"));
        return;
      }
      seen += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== expected) controller.error(new Error("upstream ended before the expected length"));
    },
  }));
}

// Errors the stream (and aborts upstream) when upstream stalls for `idleMs` or the whole response exceeds
// `totalMs`. Pull-based, so a slow client applies backpressure instead of buffering; cancelling the response
// cancels upstream.
export function withTimeouts(body: ReadableStream<Uint8Array>, limits: Pick<Limits, "idleMs" | "totalMs">, abort: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (total !== undefined) clearTimeout(total); total = undefined; };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      total = setTimeout(() => { abort(); reader.cancel().catch(() => {}); try { controller.error(new Error("media response exceeded its time limit")); } catch { /* closed */ } }, limits.totalMs);
      (total as unknown as { unref?: () => void }).unref?.();
    },
    async pull(controller) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => { idle = setTimeout(() => reject(new Error("upstream stalled")), limits.idleMs); });
      try {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) { stop(); controller.close(); } else controller.enqueue(value);
      } catch (e) {
        stop(); abort(); reader.cancel().catch(() => {}); controller.error(e);
      } finally { clearTimeout(idle); }
    },
    cancel(reason) { stop(); abort(); return reader.cancel(reason).catch(() => {}); },
  });
}

export async function serveMedia(o: ServeOptions): Promise<Response> {
  const { size, range, baseHeaders } = o;
  // Without a trustworthy stored size we cannot validate (or honestly describe) any response.
  if (!Number.isSafeInteger(size) || size <= 0) return json(baseHeaders, 404, "file_missing");
  if (range.status === 416) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length" } });
  }
  const partial = range.status === 206;

  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const ac = new AbortController();
  let res: Response;
  const headerTimer = setTimeout(() => ac.abort(), limits.headerMs);
  try { res = await o.fetchUpstream(partial ? `bytes=${range.start}-${range.end}` : undefined, ac.signal); }
  catch { console.error("portfolio-media: upstream fetch failed or timed out"); return json(baseHeaders, 502, "media_unavailable"); }
  finally { clearTimeout(headerTimer); }

  const drop = () => { try { void res.body?.cancel(); } catch { /* already closed */ } };
  const bad = (why: string) => { drop(); console.error(`portfolio-media: rejected upstream response (${why}; upstream status ${res.status})`); return json(baseHeaders, 502, "media_unavailable"); };

  if (res.status === 404) { drop(); return json(baseHeaders, 404, "file_missing"); }
  if (res.status !== (partial ? 206 : 200)) return bad(partial ? "range request not answered with 206" : "unexpected status");
  if (!res.body) return bad("empty body");
  // A transformed (compressed) body would make every length check meaningless.
  const enc = (res.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  if (enc !== "identity" && enc !== "") return bad("upstream applied a content encoding");

  let length: number;
  if (partial) {
    const cr = parseContentRange(res.headers.get("Content-Range"));
    if (!cr) return bad("missing or malformed Content-Range");
    if (cr.start !== range.start || cr.end !== range.end) return bad("Content-Range is not the requested range");
    if (cr.total !== size) return bad("Content-Range total differs from the known file size");
    length = range.end - range.start + 1;
  } else {
    length = size;
  }
  const declared = res.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) return bad("Content-Length does not match the expected length");

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    // Only echo a stored type that is an allowed portfolio media type; anything else is served as opaque bytes.
    "Content-Type": o.mimeType && kindFromMime(o.mimeType) ? o.mimeType : "application/octet-stream",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Length": String(length),
  };
  if (partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(guardLength(withTimeouts(res.body, limits, () => ac.abort()), length), { status: partial ? 206 : 200, headers });
}

// Legacy (pre-Drive) items live in the private 'portfolio' Storage bucket under "<user_id>/...". Returns the
// service-role REST URL to stream the object from, or null when the stored path is not a safe path inside the
// item owner's own folder. Streaming through here (instead of handing out a Storage signed URL) means a
// revoked/expired link is re-checked on every request and no separately-valid URL ever leaves the function.
export function legacyStorageUrl(supabaseUrl: string, ownerId: string, storagePath: unknown): string | null {
  if (typeof storagePath !== "string" || !supabaseUrl || !ownerId) return null;
  const parts = storagePath.split("/");
  if (parts[0] !== ownerId || parts.length < 2) return null;
  if (parts.some((p) => p === "" || p === "." || p === ".." || /[\\\u0000-\u001f]/.test(p))) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/authenticated/portfolio/${parts.map(encodeURIComponent).join("/")}`;
}

// One 1-byte request to learn whether an upstream really answers Range requests (206 + matching Content-Range).
// "unknown" (network error, odd status) is never treated as a verdict.
export async function probeRangeSupport(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<"supported" | "unsupported" | "unknown"> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { ...headers, Range: "bytes=0-0", "Accept-Encoding": "identity" } });
    void res.body?.cancel();
    if (res.status === 206 && /^bytes 0-0\/\d+$/.test(res.headers.get("Content-Range") ?? "")) return "supported";
    return res.status === 200 ? "unsupported" : "unknown";
  } catch { return "unknown"; }
}
