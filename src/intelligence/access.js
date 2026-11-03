// KairFlow Intelligence access. The ONLY rule: the signed-in user is an administrator
// (user_settings.is_admin) AND holds an active Master User membership. The database decides, in
// public.intel_is_authorized(); this file only asks it and fails closed. Hiding the tab is a
// convenience, never the control: every Intelligence table and RPC enforces the same rule itself.
//
// States: null = not checked yet (treated as denied), true = allowed, false = denied.

/** Only a literal boolean true opens Intelligence. */
export function canAccessIntelligence(access) {
  return access === true;
}

/**
 * Asks the database. `supabase` is injected so this is unit tested without a network.
 * Any error, missing client, missing user or non-true answer resolves to false.
 */
export async function loadIntelligenceAccess(supabase, userId) {
  if (!supabase || !userId) return false;
  try {
    const { data, error } = await supabase.rpc("intel_is_authorized");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** The workspace key to show: Intelligence only when allowed, otherwise the dashboard. */
export function guardIntelligenceWorkspace(workspace, access) {
  return workspace === "intelligence" && !canAccessIntelligence(access) ? "dashboard" : workspace;
}
