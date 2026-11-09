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
  requeueJob: (s, id) => call(s, "intel_admin_requeue_job", { p_job_id: id }),
  markProspectForReview: (s, id) => call(s, "intel_admin_mark_prospect_review", { p_prospect_id: id }),
  reviewProspect: (s, id, action, leadId) => call(s, "intel_admin_review_prospect", { p_prospect_id: id, p_action: action, p_lead_id: leadId || null }),
  reviewMessage: (s, id, action, subject, body) => call(s, "intel_admin_review_message", { p_message_id: id, p_action: action, p_subject: subject ?? null, p_body: body ?? null }),
  resolveUnknown: (s, id, outcome) => call(s, "intel_admin_resolve_unknown", { p_message_id: id, p_outcome: outcome }),
  composeReply: (s, prospectId, subject, body) => call(s, "intel_admin_compose_reply", { p_prospect_id: prospectId, p_subject: subject, p_body: body }),
  composeLeadMessage: (s, leadId, subject, body) => call(s, "intel_admin_compose_lead_message", { p_lead_id: leadId, p_subject: subject, p_body: body }),
  addSuppression: (s, value, reason) => call(s, "intel_admin_add_suppression", { p_value: value, p_reason: reason || "" }),
  removeSuppression: (s, id) => call(s, "intel_admin_remove_suppression", { p_id: id }),
  upsertKb: (s, k) => call(s, "intel_admin_upsert_kb", { p_key: k.key, p_kind: k.kind, p_title: k.title, p_body: k.body }),
  approveKb: (s, key, approved) => call(s, "intel_admin_approve_kb", { p_key: key, p_approved: approved }),

  disconnectMail: (s) => call(s, "intel_admin_disconnect_mail"),
  providerCatalog: (s) => call(s, "intel_admin_provider_catalog"),
  providerAccounts: (s) => call(s, "intel_admin_provider_accounts"),
  checkProviderHealth: async (s, accountId) => {
    const { data, error } = await s.functions.invoke("intel-provider-health", {
      body: { account_id: accountId },
    });
    if (error) throw new Error(error.message || "Could not check provider health");
    return data || { ok: false, error: "Health check returned no result." };
  },
  updateProviderAccount: (s, id, patch) => call(s, "intel_admin_update_provider_account", { p_account_id: id, p_patch: patch }),
  disconnectProviderAccount: (s, id) => call(s, "intel_admin_disconnect_provider_account", { p_account_id: id }),
  setContactPermission: (s, a) => call(s, "intel_admin_set_contact_permission", { p_email: a.email, p_purpose: a.purpose, p_evidence_type: a.evidenceType, p_evidence_reference: a.evidenceReference || "", p_granted: a.granted !== false }),
  updateSource: (s, key, patch) => call(s, "intel_admin_update_source", { p_key: key, p_enabled: patch.enabled ?? null, p_tos_status: patch.tosStatus ?? null, p_daily_budget: patch.dailyBudget ?? null }),
  setProfile: (s, type, p) => call(s, "intel_admin_set_profile", { p_type: type, p_description: p.description, p_terms_en: p.termsEn, p_terms_ja: p.termsJa, p_exclude: p.exclude }),
  approveProfile: (s, type, approved) => call(s, "intel_admin_approve_profile", { p_type: type, p_approved: approved }),
  addManualPost: (s, type, url, text) => call(s, "intel_admin_add_manual_post", { p_type: type, p_url: url || "", p_text: text || "" }),
  discoveryStats: (s) => call(s, "intel_admin_discovery_stats"),
  reevalStart: (s, a) => call(s, "intel_admin_reeval_start", {
    p_name: a.name, p_limit: a.limit ?? null, p_dry_run: a.dryRun ?? true,
    p_include_previous: false, p_all: a.all ?? false, p_expect_count: a.expectCount ?? null,
  }),
  reevalStatus: (s) => call(s, "intel_admin_reeval_status", { p_run_id: null }),
  phase6ScoreAudit: (s) => call(s, "intel_admin_phase6_score_audit", {}),
  reevalCancel: (s, runId) => call(s, "intel_admin_reeval_cancel", { p_run_id: runId }),


  crmReview: (s, limit = 400) => call(s, "intel_admin_crm_review", { p_limit: limit }),
  crmAdopt: (s, ids, type) => call(s, "intel_admin_crm_adopt", { p_lead_ids: ids, p_type: type }),
  // Phase 1: take over an existing CRM lead from a pasted conversation. Nothing here sends email; drafts wait for approval.
  crmImportHistory: (s, a) => call(s, "intel_admin_crm_import_history", { p_lead_id: a.leadId, p_type: a.type, p_entries: a.entries, p_raw: a.raw || "", p_last_contact: a.lastContact, p_source_email: a.sourceEmail || "" }),
  crmRemoveHistory: (s, historyId) => call(s, "intel_admin_crm_remove_history", { p_history_id: historyId }),
  crmTakeoverRefresh: (s, leadId) => call(s, "intel_admin_crm_takeover_refresh", { p_lead_id: leadId }),
  crmIntroduce: (s, ids, type) => call(s, "intel_admin_crm_introduce", { p_lead_ids: ids, p_type: type }),
  crmHistory: (s, leadId) => read(s.from("intel_lead_history").select("id,entries,last_contact,source_email,created_at").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(20)),
  takeoverStates: (s) => read(s.from("intel_prospects").select("id,lead_id,type,status,takeover").not("lead_id", "is", null).not("takeover->>state", "is", null).limit(1000)),
  chatNewThread: (s, title) => call(s, "intel_admin_chat_new_thread", { p_title: title || "New chat" }),
  chatSend: (s, threadId, text, clientKey) => call(s, "intel_admin_chat_send", { p_thread_id: threadId, p_text: text, p_client_key: clientKey }),
  chatThreads: (s) => read(s.from("intel_chat_threads").select("id,title,updated_at").order("updated_at", { ascending: false }).limit(30)),
  chatMessages: (s, threadId) => read(s.from("intel_chat_messages").select("id,role,content,status,tool_name,reply_to,created_at").eq("thread_id", threadId).order("id").limit(300)),

  chatActions: (s, threadId) => read(s.from("intel_chat_actions").select("id,message_id,tool,summary,status,result,created_at,expires_at").eq("thread_id", threadId).order("created_at").limit(100)),
  chatConfirm: (s, actionId) => call(s, "intel_admin_chat_confirm", { p_action_id: actionId }),
  chatCancel: (s, actionId) => call(s, "intel_admin_chat_cancel", { p_action_id: actionId }),

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
  sources: (s) => read(s.from("intel_sources").select("*").order("key")),
  sourceItems: (s) => read(s.from("intel_source_items").select("id,source_key,item_type,url,title,snippet,prospect_id,meta,last_seen").order("last_seen", { ascending: false }).limit(60)),
};
