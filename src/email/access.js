// General Email access. Independent from KairFlow Intelligence: the database decides in public.email_has_access(); this file only asks
// it and fails closed. Hiding the tab is a convenience, never the control: every email_* table and RPC enforces the rule itself.
// States: null = not checked yet (treated as denied), true = allowed, false = denied.

/** Only a literal boolean true opens Email. */
export function canAccessEmail(access) {
  return access === true;
}

/** Asks the database. `supabase` is injected so this is unit tested without a network. Any error or non-true answer resolves to false. */
export async function loadEmailAccess(supabase, userId) {
  if (!supabase || !userId) return false;
  try {
    const { data, error } = await supabase.rpc("email_has_access");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Tells the database which studio the person is working in, so every email_* function (and the email-send function) uses it instead of
 *  guessing the first studio. Best effort: a failure keeps the previous server-side choice (the old behavior) and never blocks the Inbox. */
export async function syncActiveEmailOrganization(supabase, organizationId) {
  const id = typeof organizationId === "string" ? organizationId.trim() : "";
  if (!supabase || !id) return false;
  try {
    const { error } = await supabase.rpc("email_set_active_organization", { p_organization_id: id });
    return !error;
  } catch {
    return false;
  }
}
