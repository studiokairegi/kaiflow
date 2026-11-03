// Thin wrappers over Supabase for Intelligence. Reads use the tables (row-level security allows them only for the
// authorized administrator). Every write goes through an intel_admin_* function that re-checks authorization itself.
async function call(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) throw new Error(error.message || `${name} failed`);
  return data;
}

async function read(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message || "Could not load data");
  return data || [];
}

export const intelApi = {
  overview: (s) => call(s, "intel_admin_overview"),
  mailStatus: (s) => call(s, "intel_admin_mail_status"),
  bootstrap: (s, a) => call(s, "intel_admin_bootstrap", { p_sender_name: a.senderName, p_sender_email: a.senderEmail, p_physical_address: a.physicalAddress, p_timezone: a.timezone }),
  updateSettings: (s, patch) => call(s, "intel_admin_update_settings", { p_patch: patch }),
  setKillSwitch: (s, on) => call(s, "intel_admin_set_kill_switch", { p_on: on }),
  registerAgent: (s, userId) => call(s, "intel_admin_register_agent", { p_agent_user_id: userId }),
  updateCampaign: (s, type, patch) => call(s, "intel_admin_update_campaign", { p_type: type, p_patch: patch }),
  enqueue: (s, kind, payload) => call(s, "intel_admin_enqueue_job", { p_kind: kind, p_payload: payload || {} }),
  reviewProspect: (s, id, action, leadId) => call(s, "intel_admin_review_prospect", { p_prospect_id: id, p_action: action, p_lead_id: leadId || null }),
  reviewMessage: (s, id, action, subject, body) => call(s, "intel_admin_review_message", { p_message_id: id, p_action: action, p_subject: subject ?? null, p_body: body ?? null }),
  resolveUnknown: (s, id, outcome) => call(s, "intel_admin_resolve_unknown", { p_message_id: id, p_outcome: outcome }),
  composeReply: (s, prospectId, subject, body) => call(s, "intel_admin_compose_reply", { p_prospect_id: prospectId, p_subject: subject, p_body: body }),
  addSuppression: (s, value, reason) => call(s, "intel_admin_add_suppression", { p_value: value, p_reason: reason || "" }),
  removeSuppression: (s, id) => call(s, "intel_admin_remove_suppression", { p_id: id }),
  upsertKb: (s, k) => call(s, "intel_admin_upsert_kb", { p_key: k.key, p_kind: k.kind, p_title: k.title, p_body: k.body }),
  approveKb: (s, key, approved) => call(s, "intel_admin_approve_kb", { p_key: key, p_approved: approved }),

  settings: async (s) => (await read(s.from("intel_settings").select("*").limit(1)))[0] || null,
  campaigns: (s) => read(s.from("intel_campaigns").select("*").order("type")),
  prospects: (s) => read(s.from("intel_prospects").select("*").order("updated_at", { ascending: false }).limit(500)),
  evidence: (s, prospectId) => read(s.from("intel_evidence").select("*").eq("prospect_id", prospectId).order("fetched_at")),
  messages: (s) => read(s.from("intel_messages").select("*").order("created_at", { ascending: false }).limit(800)),
  actions: (s) => read(s.from("intel_actions").select("*").order("id", { ascending: false }).limit(300)),
  jobs: (s) => read(s.from("intel_jobs").select("id,kind,state,attempts,max_attempts,last_error,run_after,updated_at").in("state", ["failed", "dead", "running", "queued"]).order("updated_at", { ascending: false }).limit(100)),
  kb: (s) => read(s.from("intel_kb").select("*").order("key")),
  suppressions: (s) => read(s.from("intel_suppressions").select("*").order("created_at", { ascending: false }).limit(500)),
  leadsFor: async (s, ids) => (ids.length ? read(s.from("leads").select("id,stage,source_kind,company_name").in("id", ids)) : []),
};
