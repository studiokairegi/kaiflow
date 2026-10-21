// Short-lived signed media tickets (HMAC-SHA256) for the portfolio-media endpoint. <img>/<video>
// can't send an Authorization header, so the URL itself carries a ticket. A ticket grants nothing on
// its own: the media endpoint re-checks the database on EVERY request (link still active, item still
// exists), so revoking a link stops playback immediately even though the ticket has not expired.
export type MediaTicket = { i: string; l: string | null; u: string | null; exp: number }; // item, link (public), owner (preview), expiry (epoch s)

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromB64url = (s: string) => { const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4)); const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const key = (secret: string, usage: KeyUsage[]) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

export async function signMediaTicket(p: MediaTicket, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)));
  const sig = await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyMediaTicket(ticket: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<MediaTicket | null> {
  const parts = String(ticket || "").split(".");
  if (parts.length !== 2) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), fromB64url(parts[1]), enc.encode(parts[0])))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (typeof p.i !== "string" || typeof p.exp !== "number" || p.exp <= nowSeconds) return null;
    if (!((typeof p.l === "string") !== (typeof p.u === "string"))) return null;   // exactly one of link / owner
    return { i: p.i, l: p.l ?? null, u: p.u ?? null, exp: p.exp };
  } catch { return null; }
}
