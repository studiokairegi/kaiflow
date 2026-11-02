import { supabase, functionUrl } from "../supabaseClient";
import { ALLOWED_ATTACHMENT_TYPES, CHAT_PAGE_SIZE, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, validateMessage } from "./logic.js";

const throwIfError = (result, fallback = "Chat request failed.") => {
  if (result?.error) {
    const err = new Error(result.error.message || fallback);
    err.code = result.error.code;
    throw err;
  }
  return result?.data;
};

const ATTACHMENT_ERRORS = {
  unsupported_file_type: "That file type isn't supported.",
  file_too_large: "A file is too large (20 MB limit).",
  file_content_mismatch: "A file doesn't match its type and was rejected.",
  too_many_attachments: `Attach up to ${MAX_ATTACHMENTS} files at a time.`,
  drive_not_connected: "The studio's Google Drive isn't connected, so files can't be sent. Ask the studio owner to connect Drive.",
  drive_not_configured: "File storage isn't set up for this studio yet.",
  not_authorized: "You don't have permission to do that.",
  not_found: "That attachment is no longer available.",
  drive_download_failed: "The file couldn't be fetched from Drive. Try again shortly.",
};
const attachmentErrorText = (code) => ATTACHMENT_ERRORS[code] || "Attachments could not be sent. Please try again.";

const rpc = async (name, args) => throwIfError(await supabase.rpc(name, args), "Chat request failed.");
const MESSAGE_COLUMNS = "id, conversation_id, sender_user_id, body, reply_to_id, created_at, edited_at, deleted_at, chat_attachments(id, file_name, content_type, size_bytes, object_path, uploaded_by, created_at), chat_reactions(id, user_id, reaction, created_at), chat_pins(id, pinned_by, pinned_at)";

