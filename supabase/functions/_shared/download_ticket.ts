// Short-lived signed download tickets (HMAC-SHA256). A ticket only says
// "this exact version of this exact cut may be fetched until <exp>". It grants
// nothing on its own: the download endpoint re-checks the live database state
// (still released? sharing still on?) on every request, so withdrawing a
// release kills outstanding tickets immediately.

export type TicketPayload = { v: string; s: string; exp: number }; // version id, shot id, expiry (epoch seconds)

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

// Returns the payload, or null for anything malformed, tampered or expired.
export async function verifyTicket(
  ticket: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<TicketPayload | null> {
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      fromB64url(sig),
      enc.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TicketPayload;
    if (typeof payload.v !== "string" || typeof payload.s !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}
