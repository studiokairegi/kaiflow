// Temporary pause for the Gmail and Zoho mail providers. The flag lives in public.email_provider_flags (seeded OFF for both),
// so nothing is deleted: set enabled = true for a provider to bring its functions back. Fails closed: if the flag cannot be read
// (for example the migration has not been applied) the provider counts as paused.
import { corsHeaders } from "./cors.ts";

export async function providerPausedResponse(service: any, provider: "gmail" | "zoho"): Promise<Response | null> {
  let enabled = false;
  try {
    const { data, error } = await service.rpc("email_provider_enabled", { p_provider: provider });
    enabled = !error && data === true;
  } catch {
    enabled = false;
  }
  if (enabled) return null;
  return new Response(JSON.stringify({ error: `${provider === "gmail" ? "Gmail" : "Zoho Mail"} is paused. Email runs through Resend.`, paused: true }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
