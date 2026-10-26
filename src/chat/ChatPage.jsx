import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatApi } from "./api.js";
import {
  CHAT_PAGE_SIZE, QUICK_REACTIONS, conversationLabel, formatChatTime, groupReactions,
  mergeMessages, messageCursor, normalizeMessageBody, safeDisplayName, validateMessage,
} from "./logic.js";
import "./chat.css";

const ROLE_LABELS = {
  master_user: "Master User", department_admin: "Department administrator",
  staff: "Staff", freelancer: "Freelancer", client: "Client",
};
const NOOP = () => {};
const errorText = (error) => {
  const message = String(error?.message || "");
  if (/not_authorized|permission denied|row-level security|42501/i.test(message)) return "You don't have permission to do that.";
  if (/account_not_found/i.test(message)) return "That email doesn't have a KairFlow login yet. The person must sign up first.";
  if (/target_not_chat_eligible/i.test(message)) return "That account isn't eligible for internal chat.";
  if (/project_access_required/i.test(message)) return "The person does not currently have permission to access this project. Project chat invitations are restricted until KairFlow's shared-project access model is available.";
  if (/transfer_ownership_before_leaving/i.test(message)) return "Transfer group ownership to another active member before leaving.";
  if (/edit_window_expired/i.test(message)) return "Messages can only be edited for 15 minutes after sending.";
  if (/not_found_or_not_authorized|project_not_found/i.test(message)) return "That project is no longer available or you don't have access.";
  return message || "Something went wrong. Please try again.";
};

