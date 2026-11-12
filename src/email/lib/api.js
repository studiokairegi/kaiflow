// Thin wrappers for KairFlow Email. Reads and writes go through email_* database functions that each re-check access;
// sending goes through the email-send Edge Function (the Resend key never reaches the browser).
async function call(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) throw new Error(error.message || `${name} failed`);
  return data;
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(new Error(`Could not read ${file.name}`));
  r.readAsDataURL(file);
});

export const emailApi = {
  accounts: (s) => call(s, "email_list_accounts"),
  providers: (s) => call(s, "email_provider_registry_list"),
  list: (s, folder, search, accountId = null, provider = null, limit = 50) => call(s, "email_list_conversations", { p_folder: folder, p_search: search || null, p_limit: Math.min(Math.max(Number(limit) || 50, 1), 500), p_offset: 0, p_account_id: accountId || null, p_provider: provider || null }),
  get: (s, id) => call(s, "email_get_conversation", { p_conversation_id: id }),
  markRead: (s, id, read) => call(s, "email_mark_read", { p_conversation_id: id, p_read: read }),
  archive: (s, id, archived) => call(s, "email_set_archived", { p_conversation_id: id, p_archived: archived }),
  linkLead: (s, id, leadId) => call(s, "email_link_lead", { p_conversation_id: id, p_lead_id: leadId || null }),
  unreadTotal: (s) => call(s, "email_unread_total"),
  providerFlags: (s) => call(s, "email_provider_flags_get"),
  saveDraft: (s, d) => call(s, "email_save_draft", { p_draft_id: d.draftId || null, p_conversation_id: d.conversationId || null, p_account_id: d.accountId, p_to: d.to, p_cc: d.cc, p_bcc: d.bcc, p_subject: d.subject, p_body_text: d.text, p_body_html: d.html || "", p_crm_lead_id: d.crmLeadId || null }),
  deleteDraft: (s, id) => call(s, "email_delete_draft", { p_draft_id: id }),
  async send(s, m) {
    const attachments = [];
    for (const f of m.files || []) attachments.push({ filename: f.name, content_type: f.type || "application/octet-stream", content_base64: await toBase64(f) });
    const { data, error } = await s.functions.invoke("email-send", { body: {
      account_id: m.accountId, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, text: m.text, html: m.html, conversation_id: m.conversationId || null,
      draft_id: m.draftId || null, idempotency_key: m.key, attachments, crm: m.crmLeadId ? { lead_id: m.crmLeadId } : null,
    } });
    // functions.invoke hides the body of non-2xx answers inside error.context: surface the server's own message.
    const sendError = (payload, fallback) => {
      const e = new Error(payload?.error || fallback || "Could not send");
      e.outcome = payload?.outcome;
      e.code = payload?.code;
      e.retry_with_same_key = payload?.retry_with_same_key;
      e.message_id = payload?.message_id;
      e.duplicate = payload?.duplicate === true;
      return e;
    };
    if (error) {
      let payload = null;
      try { payload = await error.context?.json?.(); } catch { /* transport response may have no readable body */ }
      throw sendError(payload, error.message);
    }
    if (data && data.ok === false) throw sendError(data, "Could not send");
    return data;
  },
  async attachmentUrl(s, path) {
    const { data, error } = await s.storage.from("email-attachments").createSignedUrl(path, 60);
    if (error) throw new Error(error.message || "Could not open the attachment");
    return data.signedUrl;
  },
};
