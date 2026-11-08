// KairFlow's Edge Functions are intentionally callable from browser clients and public
// capability-link viewers. The wildcard is safe only because this policy does NOT allow
// credentialed cookies; every privileged endpoint must still validate its own bearer JWT,
// signed capability ticket, one-time OAuth state or webhook signature before service-role work.
// CORS is a browser read policy, never an authentication or authorization control.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