export default function ChatPage({ userId, initialConversationId = null, initialMessageId = null, activeOrganizationId = "", onOrganizationChange = NOOP, onConversationChange = NOOP, onUnreadCountChange = NOOP, onClose = NOOP }) {
  const [memberships, setMemberships] = useState([]);
  const [organizationId, setOrganizationId] = useState(activeOrganizationId || "");
  const [directory, setDirectory] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedId, setSelectedId] = useState(initialConversationId || null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [composer, setComposer] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [editHistory, setEditHistory] = useState(null);
  const [busyMessageId, setBusyMessageId] = useState(null);
  const [sideMode, setSideMode] = useState("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [peopleFilter, setPeopleFilter] = useState("");
  const [typingUsers, setTypingUsers] = useState({});
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [realtimeStatus, setRealtimeStatus] = useState("joining");
  const [showMembers, setShowMembers] = useState(false);
  const [showPins, setShowPins] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newKind, setNewKind] = useState("group");
  const [newTitle, setNewTitle] = useState("");
  const [newMemberIds, setNewMemberIds] = useState([]);
  const [newDepartmentId, setNewDepartmentId] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [addingMemberId, setAddingMemberId] = useState("");
  const [downloadBusyId, setDownloadBusyId] = useState(null);
  const [jumpMessageId, setJumpMessageId] = useState(null);

  const activeMembership = useMemo(() => memberships.find((item) => item.organization_id === organizationId) || null, [memberships, organizationId]);
  const isMaster = activeMembership?.role === "master_user";
  const isClient = activeMembership?.role === "client";
  const currentDisplayName = safeDisplayName(activeMembership?.display_name, "You");
  const selectedConversation = useMemo(() => conversations.find((conversation) => conversation.conversation_id === selectedId) || null, [conversations, selectedId]);
  const memberById = useMemo(() => {
    const lookup = new Map(directory.map((person) => [person.user_id, person]));
    if (activeMembership) lookup.set(activeMembership.user_id || userId, { user_id: activeMembership.user_id || userId, display_name: activeMembership.display_name, role: activeMembership.role });
    return lookup;
  }, [directory, activeMembership, userId]);
  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => `${item.title || ""} ${item.last_message_body || ""}`.toLowerCase().includes(query));
  }, [conversations, searchQuery]);
  const filteredDirectory = useMemo(() => {
    const q = peopleFilter.trim().toLowerCase();
    return directory.filter((item) => !q || `${item.display_name} ${ROLE_LABELS[item.role] || item.role} ${(item.department_names || []).join(" ")}`.toLowerCase().includes(q));
  }, [directory, peopleFilter]);
  const selectedMemberIds = useMemo(() => new Set(members.filter((member) => member.status === "active").map((member) => member.user_id)), [members]);
  const scrollerRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const subscriptionRef = useRef(null);
  const typingLastSentRef = useRef(0);
  const shouldScrollBottomRef = useRef(true);
  const lastConversationRef = useRef(null);
  const messagesRef = useRef(messages);
  const pendingSendRef = useRef(null);
  messagesRef.current = messages;

  useEffect(() => {
    if (!activeOrganizationId || activeOrganizationId === organizationId) return;
    if (!memberships.some((membership) => membership.organization_id === activeOrganizationId)) return;
    setOrganizationId(activeOrganizationId);
    setSelectedId(null);
    setMessages([]);
    setConversations([]);
    onConversationChange(null);
  }, [activeOrganizationId, organizationId, memberships, onConversationChange]);

  useEffect(() => {
    // A notification may target a conversation while the chat view is already mounted.
    // A cleared parent target must not reset the user's current conversation.
    if (initialConversationId && initialConversationId !== selectedId) setSelectedId(initialConversationId);
  }, [initialConversationId, selectedId]);

  useEffect(() => {
    if (!initialConversationId || selectedId !== initialConversationId || !initialMessageId) return;
    setJumpMessageId(initialMessageId);
  }, [initialConversationId, initialMessageId, selectedId]);

  useEffect(() => {
    const unread = conversations.reduce((total, item) => total + Math.max(0, Number(item.unread_count) || 0), 0);
    onUnreadCountChange(unread);
  }, [conversations, onUnreadCountChange]);

  const loadMemberships = useCallback(async () => {
    setLoadingWorkspace(true);
    setLoadError("");
    try {
      const rows = await chatApi.memberships();
      setMemberships(rows);
      if (rows.length && !rows.some((row) => row.organization_id === organizationId)) setOrganizationId(rows[0].organization_id);
      if (!rows.length) setOrganizationId("");
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [organizationId]);

  useEffect(() => { loadMemberships(); }, [loadMemberships, userId]);

  const refreshConversations = useCallback(async () => {
    if (!organizationId || !activeMembership || activeMembership.role === "client") return;
    try {
      const rows = await chatApi.conversations(organizationId);
      setConversations(rows);
      if (selectedId && !rows.some((row) => row.conversation_id === selectedId)) {
        // Losing membership or project authorization while a chat is open must close it.
        setSelectedId(null);
        onConversationChange(null);
        setMessages([]);
      }
    } catch (error) {
      setActionError(errorText(error));
    }
  }, [organizationId, activeMembership, selectedId, onConversationChange]);

  const refreshWorkspace = useCallback(async () => {
    if (!organizationId || !activeMembership || activeMembership.role === "client") {
      setDirectory([]); setDepartments([]); setProjects([]); setConversations([]);
      return;
    }
    setLoadingWorkspace(true);
    setLoadError("");
    try {
      const [peopleResult, departmentsResult, projectsResult, conversationsResult] = await Promise.allSettled([
        chatApi.directory(organizationId), chatApi.departments(organizationId), chatApi.projectOptions(organizationId), chatApi.conversations(organizationId),
      ]);
      if (peopleResult.status === "fulfilled") setDirectory(peopleResult.value); else throw peopleResult.reason;
      if (departmentsResult.status === "fulfilled") setDepartments(departmentsResult.value);
      if (projectsResult.status === "fulfilled") setProjects(projectsResult.value);
      if (conversationsResult.status === "fulfilled") setConversations(conversationsResult.value); else throw conversationsResult.reason;
      setLoadError("");
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [organizationId, activeMembership]);

  useEffect(() => { refreshWorkspace(); }, [refreshWorkspace]);

  const loadMembers = useCallback(async (conversationId = selectedId) => {
    if (!conversationId || !organizationId) { setMembers([]); return; }
    try { setMembers(await chatApi.conversationMembers(conversationId, organizationId)); }
    catch (error) { setActionError(errorText(error)); }
  }, [selectedId, organizationId]);

  const loadMessages = useCallback(async (conversationId, { append = false, targetMessageId = null } = {}) => {
    if (!conversationId) return;
    if (append) setLoadingOlder(true); else setLoadingMessages(true);
    try {
      let before = null;
      if (append) {
        const earliest = messagesRef.current[0];
        before = messageCursor(earliest);
        if (!before) return;
      }
      let rows;
      let targetFound = true;
      if (!append && targetMessageId) {
        const around = await chatApi.messagesAround(conversationId, targetMessageId, CHAT_PAGE_SIZE);
        rows = around.rows;
        targetFound = around.targetFound;
        setHasOlder(around.hasOlder);
      } else {
        rows = await chatApi.messages(conversationId, before, CHAT_PAGE_SIZE);
        setHasOlder(rows.length === CHAT_PAGE_SIZE);
      }
      if (append) setMessages((current) => mergeMessages(rows, current)); else setMessages(rows);
      if (!append) {
        shouldScrollBottomRef.current = true;
        const latest = targetMessageId && targetFound ? rows.find((row) => row.id === targetMessageId) : rows[rows.length - 1];
        try { await chatApi.markRead(conversationId, latest?.id || null); } catch { /* read cursor will reconcile next open */ }
        refreshConversations();
      }
      if (targetMessageId && targetFound) setJumpMessageId(targetMessageId);
      else if (targetMessageId) { setJumpMessageId(null); setNotice("This notification’s message is no longer available in this conversation."); }
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setLoadingMessages(false);
      setLoadingOlder(false);
    }
  }, [refreshConversations]);

  useEffect(() => {
    if (!selectedId || !activeMembership || isClient) {
      setMessages([]); setMembers([]); setHasOlder(false); return;
    }
    if (lastConversationRef.current !== selectedId) {
      lastConversationRef.current = selectedId;
      setMessages([]); setMembers([]); setReplyTo(null); setEditingId(null); setEditHistory(null);
      setShowMembers(false); setShowPins(false); setJumpMessageId(null);
      shouldScrollBottomRef.current = true;
    }
    const targetMessageId = initialConversationId === selectedId ? initialMessageId : null;
    loadMessages(selectedId, { targetMessageId });
    loadMembers(selectedId);
  }, [selectedId, organizationId, activeMembership, isClient, initialConversationId, initialMessageId, loadMessages, loadMembers]);

  useEffect(() => {
    if (!selectedId || !userId || !activeMembership || isClient) return undefined;
    let active = true;
    const subscription = chatApi.subscribeConversation({
      conversationId: selectedId, userId, displayName: currentDisplayName,
      onMessage: async (payload) => {
        const row = payload?.new || payload?.old;
        if (!row?.id) return;
        try {
          const updated = await chatApi.messageById(row.id);
          if (!active || !updated) return;
          const scroller = scrollerRef.current;
          const nearBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
          if (nearBottom || updated.sender_user_id === userId) shouldScrollBottomRef.current = true;
          setMessages((current) => mergeMessages(current, [updated]));
          if (nearBottom) chatApi.markRead(selectedId, updated.id).then(refreshConversations).catch(() => {});
        } catch { /* The next durable refresh reconciles missed events. */ }
      },
      onChange: (event) => {
        if (event?.status) {
          setRealtimeStatus(event.status === "SUBSCRIBED" ? "connected" : event.status.toLowerCase());
          if (event.status === "SUBSCRIBED" && active) {
            // A subscription is not a durable queue; reconcile missed events from PostgreSQL.
            chatApi.messages(selectedId).then((rows) => active && setMessages((current) => mergeMessages(current, rows))).catch(() => {});
            loadMembers(selectedId);
            refreshConversations();
          }
        } else {
          chatApi.messages(selectedId).then((rows) => active && setMessages((current) => mergeMessages(current, rows))).catch(() => {});
          loadMembers(selectedId);
          refreshConversations();
        }
      },
      onTyping: (payload) => {
        if (!payload || payload.userId === userId) return;
        setTypingUsers((current) => {
          const next = { ...current };
          if (payload.isTyping) next[payload.userId] = { displayName: safeDisplayName(payload.displayName), expiresAt: Date.now() + 4500 };
          else delete next[payload.userId];
          return next;
        });
      },
      onPresence: (state) => {
        const entries = Object.values(state || {}).flat();
        setOnlineUsers(entries.filter((entry) => entry?.user_id && entry.user_id !== userId)
          .map((entry) => ({ user_id: entry.user_id, display_name: safeDisplayName(entry.display_name) })));
      },
    });
    subscriptionRef.current = subscription;
    setRealtimeStatus("joining");
    const accessRefresh = window.setInterval(() => {
      if (active) refreshConversations();
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(accessRefresh);
      subscription.unsubscribe();
      if (subscriptionRef.current === subscription) subscriptionRef.current = null;
      setRealtimeStatus("offline");
      setTypingUsers({}); setOnlineUsers([]);
    };
  }, [selectedId, userId, activeMembership, isClient, currentDisplayName, loadMembers, refreshConversations]);

  useEffect(() => {
    if (!shouldScrollBottomRef.current || !scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    shouldScrollBottomRef.current = false;
  }, [messages, selectedId]);

  useEffect(() => {
    if (!jumpMessageId) return;
    const node = document.getElementById(`chat-message-${jumpMessageId}`);
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      setJumpMessageId(null);
    }
  }, [jumpMessageId, messages]);

  useEffect(() => {
    if (!Object.keys(typingUsers).length) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTypingUsers((current) => Object.fromEntries(Object.entries(current).filter(([, item]) => item.expiresAt > now)));
    }, 1600);
    return () => window.clearInterval(timer);
  }, [typingUsers]);

  const chooseConversation = (id) => {
    setSelectedId(id);
    onConversationChange(id);
    setSideMode("recent");
    setActionError("");
  };

  const startDirect = async (person) => {
    setActionError("");
    try {
      const id = await chatApi.startDirect(organizationId, person.user_id);
      await refreshConversations();
      chooseConversation(id);
    } catch (error) { setActionError(errorText(error)); }
  };

  const submitNewConversation = async (event) => {
    event.preventDefault();
    setActionError("");
    try {
      const id = await chatApi.createConversation({
        organizationId, kind: newKind, title: newTitle, memberIds: newKind === "project" ? [] : newMemberIds,
        departmentId: newKind === "group" ? (newDepartmentId || null) : null,
        projectId: newKind === "project" ? (newProjectId || null) : null,
      });
      setShowNewConversation(false); setNewTitle(""); setNewMemberIds([]); setNewDepartmentId(""); setNewProjectId("");
      await refreshConversations();
      chooseConversation(id);
      setNotice(newKind === "project" ? "Project conversation created." : "Group conversation created.");
    } catch (error) { setActionError(errorText(error)); }
  };

  const sendTyping = (active) => {
    const subscription = subscriptionRef.current;
    if (!subscription) return;
    const now = Date.now();
    if (active && now - typingLastSentRef.current < 1400) return;
    typingLastSentRef.current = now;
    subscription.setTyping(active).catch(() => {});
  };

  const sendMessage = async (event) => {
    event?.preventDefault?.();
    if (!selectedId || sending) return;
    const body = normalizeMessageBody(composer);
    const validation = validateMessage(body, selectedFiles);
    if (!validation.ok) { setActionError(validation.error); return; }
    const fingerprint = JSON.stringify({
      conversationId: selectedId, body, replyToId: replyTo?.id || null,
      files: selectedFiles.map((file) => [file.name, file.size, file.type, file.lastModified]),
    });
    if (!pendingSendRef.current || pendingSendRef.current.fingerprint !== fingerprint) {
      pendingSendRef.current = { fingerprint, key: crypto.randomUUID() };
    }
    const idempotencyKey = pendingSendRef.current.key;
    setSending(true); setActionError(""); setNotice("");
    sendTyping(false);
    try {
      const messageId = await chatApi.sendMessage({
        conversationId: selectedId, body, files: selectedFiles, replyToId: replyTo?.id || null, idempotencyKey,
      });
      setComposer(""); setSelectedFiles([]); setReplyTo(null); pendingSendRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
      shouldScrollBottomRef.current = true;
      const row = await chatApi.messageById(messageId);
      if (row) setMessages((current) => mergeMessages(current, [row]));
      await refreshConversations();
      try { await chatApi.markRead(selectedId, messageId); } catch { /* refreshed on next conversation open */ }
      composerRef.current?.focus();
    } catch (error) { setActionError(errorText(error)); }
    finally { setSending(false); }
  };

  const loadOlderMessages = () => {
    if (!loadingOlder && hasOlder) loadMessages(selectedId, { append: true });
  };

  const runSearch = async (event) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) { setActionError("Enter at least two characters to search."); return; }
    setSearching(true); setActionError(""); setSideMode("search");
    try { setSearchResults(await chatApi.search(organizationId, query)); }
    catch (error) { setActionError(errorText(error)); }
    finally { setSearching(false); }
  };

  const visitSearchResult = async (result) => {
    chooseConversation(result.conversation_id);
    // Load a bounded recent window around this result rather than pulling an unbounded history.
    try {
      const recent = await chatApi.messages(result.conversation_id, null, CHAT_PAGE_SIZE);
      if (recent.some((message) => message.id === result.message_id)) {
        setMessages(recent); setJumpMessageId(result.message_id); setHasOlder(recent.length === CHAT_PAGE_SIZE); return;
      }
      setMessages(recent); setHasOlder(recent.length === CHAT_PAGE_SIZE); setJumpMessageId(result.message_id);
      setNotice("That result is older than the loaded messages. Use Load earlier messages to reach it; the view will jump there when it loads.");
    } catch (error) { setActionError(errorText(error)); }
  };

  const pinMessage = async (message, active) => {
    setBusyMessageId(message.id); setActionError("");
    try {
      await chatApi.togglePin(message.id, active);
      const refreshed = await chatApi.messageById(message.id);
      if (refreshed) setMessages((current) => mergeMessages(current, [refreshed]));
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusyMessageId(null); }
  };

  const reactToMessage = async (message, reaction, currentlyReacted) => {
    setBusyMessageId(message.id); setActionError("");
    try {
      await chatApi.setReaction(message.id, reaction, !currentlyReacted);
      const refreshed = await chatApi.messageById(message.id);
      if (refreshed) setMessages((current) => mergeMessages(current, [refreshed]));
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusyMessageId(null); }
  };

  const editMessage = async (message) => {
    const body = normalizeMessageBody(editBody);
    if (!body) { setActionError("A message cannot be empty when editing."); return; }
    setBusyMessageId(message.id); setActionError("");
    try {
      await chatApi.editMessage(message.id, body);
      const refreshed = await chatApi.messageById(message.id);
      if (refreshed) setMessages((current) => mergeMessages(current, [refreshed]));
      setEditingId(null); setEditBody(""); setNotice("Message updated.");
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusyMessageId(null); }
  };

  const deleteMessage = async (message) => {
    if (!window.confirm("Delete this message? Its history will be retained for accountability.")) return;
    setBusyMessageId(message.id); setActionError("");
    try {
      const deletion = await chatApi.deleteMessage(message.id);
      const refreshed = await chatApi.messageById(message.id);
      if (refreshed) setMessages((current) => mergeMessages(current, [refreshed]));
      setNotice(deletion?.cleanupWarning
        ? "Message deleted. Attachment cleanup needs a retry; the deleted message's files are not available in chat."
        : "Message deleted.");
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusyMessageId(null); }
  };

  const showHistory = async (message) => {
    try { setEditHistory({ messageId: message.id, rows: await chatApi.messageHistory(message.id) }); }
    catch (error) { setActionError(errorText(error)); }
  };

  const downloadAttachment = async (attachment) => {
    setDownloadBusyId(attachment.id); setActionError("");
    let popup = null;
    try {
      popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      const url = await chatApi.signedAttachmentUrl(attachment.object_path);
      if (!url) throw new Error("Attachment link could not be created.");
      if (popup) popup.location.href = url;
      else window.location.assign(url);
    } catch (error) { popup?.close(); setActionError(errorText(error)); }
    finally { setDownloadBusyId(null); }
  };

  const addConversationMember = async () => {
    if (!selectedId || !addingMemberId) return;
    setActionError("");
    try {
      await chatApi.addMember(selectedId, addingMemberId);
      setAddingMemberId(""); await Promise.all([loadMembers(selectedId), refreshConversations()]);
      setNotice("Conversation member added.");
    } catch (error) { setActionError(errorText(error)); }
  };

  const transferConversationOwnership = async (member) => {
    if (!selectedId || !member?.user_id) return;
    if (!window.confirm(`Make ${member.display_name} the conversation owner? You may lose owner-only controls.`)) return;
    setActionError("");
    try {
      await chatApi.transferOwnership(selectedId, member.user_id);
      await loadMembers(selectedId);
      await refreshConversations();
      setNotice("Conversation ownership updated.");
    } catch (error) { setActionError(errorText(error)); }
  };

  const removeConversationMember = async (member) => {
    if (!window.confirm(`Remove ${member.display_name || "this member"} from this conversation?`)) return;
    setActionError("");
    try {
      await chatApi.removeMember(selectedId, member.user_id);
      await Promise.all([loadMembers(selectedId), refreshConversations()]);
      if (member.user_id === userId) chooseConversation(null);
      setNotice("Membership updated.");
    } catch (error) { setActionError(errorText(error)); }
  };

  const startReply = (message) => {
    setReplyTo({ id: message.id, preview: message.deleted_at ? "Deleted message" : message.body.slice(0, 180), senderName: memberById.get(message.sender_user_id)?.display_name || "Team member" });
    composerRef.current?.focus();
  };

  if (loadingWorkspace && !memberships.length) {
    return <div className="chat-state-card"><button type="button" className="chat-state-close" onClick={onClose} aria-label="Close chat">×</button><div className="chat-spinner" aria-hidden="true" /><h2>Opening chat</h2><p>Checking your studio access…</p></div>;
  }
  if (loadError && !memberships.length) {
    return <div className="chat-state-card"><button type="button" className="chat-state-close" onClick={onClose} aria-label="Close chat">×</button><h2>Chat couldn't load</h2><p>{loadError}</p><button className="chat-button primary" onClick={loadMemberships}>Retry</button></div>;
  }
  if (!memberships.length) {
    return <div className="chat-state-card"><button type="button" className="chat-state-close" onClick={onClose} aria-label="Close chat">×</button><div className="chat-state-icon" aria-hidden="true">✦</div><h2>Chat needs studio access</h2><p>This login isn't linked to a KairFlow studio yet. Ask the Studio Kairegi owner to invite you from Teams. Access is linked to your authenticated account, never guessed from a name or email.</p><p className="chat-muted">Existing freelancers can keep using the freelancer portal until they accept a studio invite.</p><button className="chat-button secondary" onClick={loadMemberships}>Check access again</button></div>;
  }
  if (isClient) {
    return <div className="chat-state-card"><button type="button" className="chat-state-close" onClick={onClose} aria-label="Close chat">×</button><div className="chat-state-icon" aria-hidden="true">🔒</div><h2>Internal chat is not available to client accounts</h2><p>Client access stays within the existing client portal and cut-review workflows. A client login cannot read staff direct messages, internal groups, or private attachments.</p></div>;
  }

  return (
    <section className={`chat-page${selectedId ? " has-active-conversation" : ""}`} data-conversation-open={selectedId ? "true" : "false"} aria-label="Studio chat">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-top">
          <div className="chat-topbar"><h2>Messages</h2><div className="chat-topbar-actions"><button type="button" className="chat-icon-button" onClick={() => setShowNewConversation(true)} aria-label="New conversation" title="New conversation">✎</button><button type="button" className="chat-icon-button chat-close-button" onClick={onClose} aria-label="Close chat" title="Close chat">×</button></div></div>
          {memberships.length > 1 && <label className="chat-org-select-label"><span>Studio</span><select value={organizationId} onChange={(e) => { const nextOrganizationId = e.target.value; setOrganizationId(nextOrganizationId); setSelectedId(null); setMessages([]); onConversationChange(null); onOrganizationChange(nextOrganizationId); }} aria-label="Choose studio">
            {memberships.map((item) => <option key={item.organization_id} value={item.organization_id}>{item.organization_name}</option>)}
          </select></label>}
          <form className="chat-search-form" onSubmit={runSearch}><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); if (sideMode === "search") setSideMode("recent"); }} placeholder="Search chats — press Enter to search messages" aria-label="Search chats and messages" /><button type="submit" disabled={searching} aria-label="Search messages">{searching ? "…" : "↵"}</button></form>
          <div className="chat-sidebar-tabs" role="tablist" aria-label="Chat sidebar views">
            <button type="button" role="tab" aria-selected={sideMode === "recent"} className={sideMode === "recent" ? "active" : ""} onClick={() => setSideMode("recent")}>Chats</button>
            <button type="button" role="tab" aria-selected={sideMode === "people"} className={sideMode === "people" ? "active" : ""} onClick={() => setSideMode("people")}>People</button>
            {searchResults.length > 0 && <button type="button" role="tab" aria-selected={sideMode === "search"} className={sideMode === "search" ? "active" : ""} onClick={() => setSideMode("search")}>Results</button>}
          </div>
        </div>
        <div className="chat-sidebar-list">
          {sideMode === "recent" && <>
            {loadingWorkspace && <p className="chat-muted chat-list-note">Refreshing conversations…</p>}
            {!filteredConversations.length && <div className="chat-empty-list"><span aria-hidden="true">◌</span><strong>No conversations yet</strong><p>Tap ✎ to message a teammate or start a group.</p></div>}
            {filteredConversations.map((item) => <button type="button" key={item.conversation_id} className={`chat-conversation-row${selectedId === item.conversation_id ? " active" : ""}`} onClick={() => chooseConversation(item.conversation_id)}>
              <span className={`chat-avatar ${item.kind === "group" ? "group" : item.kind === "project" ? "project" : ""}`} aria-hidden="true">{item.kind === "group" ? "◎" : item.kind === "project" ? "▧" : (item.title || "?").slice(0, 1).toUpperCase()}</span>
              <span className="chat-conversation-copy"><span className="chat-conversation-title">{item.title || "Conversation"}</span><span className="chat-conversation-preview">{item.last_message_body ? item.last_message_body : item.kind === "project" ? "Project conversation" : item.kind === "group" ? "Group conversation" : "Start a conversation"}</span><span className="chat-conversation-time">{formatChatTime(item.last_message_at || item.updated_at)}</span></span>
              {Number(item.unread_count) > 0 && <span className="chat-unread-badge" aria-label={`${item.unread_count} unread messages`}>{item.unread_count > 99 ? "99+" : item.unread_count}</span>}
            </button>)}
          </>}
          {sideMode === "people" && <>
            <input className="chat-inline-filter" value={peopleFilter} onChange={(e) => setPeopleFilter(e.target.value)} placeholder="Find a teammate…" aria-label="Find a teammate" />
            {!filteredDirectory.length && <div className="chat-empty-list"><strong>No teammates found</strong><p>Only authenticated studio members appear here. Freelancer roster records without accounts are not chat identities.</p></div>}
            {filteredDirectory.map((person) => <div className="chat-person-row" key={person.user_id}><span className="chat-avatar" aria-hidden="true">{safeDisplayName(person.display_name).slice(0,1).toUpperCase()}</span><span className="chat-person-copy"><strong>{person.display_name}</strong><small>{ROLE_LABELS[person.role] || person.role}{person.department_names?.length ? ` · ${person.department_names.join(", ")}` : ""}</small></span><button className="chat-icon-button" aria-label={`Message ${person.display_name}`} title={`Message ${person.display_name}`} onClick={() => startDirect(person)}>↗</button></div>)}
          </>}
          {sideMode === "search" && <>
            {searchResults.map((result) => <button type="button" className="chat-search-result" key={result.message_id} onClick={() => visitSearchResult(result)}><strong>{result.sender_name}</strong><small>{formatChatTime(result.created_at)}</small><p>{result.body}</p></button>)}
            {!searchResults.length && <div className="chat-empty-list"><strong>No matching messages</strong><p>Try another search phrase.</p></div>}
          </>}
        </div>
      </aside>

      <main className="chat-main">
        {selectedConversation ? <>
          <header className="chat-conversation-header"><button className="chat-mobile-back" onClick={() => chooseConversation(null)} aria-label="Back to conversations">←</button><span className={`chat-avatar ${selectedConversation.kind === "group" ? "group" : selectedConversation.kind === "project" ? "project" : ""}`} aria-hidden="true">{selectedConversation.kind === "group" ? "◎" : selectedConversation.kind === "project" ? "▧" : (selectedConversation.title || "?").slice(0, 1).toUpperCase()}</span><div className="chat-header-copy"><h2>{conversationLabel(selectedConversation, userId, members)}</h2><p>{selectedConversation.kind === "direct" ? "Direct message" : selectedConversation.kind === "project" ? "Internal project discussion" : `${members.filter((member) => member.status === "active").length} members · Group conversation`}{onlineUsers.length ? ` · ${onlineUsers.length} online` : ""}</p></div><div className="chat-header-actions"><span className={`chat-connection-indicator ${realtimeStatus === "connected" ? "connected" : ""}`} title={`Realtime: ${realtimeStatus}`}><span />{realtimeStatus === "connected" ? "Live" : realtimeStatus === "joining" ? "Connecting" : "Reconnecting"}</span><button className={`chat-icon-button${showPins ? " selected" : ""}`} title="Pinned messages" aria-label="Pinned messages" onClick={() => setShowPins((value) => !value)}>⌑</button><button className={`chat-icon-button${showMembers ? " selected" : ""}`} title="Conversation members" aria-label="Conversation members" onClick={() => { setShowMembers((value) => !value); loadMembers(selectedId); }}>♙</button></div></header>
          <div className="chat-conversation-body">
            <section ref={scrollerRef} className="chat-message-area" aria-label="Messages">
              {showPins && <div className="chat-pins-strip"><strong>Pinned messages</strong>{messages.filter((message) => message.chat_pins?.length).length ? messages.filter((message) => message.chat_pins?.length).map((message) => <button key={message.id} onClick={() => setJumpMessageId(message.id)}>{message.deleted_at ? "Deleted message" : message.body || "Attachment"}</button>) : <span className="chat-muted">No pinned messages in this page.</span>}</div>}
              {actionError && <div className="chat-inline-alert error" role="alert"><span>{actionError}</span><button onClick={() => setActionError("")} aria-label="Dismiss error">×</button></div>}
              {notice && <div className="chat-inline-alert success" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
              {loadingMessages && !messages.length && <div className="chat-messages-loading"><div className="chat-spinner" /><span>Loading messages…</span></div>}
              {hasOlder && <div className="chat-load-older"><button className="chat-button quiet" onClick={loadOlderMessages} disabled={loadingOlder}>{loadingOlder ? "Loading earlier messages…" : "↑ Load earlier messages"}</button></div>}
              {!loadingMessages && !messages.length && <div className="chat-empty-conversation"><span aria-hidden="true">✦</span><h3>Start the conversation</h3><p>Messages are saved to KairFlow. Only authorized conversation members and permitted administrators can access them.</p></div>}
              {messages.map((message, index) => {
                const mine = message.sender_user_id === userId;
                const senderName = mine ? "You" : memberById.get(message.sender_user_id)?.display_name || "Team member";
                const previous = messages[index - 1];
                const grouped = previous && previous.sender_user_id === message.sender_user_id && Date.now() - Date.parse(previous.created_at) < 4 * 60 * 1000 && new Date(previous.created_at).toDateString() === new Date(message.created_at).toDateString();
                const reactions = groupReactions(message.chat_reactions || [], userId);
                const isPinned = (message.chat_pins || []).length > 0;
                const pendingReply = message.reply_to_id ? messages.find((parent) => parent.id === message.reply_to_id) : null;
                return <article id={`chat-message-${message.id}`} key={message.id} className={`chat-message-row${mine ? " mine" : ""}${grouped ? " grouped" : ""}${jumpMessageId === message.id ? " jump-target" : ""}`}>
                  {!grouped && <span className="chat-message-avatar" aria-hidden="true">{safeDisplayName(senderName).slice(0,1).toUpperCase()}</span>}
                  <div className="chat-message-wrap"><div className="chat-message-meta">{!grouped && <strong>{senderName}</strong>}<time>{formatChatTime(message.created_at)}</time>{message.edited_at && !message.deleted_at && <span>edited</span>}{isPinned && <span className="chat-pinned-tag">Pinned</span>}</div>
                    {message.reply_to_id && <button className="chat-reply-preview" onClick={() => pendingReply ? setJumpMessageId(pendingReply.id) : setNotice("The original message isn't in the loaded page.")}><span>↳ {pendingReply ? (memberById.get(pendingReply.sender_user_id)?.display_name || "Team member") : "Earlier message"}</span><span>{pendingReply?.deleted_at ? "Deleted message" : pendingReply?.body || "Reply context"}</span></button>}
                    <div className={`chat-message-bubble${message.deleted_at ? " deleted" : ""}`}>
                      {message.deleted_at ? <em>This message was deleted.</em> : message.body ? <p>{message.body}</p> : null}
                      {!message.deleted_at && message.chat_attachments?.length > 0 && <div className="chat-attachments">{message.chat_attachments.map((attachment) => <button type="button" className="chat-attachment-card" key={attachment.id} onClick={() => downloadAttachment(attachment)} disabled={downloadBusyId === attachment.id}><span className="chat-attachment-icon" aria-hidden="true">{attachment.content_type?.startsWith("image/") ? "▧" : attachment.content_type?.startsWith("video/") ? "▶" : "↧"}</span><span><strong>{attachment.file_name}</strong><small>{(attachment.size_bytes / 1024 / 1024).toFixed(2)} MB · {downloadBusyId === attachment.id ? "Opening…" : "Open securely"}</small></span></button>)}</div>}
                    </div>
                    {!message.deleted_at && <div className="chat-message-tools"><button onClick={() => startReply(message)} title="Reply to message">Reply</button>{mine && <button onClick={() => { setEditingId(message.id); setEditBody(message.body); setEditHistory(null); }} title="Edit message">Edit</button>}<button onClick={() => showHistory(message)} title="View edit history">History</button><button onClick={() => pinMessage(message, !isPinned)} disabled={busyMessageId === message.id}>{isPinned ? "Unpin" : "Pin"}</button>{(mine || (isMaster && selectedConversation.kind !== "direct")) && <button className="danger-text" onClick={() => deleteMessage(message)} disabled={busyMessageId === message.id}>Delete</button>}</div>}
                    {!message.deleted_at && <div className="chat-reactions-row">{reactions.map((group) => <button type="button" key={group.reaction} className={`chat-reaction${group.reactedByMe ? " mine" : ""}`} onClick={() => reactToMessage(message, group.reaction, group.reactedByMe)} title={group.users.map((id) => memberById.get(id)?.display_name || "Team member").join(", ")}>{group.reaction} <span>{group.count}</span></button>)}<div className="chat-quick-reactions">{QUICK_REACTIONS.map((reaction) => <button key={reaction} title={`React ${reaction}`} onClick={() => reactToMessage(message, reaction, reactions.some((group) => group.reaction === reaction && group.reactedByMe))}>{reaction}</button>)}</div></div>}
                  </div>
                </article>;
              })}
              {Object.keys(typingUsers).length > 0 && <div className="chat-typing-indicator"><span className="chat-typing-dots"><i /><i /><i /></span>{Object.values(typingUsers).map((item) => item.displayName).join(", ")} {Object.keys(typingUsers).length > 1 ? "are" : "is"} typing…</div>}
            </section>
            {showMembers && <aside className="chat-members-panel"><div className="chat-panel-heading"><h3>Conversation members</h3><button className="chat-icon-button" onClick={() => setShowMembers(false)} aria-label="Close members">×</button></div><div className="chat-members-list">{members.map((member) => <div className="chat-member-row" key={member.id}><span className="chat-avatar" aria-hidden="true">{safeDisplayName(member.display_name).slice(0,1).toUpperCase()}</span><span><strong>{member.display_name}</strong><small>{member.role}{member.status !== "active" ? ` · ${member.status}` : ""}</small></span>{member.user_id === userId && <span className="chat-muted">You</span>}{member.status === "active" && selectedConversation.kind !== "direct" && (isMaster || members.some((item) => item.user_id === userId && item.role === "owner")) && member.role !== "owner" && <button className="chat-button quiet" onClick={() => transferConversationOwnership(member)}>Make owner</button>}{member.status === "active" && selectedConversation.kind !== "direct" && (isMaster || members.some((item) => item.user_id === userId && ["owner","admin"].includes(item.role))) && member.role !== "owner" && <button className="chat-icon-button danger" onClick={() => removeConversationMember(member)} aria-label={`Remove ${member.display_name}`}>×</button>}</div>)}</div>{selectedConversation.kind === "group" && (isMaster || members.some((item) => item.user_id === userId && ["owner","admin"].includes(item.role))) && <div className="chat-add-member"><label>Add a studio member<select value={addingMemberId} onChange={(e) => setAddingMemberId(e.target.value)}><option value="">Choose a member…</option>{directory.filter((person) => !selectedMemberIds.has(person.user_id)).map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}</select></label><button className="chat-button secondary" onClick={addConversationMember} disabled={!addingMemberId}>Add member</button></div>}{selectedConversation.kind === "group" && (isMaster || members.some((item) => item.user_id === userId && ["owner","admin"].includes(item.role))) && <button className="chat-button quiet chat-rename-button" onClick={() => { const title = window.prompt("Group name", selectedConversation.title || ""); if (title?.trim()) chatApi.updateTitle(selectedId, title.trim()).then(refreshConversations).catch((error) => setActionError(errorText(error))); }}>Rename group</button>}</aside>}
          </div>
          <form className="chat-composer" onSubmit={sendMessage}>
            {replyTo && <div className="chat-replying-to"><span><strong>Replying to {replyTo.senderName}</strong><small>{replyTo.preview}</small></span><button type="button" className="chat-icon-button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button></div>}
            {selectedFiles.length > 0 && <div className="chat-selected-files">{selectedFiles.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setSelectedFiles((current) => current.filter((_, i) => i !== index))}>×</button></span>)}</div>}
            <div className="chat-composer-row"><button className="chat-attach-button" type="button" onClick={() => fileInputRef.current?.click()} title="Add attachment" aria-label="Add attachment">＋</button><input ref={fileInputRef} className="chat-file-input" type="file" multiple accept={[...new Set(["image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain","application/zip","video/mp4","video/webm","audio/mpeg","audio/mp4","audio/wav"])].join(",")} onChange={(e) => { setSelectedFiles((current) => [...current, ...Array.from(e.target.files || [])].slice(0, 10)); e.target.value = ""; }} /><textarea ref={composerRef} value={composer} onChange={(e) => { setComposer(e.target.value); sendTyping(true); }} onBlur={() => sendTyping(false)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendMessage(e); } }} placeholder={replyTo ? "Write a reply…" : "Message your team… (Enter to send, Shift+Enter for a new line)"} rows={1} maxLength={10000} aria-label="Write a chat message" disabled={sending} /><button className="chat-send-button" type="submit" disabled={sending || (!composer.trim() && !selectedFiles.length)} aria-label="Send message">{sending ? "…" : "➤"}</button></div><div className="chat-composer-footer"><span>Internal conversation · Plain text is supported</span><span>{composer.length.toLocaleString()} / 10,000</span></div>
          </form>
        </> : <div className="chat-welcome"><div className="chat-welcome-art" aria-hidden="true"><span>✦</span><span>↗</span><span>•••</span></div><span className="chat-eyebrow">YOUR STUDIO, IN SYNC</span><h2>Make room for good work.</h2><p>Direct messages, project discussions, and groups for the people who belong in your studio.</p><button className="chat-button primary" onClick={() => setShowNewConversation(true)}>Start a conversation</button><div className="chat-welcome-footnote">Internal chat is separate from client cut-review discussions. Access follows studio membership and conversation permissions.</div></div>}
      </main>

      {showNewConversation && <div className="chat-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNewConversation(false); }}><form className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-create-title" onSubmit={submitNewConversation}><div className="chat-modal-heading"><div><span className="chat-eyebrow">NEW CONVERSATION</span><h2 id="chat-create-title">Bring the right people together</h2></div><button type="button" className="chat-icon-button" onClick={() => setShowNewConversation(false)} aria-label="Close">×</button></div><div className="chat-kind-picker"><button type="button" className={newKind === "group" ? "active" : ""} onClick={() => { setNewKind("group"); setNewMemberIds([]); }}>Group</button><button type="button" className={newKind === "project" ? "active" : ""} onClick={() => { setNewKind("project"); setNewMemberIds([]); }}>Project discussion</button></div>{newKind === "group" ? <><label>Group name<input required maxLength={100} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Production stand-up" /></label>{departments.length > 0 && <label>Department scope (optional)<select value={newDepartmentId} onChange={(e) => setNewDepartmentId(e.target.value)}><option value="">General group</option>{departments.map((department) => <option key={department.department_id} value={department.department_id}>{department.name}</option>)}</select><small className="chat-field-hint">Department scope restricts who can be added, but conversation access still requires explicit membership.</small></label>}</> : <><label>Project<select required value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}><option value="">Select a project you can access…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><p className="chat-field-hint">The current project model is owner-scoped. Until shared-project permissions exist, this discussion is limited to the project owner and Master User; other staff cannot be invited here yet. Use a regular group for team collaboration.</p></>}{newKind === "group" && <><label>Invite studio members <span className="chat-field-hint">Optional — you can add people later.</span></label><div className="chat-member-picker">{directory.map((person) => <label className="chat-member-choice" key={person.user_id}><input type="checkbox" checked={newMemberIds.includes(person.user_id)} onChange={(e) => setNewMemberIds((current) => e.target.checked ? [...new Set([...current, person.user_id])] : current.filter((id) => id !== person.user_id))} /><span className="chat-avatar" aria-hidden="true">{safeDisplayName(person.display_name).slice(0,1).toUpperCase()}</span><span><strong>{person.display_name}</strong><small>{ROLE_LABELS[person.role] || person.role}</small></span></label>)}{!directory.length && <p className="chat-muted">No other authenticated staff or freelancer accounts are registered in this studio yet.</p>}</div></>}<div className="chat-modal-footer"><button type="button" className="chat-button secondary" onClick={() => setShowNewConversation(false)}>Cancel</button><button type="submit" className="chat-button primary">Create {newKind === "group" ? "group" : "project discussion"}</button></div></form></div>}

      {editHistory && <div className="chat-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditHistory(null); }}><section className="chat-modal small" role="dialog" aria-modal="true" aria-labelledby="chat-history-title"><div className="chat-modal-heading"><h2 id="chat-history-title">Message edit history</h2><button type="button" className="chat-icon-button" onClick={() => setEditHistory(null)} aria-label="Close history">×</button></div>{editHistory.rows.length ? <div className="chat-history-list">{editHistory.rows.map((row) => <article key={row.id}><time>{formatChatTime(row.changed_at)}</time><strong>{memberById.get(row.editor_user_id)?.display_name || "Authorized editor"}</strong><small>Previous text</small><p>{row.old_body}</p><small>Updated text</small><p>{row.new_body}</p></article>)}</div> : <p className="chat-muted">No edits have been recorded for this message.</p>}<div className="chat-modal-footer"><button className="chat-button secondary" onClick={() => setEditHistory(null)}>Close</button></div></section></div>}

      {editingId && <div className="chat-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditingId(null); }}><form className="chat-modal small" role="dialog" aria-modal="true" aria-labelledby="chat-edit-title" onSubmit={(e) => { e.preventDefault(); const row = messages.find((message) => message.id === editingId); if (row) editMessage(row); }}><div className="chat-modal-heading"><h2 id="chat-edit-title">Edit message</h2><button type="button" className="chat-icon-button" onClick={() => setEditingId(null)} aria-label="Close editor">×</button></div><textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} maxLength={10000} rows={5} aria-label="Edited message text" autoFocus /><div className="chat-modal-footer"><button type="button" className="chat-button secondary" onClick={() => setEditingId(null)}>Cancel</button><button type="submit" className="chat-button primary" disabled={busyMessageId === editingId}>Save edit</button></div></form></div>}
    </section>
  );
}
