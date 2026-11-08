/**
 * Build an anonymous rate-limit subject from the platform-authenticated client IP.
 * Supabase Edge Functions run behind Cloudflare, which overwrites CF-Connecting-IP.
 * Never trust X-Forwarded-For here: callers can supply it themselves.
 * A missing platform IP or missing/weak pepper is a configuration failure; callers
 * must fail closed instead of collapsing every request into one shared bucket.
 */
export async function rateLimitIpHash(req: Request, pepper: string | undefined): Promise<string | null> {
  const secret = (pepper || "").trim();
  if (secret.length < 32) return null;

  const clientIp = (req.headers.get("cf-connecting-ip") || "").trim();
  // CF-Connecting-IP is a single address, never a comma-separated proxy chain.
  // Bound the value before hashing; the platform is responsible for IP parsing.
  if (!clientIp || clientIp.length > 64 || clientIp.includes(",") || /\s/.test(clientIp)) return null;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}|${clientIp}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
