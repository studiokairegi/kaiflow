import { supabase } from "../supabaseClient";
import { ALLOWED_ATTACHMENT_TYPES, CHAT_PAGE_SIZE, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, safeObjectFileName, validateMessage } from "./logic.js";

const throwIfError = (result, fallback = "Chat request failed.") => {
  if (result?.error) {
    const err = new Error(result.error.message || fallback);
    err.code = result.error.code;
    throw err;
  }
  return result?.data;
};

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
  async conversationMembers(conversationId, organizationId) {
    const { data, error } = await supabase.from("chat_conversation_members")
      .select("id, organization_id, conversation_id, user_id, role, status, joined_at, left_at, removed_at")
      .eq("organization_id", organizationId).eq("conversation_id", conversationId)
      .order("joined_at", { ascending: true }).limit(200);
    if (error) throw new Error(error.message || "Conversation members could not be loaded.");
    const active = await this.directory(organizationId);
    const names = new Map(active.map((member) => [member.user_id, member.display_name]));
    return (data || []).map((member) => ({ ...member, display_name: names.get(member.user_id) || (member.status === "active" ? "Team member" : "Former member") }));
  },
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
    const attachmentIds = [];
    const uploadedPaths = [];
    try {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES || !ALLOWED_ATTACHMENT_TYPES.has(String(file.type || "").toLowerCase())) {
          throw new Error(`Unsupported attachment: ${file.name || "file"}.`);
        }
        const uploadId = crypto.randomUUID();
        const objectPath = `${conversationId}/${uploadId}/${safeObjectFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage.from("chat-attachments").upload(objectPath, file, {
          cacheControl: "3600", contentType: file.type, upsert: false,
        });
        if (uploadError) throw new Error(uploadError.message || `Could not upload ${file.name}.`);
        uploadedPaths.push(objectPath);
        const attachmentId = await rpc("chat_register_attachment_upload", {
          p_conversation_id: conversationId, p_object_path: objectPath,
          p_file_name: String(file.name || "attachment").slice(0, 255),
          p_content_type: file.type, p_size_bytes: file.size,
        });
        attachmentIds.push(attachmentId);
      }
      const messageId = await rpc("chat_send_message", {
        p_conversation_id: conversationId, p_body: validation.body,
        p_idempotency_key: idempotencyKey, p_reply_to_id: replyToId,
        p_attachment_ids: attachmentIds,
      });
      // An idempotent retry may return the first persisted message after the client lost the
      // original response. Remove the retry's unused uploads only after confirming which IDs were
      // actually attached, so the first successful send cannot lose its files.
      if (attachmentIds.length) {
        try {
          const persisted = await this.messageById(messageId);
          if (persisted) {
            const linked = new Set((persisted.chat_attachments || []).map((item) => item.id));
            const orphanIds = attachmentIds.filter((id) => !linked.has(id));
            const orphanPaths = orphanIds.map((id) => uploadedPaths[attachmentIds.indexOf(id)]).filter(Boolean);
            let objectsRemoved = orphanPaths.length === 0;
            if (orphanPaths.length) {
              const { error: removeError } = await supabase.storage.from("chat-attachments").remove(orphanPaths);
              objectsRemoved = !removeError;
            }
            // Keep metadata if Storage cleanup failed so the unlinked upload remains discoverable
            // for a later retry instead of becoming an untracked private object.
            if (objectsRemoved) {
              for (const id of orphanIds) {
                try { await rpc("chat_cancel_attachment_upload", { p_attachment_id: id }); } catch { /* retry cleanup can be repeated safely */ }
              }
            }
          }
        } catch { /* Never roll back a persisted send because cleanup metadata could not load. */ }
      }
      return messageId;
    } catch (error) {
      // Best-effort cleanup for files that have not been attached to a persisted message.
      let objectsRemoved = uploadedPaths.length === 0;
      if (uploadedPaths.length) {
        try {
          const { error: removeError } = await supabase.storage.from("chat-attachments").remove(uploadedPaths);
          objectsRemoved = !removeError;
        } catch { objectsRemoved = false; /* keep metadata for a later cleanup attempt */ }
      }
      if (objectsRemoved) {
        for (const attachmentId of attachmentIds) {
          try { await rpc("chat_cancel_attachment_upload", { p_attachment_id: attachmentId }); } catch { /* an already-linked upload is retained */ }
        }
      }
      throw error;
    }
  },
  async editMessage(messageId, body) {
    return rpc("chat_edit_message", { p_message_id: messageId, p_new_body: String(body ?? "") });
  },
  async deleteMessage(messageId) {
    const objectPaths = (await rpc("chat_delete_message", { p_message_id: messageId })) || [];
    if (!objectPaths.length) return { cleanupWarning: false };
    const { error } = await supabase.storage.from("chat-attachments").remove(objectPaths);
    if (error) return { cleanupWarning: true };
    try {
      await rpc("chat_finalize_deleted_attachments", { p_message_id: messageId, p_object_paths: objectPaths });
      return { cleanupWarning: false };
    } catch {
      // Files have been removed; any remaining metadata is invisible for a deleted message.
      return { cleanupWarning: true };
    }
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
  async signedAttachmentUrl(objectPath) {
    const { data, error } = await supabase.storage.from("chat-attachments").createSignedUrl(objectPath, 60);
    if (error) throw new Error(error.message || "That attachment is not available.");
    return data?.signedUrl;
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
