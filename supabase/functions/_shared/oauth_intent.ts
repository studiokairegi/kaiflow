// Shared helper for the OAuth connect-intent mechanism used by
// google-drive-connect/callback and patreon-connect/callback. See
// migration_oauth_intents.sql for why this exists: it replaces a bare
// access token in a URL and a non-expiring, replayable signed state with
// a short-lived, single-use, DB-backed nonce.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const INTENT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// Called by google-drive-connect / patreon-connect right before
// redirecting to the provider's consent screen. Succeeds at most once per
// intent - marks it "redirected" so this same id can't be used to start a
// second redirect - and returns the user id it was issued for, or null if
// the intent doesn't exist, is for the wrong provider, already started a
// redirect, or is older than the TTL.
export async function consumeIntentForRedirect(intentId: string, provider: string): Promise<string | null> {
  const supabase = serviceClient();
  const { data: intent } = await supabase
    .from("oauth_connect_intents")
    .select("user_id, provider, created_at, redirected_at")
    .eq("id", intentId)
    .maybeSingle();
  if (!intent || intent.provider !== provider || intent.redirected_at) return null;
  if (Date.now() - new Date(intent.created_at).getTime() > INTENT_TTL_MS) return null;

  const { data: updated, error } = await supabase
    .from("oauth_connect_intents")
    .update({ redirected_at: new Date().toISOString() })
    .eq("id", intentId)
    .is("redirected_at", null)
    .select("user_id")
    .maybeSingle();
  if (error || !updated) return null;
  return updated.user_id;
}

// Called by the provider's callback with state=<intentId>. Succeeds at
// most once per intent - this is what makes the state genuinely one-time,
// unlike a bare signature that stays valid forever and can be replayed.
export async function consumeIntentForCallback(intentId: string, provider: string): Promise<string | null> {
  const supabase = serviceClient();
  const { data: intent } = await supabase
    .from("oauth_connect_intents")
    .select("user_id, provider, redirected_at, completed_at")
    .eq("id", intentId)
    .maybeSingle();
  if (!intent || intent.provider !== provider || !intent.redirected_at || intent.completed_at) return null;
  if (Date.now() - new Date(intent.redirected_at).getTime() > INTENT_TTL_MS) return null;

  const { data: updated, error } = await supabase
    .from("oauth_connect_intents")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", intentId)
    .is("completed_at", null)
    .select("user_id")
    .maybeSingle();
  if (error || !updated) return null;
  return updated.user_id;
}