export const chatApi = {
  async memberships() {
    return (await rpc("chat_get_my_memberships")) || [];
  },
  async directory(organizationId) {
    return (await rpc("chat_list_directory", { p_organization_id: organizationId })) || [];
  },
  async departments(organizationId) {
    return (await rpc("chat_list_departments", { p_organization_id: organizationId })) || [];
  },
  async conversations(organizationId) {
    return (await rpc("chat_list_conversations", { p_organization_id: organizationId })) || [];
  },
  async projectOptions(organizationId) {
    return (await rpc("chat_list_project_options", { p_organization_id: organizationId })) || [];
  },
  async studioMembers(organizationId) {
    return (await rpc("chat_list_studio_members", { p_organization_id: organizationId })) || [];
  },
  async teamAccessLinks(organizationId) {
    return (await rpc("studio_list_team_access_links", { p_organization_id: organizationId })) || [];
  },
  async teamInvites(organizationId) {
    return (await rpc("studio_list_team_invites", { p_organization_id: organizationId })) || [];
  },
  async createTeamInvite({ organizationId, teamMemberId, departmentId = null, role, token }) {
    const rows = await rpc("studio_create_team_invite", {
      p_organization_id: organizationId, p_team_member_id: teamMemberId,
      p_department_id: departmentId, p_role: role, p_token: token,
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },
  async teamAccessOverview(organizationId) {
    return (await rpc("studio_team_access_overview", { p_organization_id: organizationId })) || [];
  },
  async setMemberDepartment(organizationId, teamMemberId, departmentId = null) {
    return rpc("studio_set_member_department", {
      p_organization_id: organizationId, p_team_member_id: teamMemberId, p_department_id: departmentId,
    });
  },
  async setMemberAccess(organizationId, teamMemberId, active) {
    return rpc("studio_set_member_access", {
      p_organization_id: organizationId, p_team_member_id: teamMemberId, p_active: !!active,
    });
  },
  async revokeTeamInvite(inviteId) {
    return rpc("studio_revoke_team_invite", { p_invite_id: inviteId });
  },
  async readTeamInvite(token) {
    return (await rpc("studio_get_team_invite", { p_token: token }))?.[0] || null;
  },
  async acceptTeamInvite(token) {
    return rpc("studio_accept_team_invite", { p_token: token });
  },
  async myAppAccessContext(organizationId = null) {
    return organizationId
      ? rpc("studio_get_app_access_context_for_org", { p_organization_id: organizationId })
      : rpc("studio_get_my_app_access_context");
  },
  // Minimum identity only (display names): the roster itself stays private to the Master User
  // and to members who were explicitly granted directory access.
  async conversationPeople(conversationId) {
    return (await rpc("chat_conversation_people", { p_conversation_id: conversationId })) || [];
  },
  async conversationMembers(conversationId, organizationId) {
    const { data, error } = await supabase.from("chat_conversation_members")
      .select("id, organization_id, conversation_id, user_id, role, status, joined_at, left_at, removed_at")
      .eq("organization_id", organizationId).eq("conversation_id", conversationId)
      .order("joined_at", { ascending: true }).limit(200);
    if (error) throw new Error(error.message || "Conversation members could not be loaded.");
    let names = new Map();
    try { names = new Map((await this.conversationPeople(conversationId)).map((person) => [person.user_id, person.display_name])); }
    catch { /* identities degrade to generic labels rather than failing the thread */ }
    return (data || []).map((member) => ({ ...member, display_name: names.get(member.user_id) || (member.status === "active" ? "Team member" : "Former member") }));
  },
  // ---- Master-managed grants (every call is re-checked by the database) ----
  async memberLogins(organizationId) {
    return (await rpc("studio_list_member_logins", { p_organization_id: organizationId })) || [];
  },
  async memberOverrides(organizationId, userId = null) {
    return (await rpc("studio_list_member_overrides", { p_organization_id: organizationId, p_user_id: userId })) || [];
  },
  async setMemberOverride(organizationId, userId, permissionKey, effect, reason = null) {
    return rpc("studio_set_member_override", {
      p_organization_id: organizationId, p_user_id: userId, p_permission_key: permissionKey, p_effect: effect, p_reason: reason,
    });
  },
  async effectivePermissions(organizationId, userId) {
    return rpc("studio_member_effective_permissions", { p_organization_id: organizationId, p_user_id: userId });
  },
  // ---- Client Portal and freelancer guest conversations (staff side) ----
  async portalThreads(organizationId) {
    return (await rpc("portal_staff_list_threads", { p_organization_id: organizationId })) || [];
  },
  async portalMessages(threadId, limit = 100) {
    return (await rpc("portal_staff_messages", { p_thread_id: threadId, p_limit: limit })) || [];
  },
  async portalSendText(threadId, body, idempotencyKey, replyToId = null) {
    return rpc("portal_staff_send", { p_thread_id: threadId, p_body: body, p_idempotency_key: idempotencyKey, p_attachments: [], p_reply_to_id: replyToId });
  },
  async portalReact(messageId, reaction, active) {
    return rpc("portal_staff_set_reaction", { p_message_id: messageId, p_reaction: reaction, p_active: !!active });
  },
  // Attachments go through the gateway so files are validated and stored server-side.
  async portalSendWithFiles(threadId, body, idempotencyKey, files, replyToId = null) {
    const { data: { session } } = await supabase.auth.getSession();
    const form = new FormData();
    form.append("mode", "staff"); form.append("action", "send"); form.append("thread_id", threadId);
    form.append("body", body); form.append("idempotency_key", idempotencyKey);
    if (replyToId) form.append("reply_to_id", replyToId);
    for (const file of files) form.append("files", file);
    const response = await fetch(functionUrl("portal-chat"), { method: "POST", headers: { Authorization: `Bearer ${session?.access_token || ""}` }, body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || "portal_send_failed");
    return result.message_id;
  },
  async portalDownloadUrl(attachmentId) {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(functionUrl("portal-chat"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
      body: JSON.stringify({ mode: "staff", action: "download", attachment_id: attachmentId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(result.error || "not_found");
    return result.url;
  },
  async portalMarkRead(threadId) { return rpc("portal_staff_mark_read", { p_thread_id: threadId }); },
  async portalEnsureClientThread(organizationId, projectId) {
    return rpc("portal_staff_ensure_client_thread", { p_organization_id: organizationId, p_project_id: projectId });
  },
  async portalNotes(threadId) { return (await rpc("portal_staff_notes", { p_thread_id: threadId })) || []; },
  async portalAddNote(threadId, body) { return rpc("portal_staff_add_note", { p_thread_id: threadId, p_body: body }); },
  async portalGuestInvites(organizationId, projectId = null) {
    return (await rpc("portal_staff_list_guest_invites", { p_organization_id: organizationId, p_project_id: projectId })) || [];
  },
  async portalCreateGuestInvite({ organizationId, projectId, label, token, threadId = null }) {
    const rows = await rpc("portal_staff_create_guest_invite", {
      p_organization_id: organizationId, p_project_id: projectId, p_label: label, p_token: token, p_thread_id: threadId,
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },
  async portalRevokeGuestInvite(inviteId) { return rpc("portal_staff_revoke_guest_invite", { p_invite_id: inviteId }); },
  async messages(conversationId, before = null, limit = CHAT_PAGE_SIZE) {
    let q = supabase.from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
    if (before?.created_at && before?.id) {
      q = q.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message || "Messages could not be loaded.");
    return (data || []).reverse();
  },
  async messagesAround(conversationId, targetMessageId, limit = CHAT_PAGE_SIZE) {
    const target = await this.messageById(targetMessageId);
    if (!target || target.conversation_id !== conversationId) {
      return { rows: await this.messages(conversationId, null, limit), targetFound: false, hasOlder: false };
    }
    const total = Math.min(Math.max(limit, 10), 100);
    const beforeCount = Math.floor(total / 2);
    const afterCount = total - beforeCount;
    const beforeFilter = `created_at.lt.${target.created_at},and(created_at.eq.${target.created_at},id.lte.${target.id})`;
    const afterFilter = `created_at.gt.${target.created_at},and(created_at.eq.${target.created_at},id.gt.${target.id})`;
    const [beforeResult, afterResult] = await Promise.all([
      supabase.from("chat_messages").select(MESSAGE_COLUMNS).eq("conversation_id", conversationId)
        .or(beforeFilter).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(beforeCount + 1),
      supabase.from("chat_messages").select(MESSAGE_COLUMNS).eq("conversation_id", conversationId)
        .or(afterFilter).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(afterCount),
    ]);
    if (beforeResult.error) throw new Error(beforeResult.error.message || "Earlier messages could not be loaded.");
    if (afterResult.error) throw new Error(afterResult.error.message || "Later messages could not be loaded.");
    const beforeRows = beforeResult.data || [];
    const hasOlder = beforeRows.length > beforeCount;
    return {
      rows: [...beforeRows.slice(0, beforeCount).reverse(), ...(afterResult.data || [])],
      targetFound: true,
      hasOlder,
    };
  },
  async messageById(messageId) {
    const { data, error } = await supabase.from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", messageId).maybeSingle();
    if (error) throw new Error(error.message || "Message could not be refreshed.");
    return data || null;
  },
  async pins(conversationId) {
    const { data, error } = await supabase.from("chat_pins")
      .select("id, conversation_id, message_id, pinned_by, pinned_at")
      .eq("conversation_id", conversationId).order("pinned_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message || "Pinned messages could not be loaded.");
    return data || [];
  },
  async startDirect(organizationId, targetUserId) {
    return rpc("chat_start_direct", { p_organization_id: organizationId, p_target_user_id: targetUserId });
  },
  async createConversation({ organizationId, kind, title, memberIds = [], departmentId = null, projectId = null }) {
    return rpc("chat_create_conversation", {
      p_organization_id: organizationId, p_kind: kind, p_title: title || "", p_member_ids: memberIds,
      p_department_id: departmentId, p_project_id: projectId,
    });
  },
  async addMember(conversationId, userId) {
    return rpc("chat_add_conversation_member", { p_conversation_id: conversationId, p_target_user_id: userId });
  },
  async removeMember(conversationId, userId) {
    return rpc("chat_remove_conversation_member", { p_conversation_id: conversationId, p_target_user_id: userId });
  },
  async updateTitle(conversationId, title) {
    return rpc("chat_update_conversation_title", { p_conversation_id: conversationId, p_title: title });
  },
  async sendMessage({ conversationId, body, replyToId = null, files = [], idempotencyKey }) {
    const validation = validateMessage(body, files);
    if (!validation.ok) throw new Error(validation.error);
    if (!idempotencyKey) throw new Error("Message request key is missing. Please try again.");
    if (files.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files at a time.`);
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES || !ALLOWED_ATTACHMENT_TYPES.has(String(file.type || "").toLowerCase())) {
        throw new Error(`Unsupported attachment: ${file.name || "file"}.`);
      }
    }
    // Text-only messages keep the direct database path.
    if (!files.length) {
      try {
        return await rpc("chat_send_message", {
          p_conversation_id: conversationId, p_body: validation.body,
          p_idempotency_key: idempotencyKey, p_reply_to_id: replyToId, p_attachment_ids: [],
        });
      } catch (sendError) {
        if (!sendError?.code) sendError.sendOutcomeUnknown = true;
        throw sendError;
      }
    }
    // Attachments are validated, stored in the studio's private Google Drive and linked to the message
    // atomically by the chat-attachments gateway. It also trashes uploads from a failed or duplicate
    // send, so the browser has no storage objects to clean up.
    const { data: { session } } = await supabase.auth.getSession();
    const form = new FormData();
    form.append("action", "send"); form.append("conversation_id", conversationId);
    form.append("body", validation.body); form.append("idempotency_key", idempotencyKey);
    if (replyToId) form.append("reply_to_id", replyToId);
    for (const file of files) form.append("files", file);
    let response;
    try {
      response = await fetch(functionUrl("chat-attachments"), { method: "POST", headers: { Authorization: `Bearer ${session?.access_token || ""}` }, body: form });
    } catch (networkError) {
      // No response: the gateway may have saved the message. The retry reuses the idempotency key.
      networkError.sendOutcomeUnknown = true;
      throw networkError;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error || !result.message_id) {
      const err = new Error(attachmentErrorText(result.error));
      err.code = String(result.error || response.status); // a received error response means the send did not persist
      throw err;
    }
    return result.message_id;
  },
  async editMessage(messageId, body) {
    return rpc("chat_edit_message", { p_message_id: messageId, p_new_body: String(body ?? "") });
  },
  async deleteMessage(messageId) {
    // The gateway authorizes the delete, moves the Drive files to the studio's Drive trash and
    // finalizes the attachment rows. Messages without attachments still go through the same call.
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(functionUrl("chat-attachments"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
      body: JSON.stringify({ action: "delete", message_id: messageId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) {
      const err = new Error(attachmentErrorText(result.error));
      err.code = String(result.error || response.status);
      throw err;
    }
    return { cleanupWarning: !!result.cleanupWarning };
  },
  async setReaction(messageId, reaction, active) {
    return rpc("chat_set_reaction", { p_message_id: messageId, p_reaction: reaction, p_active: !!active });
  },
  async markRead(conversationId, lastReadMessageId = null) {
    return rpc("chat_mark_read", { p_conversation_id: conversationId, p_last_read_message_id: lastReadMessageId });
  },
  async togglePin(messageId, active) {
    return rpc("chat_toggle_pin", { p_message_id: messageId, p_active: !!active });
  },
  async search(organizationId, query, conversationId = null, limit = 50) {
    return (await rpc("chat_search_messages", {
      p_organization_id: organizationId, p_query: query, p_conversation_id: conversationId, p_limit: limit,
    })) || [];
  },
  async addStudioMember(organizationId, email, displayName, role, departmentId = null, shareWorkspaceData = false) {
    return rpc("chat_add_studio_member_with_workspace", {
      p_organization_id: organizationId, p_email: email, p_display_name: displayName,
      p_role: role, p_department_id: departmentId, p_share_workspace_data: !!shareWorkspaceData,
    });
  },
  async workspaceSharing(organizationId) {
    return (await rpc("studio_list_workspace_sharing", { p_organization_id: organizationId })) || [];
  },
  async setWorkspaceSharing(organizationId, userId, share) {
    return rpc("studio_set_workspace_sharing", {
      p_organization_id: organizationId, p_user_id: userId, p_share: !!share,
    });
  },
  async manageableProjects(organizationId) {
    return (await rpc("studio_list_manageable_projects", { p_organization_id: organizationId })) || [];
  },
  async projectAccess(organizationId, projectId) {
    if (!projectId) return [];
    return (await rpc("studio_list_project_access", {
      p_organization_id: organizationId, p_project_id: projectId,
    })) || [];
  },
  async assignProjectAccess(organizationId, projectId, userId, accessLevel = "contributor") {
    return rpc("studio_assign_project_access", {
      p_organization_id: organizationId, p_project_id: projectId,
      p_user_id: userId, p_access_level: accessLevel,
    });
  },
  async revokeProjectAccess(organizationId, projectId, userId) {
    return rpc("studio_revoke_project_access", {
      p_organization_id: organizationId, p_project_id: projectId, p_user_id: userId,
    });
  },
  async departmentPermissions(organizationId, departmentId) {
    if (!departmentId) return [];
    return (await rpc("studio_list_department_permissions", {
      p_organization_id: organizationId, p_department_id: departmentId,
    })) || [];
  },
  async setDepartmentPermission(organizationId, departmentId, permissionKey, enabled) {
    return rpc("studio_set_department_permission", {
      p_organization_id: organizationId, p_department_id: departmentId,
      p_permission_key: permissionKey, p_enabled: !!enabled,
    });
  },
  async applicationAuditEvents(organizationId, limit = 100) {
    return (await rpc("studio_list_app_audit_events", {
      p_organization_id: organizationId, p_limit: Math.min(Math.max(limit, 1), 200),
    })) || [];
  },
  async setMemberStatus(organizationId, userId, status) {
    return rpc("chat_set_member_status", { p_organization_id: organizationId, p_user_id: userId, p_status: status });
  },
  async transferOwnership(conversationId, userId) {
    return rpc("chat_transfer_conversation_ownership", { p_conversation_id: conversationId, p_target_user_id: userId });
  },
  async createDepartment(organizationId, name) {
    return rpc("chat_create_department", { p_organization_id: organizationId, p_name: name });
  },
  async assignDepartmentMember(organizationId, departmentId, userId, departmentRole = "member") {
    return rpc("chat_assign_department_member", {
      p_organization_id: organizationId, p_department_id: departmentId,
      p_user_id: userId, p_department_role: departmentRole,
    });
  },
  async auditEvents(organizationId, limit = 100) {
    const { data, error } = await supabase.from("chat_audit_events")
      .select("id, organization_id, conversation_id, actor_user_id, event_type, entity_id, metadata, created_at")
      .eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 200));
    if (error) throw new Error(error.message || "Audit history could not be loaded.");
    return data || [];
  },
  async messageHistory(messageId, limit = 50) {
    const { data, error } = await supabase.from("chat_message_edits")
      .select("id, message_id, editor_user_id, old_body, new_body, changed_at")
      .eq("message_id", messageId).order("changed_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message || "Message history could not be loaded.");
    return data || [];
  },
  // The file streams through the chat-attachments gateway only after the database confirms this user
  // can read the conversation. The caller's row is looked up under the user's own JWT (RLS), so an
  // object path alone never grants access.
  async signedAttachmentUrl(objectPath) {
    const { data: row, error } = await supabase.from("chat_attachments").select("id").eq("object_path", objectPath).maybeSingle();
    if (error || !row) throw new Error("That attachment is not available.");
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(functionUrl("chat-attachments"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
      body: JSON.stringify({ action: "download", attachment_id: row.id }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(attachmentErrorText(result.error) || "That attachment is not available.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return url;
  },
  subscribeConversation({ conversationId, userId, displayName, onMessage, onChange, onTyping, onPresence }) {
    const channel = supabase.channel(`kf-chat:${conversationId}`, {
      config: { private: true, presence: { key: userId }, broadcast: { ack: true, self: false } },
    });
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages", filter: `conversation_id=eq.${conversationId}` }, (payload) => onMessage?.(payload))
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_conversations", filter: `id=eq.${conversationId}` }, () => onChange?.())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_conversation_members", filter: `conversation_id=eq.${conversationId}` }, () => onChange?.())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_read_state", filter: `conversation_id=eq.${conversationId}` }, () => onChange?.())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_reactions", filter: `conversation_id=eq.${conversationId}` }, () => onChange?.())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_attachments", filter: `conversation_id=eq.${conversationId}` }, () => onChange?.())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_pins", filter: `conversation_id=eq.${conversationId}` }, () => onChange?.())
      .on("broadcast", { event: "typing" }, (payload) => onTyping?.(payload.payload || {}))
      .on("presence", { event: "sync" }, () => onPresence?.(channel.presenceState()))
      .on("presence", { event: "join" }, () => onPresence?.(channel.presenceState()))
      .on("presence", { event: "leave" }, () => onPresence?.(channel.presenceState()))
      .subscribe(async (status) => {
        onChange?.({ status });
        if (status === "SUBSCRIBED") {
          try {
            await channel.track({ user_id: userId, display_name: displayName, online_at: new Date().toISOString() });
          } catch { /* Presence is optional; durable messaging continues. */ }
          onPresence?.(channel.presenceState());
        }
      });
    return {
      setTyping: (isTyping) => channel.send({
        type: "broadcast", event: "typing",
        payload: { userId, displayName, isTyping: !!isTyping, at: Date.now() },
      }),
      unsubscribe: () => { try { channel.untrack(); } catch { /* ignored */ } supabase.removeChannel(channel); },
      channel,
    };
  },
};
