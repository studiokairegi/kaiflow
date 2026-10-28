import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatApi } from "./api.js";
import {
  CHAT_PAGE_SIZE, chatErrorText, conversationLabel, formatChatTime, groupReactions,
  mergeMessages, messageCursor, normalizeMessageBody, safeDisplayName, validateMessage,
} from "./logic.js";
import { canCreateGroups as accessCanCreateGroups, canViewDirectory as accessCanViewDirectory } from "../studio/access.js";
import Composer from "./Composer.jsx";
import MessageList from "./MessageList.jsx";
import { PortalList, PortalThread } from "./PortalInbox.jsx";
import { initials, outboxToMessages, useOutbox, usePolling, useVisualViewport } from "./hooks.js";
import {
  IconBack, IconClose, IconDirect, IconFolder, IconGroup, IconInbox, IconMembers, IconNewChat, IconPin, IconSearch,
} from "./icons.jsx";
import "./chat.css";

const ROLE_LABELS = { master_user: "Master User", department_admin: "Department administrator", staff: "Staff", freelancer: "Freelancer", client: "Client" };
const NOOP = () => {};
const ATTACH_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,application/zip,video/mp4,video/webm,audio/mpeg,audio/mp4,audio/wav";

function ConversationAvatar({ item, className = "" }) {
  const kind = item.kind;
  return <span className={`chat-avatar ${kind === "group" ? "group" : kind === "project" ? "project" : ""} ${className}`} aria-hidden="true">
    {kind === "group" ? <IconGroup size={19} /> : kind === "project" ? <IconFolder size={19} /> : initials(item.title)}
  </span>;
}

export default function ChatPage({
  userId, initialConversationId = null, initialMessageId = null, activeOrganizationId = "", theme = "dark",
  onOrganizationChange = NOOP, onConversationChange = NOOP, onUnreadCountChange = NOOP, onIncomingMessage = NOOP, onClose = NOOP,
}) {
  useVisualViewport();
  const [memberships, setMemberships] = useState([]);
  const [organizationId, setOrganizationId] = useState(activeOrganizationId || "");
  const [caps, setCaps] = useState({ createGroups: false, viewDirectory: false });
  const [directory, setDirectory] = useState([]);
  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [portalThreads, setPortalThreads] = useState([]);
  const [portalSelected, setPortalSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [pins, setPins] = useState([]);
  const [selectedId, setSelectedId] = useState(initialConversationId || null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [toneBaselineReady, setToneBaselineReady] = useState(false); // true once conversations + portal threads have loaded
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [composer, setComposer] = useState("");
  const [composerError, setComposerError] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editHistory, setEditHistory] = useState(null);
  const [busyMessageId, setBusyMessageId] = useState(null);
  const [sideMode, setSideMode] = useState("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [peopleFilter, setPeopleFilter] = useState("");
  const [typingUsers, setTypingUsers] = useState({});
  const [onlineCount, setOnlineCount] = useState(0);
  const [realtimeStatus, setRealtimeStatus] = useState("joining");
  const [drawer, setDrawer] = useState(null); // "pins" | "members"
  const [showNew, setShowNew] = useState(false);
  const [newKind, setNewKind] = useState("direct");
  const [newTitle, setNewTitle] = useState("");
  const [newMemberIds, setNewMemberIds] = useState([]);
  const [newDepartmentId, setNewDepartmentId] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [newFilter, setNewFilter] = useState("");
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState("");
  const [addingMemberId, setAddingMemberId] = useState("");
  const [downloadBusyId, setDownloadBusyId] = useState(null);
  const [jumpMessageId, setJumpMessageId] = useState(null);

  const activeMembership = useMemo(() => memberships.find((item) => item.organization_id === organizationId) || null, [memberships, organizationId]);
  const isMaster = activeMembership?.role === "master_user";
  const isClient = activeMembership?.role === "client";
  const currentDisplayName = safeDisplayName(activeMembership?.display_name, "You");
  const selectedConversation = useMemo(() => conversations.find((c) => c.conversation_id === selectedId) || null, [conversations, selectedId]);
  const selectedPortal = useMemo(() => portalThreads.find((t) => t.thread_id === portalSelected) || null, [portalThreads, portalSelected]);
  const showPortalTab = isMaster || portalThreads.length > 0;
  const portalMode = sideMode === "portal";
  const canCreateGroups = isMaster || caps.createGroups;

  const nameById = useMemo(() => {
    const lookup = new Map(directory.map((p) => [p.user_id, p.display_name]));
    members.forEach((m) => { if (m.display_name) lookup.set(m.user_id, m.display_name); });
    return lookup;
  }, [directory, members]);
  const nameOf = useCallback((id) => nameById.get(id) || "Team member", [nameById]);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? conversations.filter((c) => `${c.title || ""} ${c.last_message_body || ""}`.toLowerCase().includes(q)) : conversations;
  }, [conversations, searchQuery]);
  const filteredDirectory = useMemo(() => {
    const q = peopleFilter.trim().toLowerCase();
    return directory.filter((p) => !q || `${p.display_name} ${ROLE_LABELS[p.role] || p.role} ${(p.department_names || []).join(" ")}`.toLowerCase().includes(q));
  }, [directory, peopleFilter]);
  const selectedMemberIds = useMemo(() => new Set(members.filter((m) => m.status === "active").map((m) => m.user_id)), [members]);
  const myMember = members.find((m) => m.user_id === userId && m.status === "active");
  const canManageMembers = selectedConversation?.kind === "group" && (isMaster || ["owner", "admin"].includes(myMember?.role));

  const subscriptionRef = useRef(null);
  const typingLastSentRef = useRef(0);
  const messagesRef = useRef(messages);
  const toneStateRef = useRef({ unread: null, playedAt: 0, selected: null });
  const incomingRef = useRef(onIncomingMessage);
  incomingRef.current = onIncomingMessage;
  const textareaRef = useRef(null);
  const lastConversationRef = useRef(null);
  const pendingTargetRef = useRef(null);
  messagesRef.current = messages;

  // ---- organization + access context ----
  useEffect(() => {
    if (!activeOrganizationId || activeOrganizationId === organizationId) return;
    if (!memberships.some((m) => m.organization_id === activeOrganizationId)) return;
    setOrganizationId(activeOrganizationId); setSelectedId(null); setMessages([]); setConversations([]); setPortalSelected(null);
    onConversationChange(null);
  }, [activeOrganizationId, organizationId, memberships, onConversationChange]);

  useEffect(() => { if (initialConversationId && initialConversationId !== selectedId) { setSelectedId(initialConversationId); setSideMode("recent"); } }, [initialConversationId, selectedId]);
  useEffect(() => { if (initialConversationId && selectedId === initialConversationId && initialMessageId) setJumpMessageId(initialMessageId); }, [initialConversationId, initialMessageId, selectedId]);

  useEffect(() => {
    const unread = conversations.reduce((t, c) => t + Math.max(0, Number(c.unread_count) || 0), 0)
      + portalThreads.reduce((t, c) => t + Math.max(0, Number(c.unread_count) || 0), 0);
    onUnreadCountChange(unread);
  }, [conversations, portalThreads, onUnreadCountChange]);

  const loadMemberships = useCallback(async () => {
    setLoadingWorkspace(true); setLoadError("");
    try {
      const rows = await chatApi.memberships();
      setMemberships(rows);
      if (rows.length && !rows.some((r) => r.organization_id === organizationId)) setOrganizationId(rows[0].organization_id);
      if (!rows.length) setOrganizationId("");
    } catch (error) { setLoadError(chatErrorText(error)); } finally { setLoadingWorkspace(false); }
  }, [organizationId]);
  useEffect(() => { loadMemberships(); }, [loadMemberships, userId]);

  // One tone per burst: realtime and background polling can both notice the same message.
  const playIncoming = useCallback(() => {
    const now = Date.now();
    if (now - toneStateRef.current.playedAt < 1200) return;
    toneStateRef.current.playedAt = now;
    incomingRef.current();
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!organizationId || !activeMembership || activeMembership.role === "client") return;
    try {
      const rows = await chatApi.conversations(organizationId);
      setConversations(rows);
      if (selectedId && !rows.some((r) => r.conversation_id === selectedId)) {
        setSelectedId(null); onConversationChange(null); setMessages([]); // lost access while open: close it
      }
    } catch (error) { setActionError(chatErrorText(error)); }
  }, [organizationId, activeMembership, selectedId, onConversationChange]);

  const refreshPortal = useCallback(async () => {
    if (!organizationId || !activeMembership || activeMembership.role === "client") return;
    try { setPortalThreads(await chatApi.portalThreads(organizationId)); } catch { /* portal chat is optional until its migration is applied */ }
  }, [organizationId, activeMembership]);

  const refreshWorkspace = useCallback(async () => {
    if (!organizationId || !activeMembership || activeMembership.role === "client") { setDirectory([]); setProjects([]); setDepartments([]); setConversations([]); setPortalThreads([]); return; }
    setLoadingWorkspace(true); setLoadError(""); setToneBaselineReady(false);
    try {
      const [people, depts, projs, convs, access] = await Promise.allSettled([
        chatApi.directory(organizationId), chatApi.departments(organizationId), chatApi.projectOptions(organizationId),
        chatApi.conversations(organizationId), chatApi.myAppAccessContext(organizationId),
      ]);
      if (people.status === "fulfilled") setDirectory(people.value);
      if (depts.status === "fulfilled") setDepartments(depts.value);
      if (projs.status === "fulfilled") setProjects(projs.value);
      if (convs.status === "fulfilled") setConversations(convs.value); else throw convs.reason;
      if (access.status === "fulfilled") setCaps({ createGroups: accessCanCreateGroups(access.value), viewDirectory: accessCanViewDirectory(access.value) });
      await refreshPortal();
      toneStateRef.current.unread = null; // the next effect pass records the baseline silently
      setToneBaselineReady(true);
    } catch (error) { setLoadError(chatErrorText(error)); } finally { setLoadingWorkspace(false); }
  }, [organizationId, activeMembership, refreshPortal]);
  useEffect(() => { refreshWorkspace(); }, [refreshWorkspace]);
  usePolling(refreshPortal, 30000, Boolean(organizationId) && !isClient, { hidden: true });

  // ---- members, pins, messages ----
  const loadMembers = useCallback(async (conversationId = selectedId) => {
    if (!conversationId || !organizationId) { setMembers([]); return; }
    try { setMembers(await chatApi.conversationMembers(conversationId, organizationId)); } catch (error) { setActionError(chatErrorText(error)); }
  }, [selectedId, organizationId]);

  const loadPins = useCallback(async (conversationId = selectedId) => {
    if (!conversationId) { setPins([]); return; }
    try {
      const rows = await chatApi.pins(conversationId);
      const resolved = await Promise.all(rows.slice(0, 40).map(async (pin) => {
        const local = messagesRef.current.find((m) => m.id === pin.message_id);
        let message = local;
        if (!message) { try { message = await chatApi.messageById(pin.message_id); } catch { message = null; } }
        return message ? { pinId: pin.id, messageId: pin.message_id, pinnedAt: pin.pinned_at, body: message.deleted_at ? "Deleted message" : (message.body || "Attachment"), sender: message.sender_user_id } : null;
      }));
      setPins(resolved.filter(Boolean));
    } catch { /* pins are best-effort */ }
  }, [selectedId]);

  const loadMessages = useCallback(async (conversationId, { append = false, targetMessageId = null } = {}) => {
    if (!conversationId) return;
    if (append) setLoadingOlder(true); else setLoadingMessages(true);
    try {
      let before = null;
      if (append) { before = messageCursor(messagesRef.current[0]); if (!before) return; }
      let rows; let targetFound = true;
      if (!append && targetMessageId) {
        const around = await chatApi.messagesAround(conversationId, targetMessageId, CHAT_PAGE_SIZE);
        rows = around.rows; targetFound = around.targetFound; setHasOlder(around.hasOlder);
      } else {
        rows = await chatApi.messages(conversationId, before, CHAT_PAGE_SIZE);
        setHasOlder(rows.length === CHAT_PAGE_SIZE);
      }
      if (append) setMessages((cur) => mergeMessages(rows, cur)); else setMessages(rows);
      if (!append) {
        const latest = targetMessageId && targetFound ? rows.find((r) => r.id === targetMessageId) : rows[rows.length - 1];
        try { await chatApi.markRead(conversationId, latest?.id || null); } catch { /* reconciled on next open */ }
        refreshConversations();
      }
      if (targetMessageId && targetFound) setJumpMessageId(targetMessageId);
      else if (targetMessageId) { setJumpMessageId(null); setNotice("That message is no longer available in this conversation."); }
    } catch (error) { setActionError(chatErrorText(error)); } finally { setLoadingMessages(false); setLoadingOlder(false); }
  }, [refreshConversations]);

  useEffect(() => {
    if (!selectedId || !activeMembership || isClient) { setMessages([]); setMembers([]); setPins([]); setHasOlder(false); return; }
    if (lastConversationRef.current !== selectedId) {
      lastConversationRef.current = selectedId;
      setMessages([]); setMembers([]); setPins([]); setReplyTo(null); setEditing(null); setEditHistory(null); setDrawer(null); setJumpMessageId(null); setActionError("");
    }
    const target = pendingTargetRef.current || (initialConversationId === selectedId ? initialMessageId : null);
    pendingTargetRef.current = null;
    loadMessages(selectedId, { targetMessageId: target });
    loadMembers(selectedId); loadPins(selectedId);
  }, [selectedId, organizationId, activeMembership, isClient, initialConversationId, initialMessageId, loadMessages, loadMembers, loadPins]);

  // ---- realtime ----
  useEffect(() => {
    if (!selectedId || !userId || !activeMembership || isClient) return undefined;
    let active = true;
    const reconcile = () => {
      chatApi.messages(selectedId).then((rows) => active && setMessages((cur) => mergeMessages(cur, rows))).catch(() => {});
      loadMembers(selectedId); refreshConversations();
    };
    const subscription = chatApi.subscribeConversation({
      conversationId: selectedId, userId, displayName: currentDisplayName,
      onMessage: async (payload) => {
        const row = payload?.new || payload?.old;
        if (!row?.id) return;
        try {
          const updated = await chatApi.messageById(row.id);
          if (!active || !updated) return;
          setMessages((cur) => mergeMessages(cur, [updated]));
          if (payload?.eventType === "INSERT" && updated.sender_user_id !== userId) playIncoming();
          if (updated.sender_user_id !== userId) chatApi.markRead(selectedId, updated.id).then(refreshConversations).catch(() => {});
        } catch { /* the next durable refresh reconciles */ }
      },
      onChange: (event) => {
        if (event?.status) {
          setRealtimeStatus(event.status === "SUBSCRIBED" ? "connected" : event.status.toLowerCase());
          if (event.status === "SUBSCRIBED" && active) reconcile();
        } else reconcile();
      },
      onTyping: (payload) => {
        if (!payload || payload.userId === userId) return;
        setTypingUsers((cur) => {
          const next = { ...cur };
          if (payload.isTyping) next[payload.userId] = { displayName: safeDisplayName(payload.displayName), expiresAt: Date.now() + 4500 }; else delete next[payload.userId];
          return next;
        });
      },
      onPresence: (state) => setOnlineCount(Object.values(state || {}).flat().filter((e) => e?.user_id && e.user_id !== userId).length),
    });
    subscriptionRef.current = subscription;
    setRealtimeStatus("joining");
    const accessRefresh = window.setInterval(() => { if (active) refreshConversations(); }, 15000);
    return () => {
      active = false; window.clearInterval(accessRefresh); subscription.unsubscribe();
      if (subscriptionRef.current === subscription) subscriptionRef.current = null;
      setRealtimeStatus("offline"); setTypingUsers({}); setOnlineCount(0);
    };
  }, [selectedId, userId, activeMembership, isClient, currentDisplayName, loadMembers, refreshConversations, playIncoming]);

  // Messages in conversations that are not open arrive via polling: a rise in unread plays the tone.
  usePolling(refreshConversations, 20000, Boolean(organizationId) && !isClient, { hidden: true });
  useEffect(() => {
    const total = conversations.filter((c) => c.conversation_id !== selectedId).reduce((n, c) => n + Math.max(0, Number(c.unread_count) || 0), 0)
      + portalThreads.reduce((n, t) => n + Math.max(0, Number(t.unread_count) || 0), 0);
    if (!toneBaselineReady) return;
    const previous = toneStateRef.current.unread;
    const sameView = toneStateRef.current.selected === selectedId;
    toneStateRef.current.unread = total;
    toneStateRef.current.selected = selectedId;
    if (sameView && previous !== null && total > previous) playIncoming(); // switching chats only moves the baseline
  }, [conversations, portalThreads, selectedId, playIncoming, toneBaselineReady]);

  useEffect(() => {
    if (!Object.keys(typingUsers).length) return undefined;
    const timer = window.setInterval(() => { const now = Date.now(); setTypingUsers((cur) => Object.fromEntries(Object.entries(cur).filter(([, v]) => v.expiresAt > now))); }, 1600);
    return () => window.clearInterval(timer);
  }, [typingUsers]);

  // ---- navigation ----
  const chooseConversation = (id) => { setSelectedId(id); setPortalSelected(null); onConversationChange(id); setSideMode("recent"); setActionError(""); };
  const choosePortal = (id) => { setPortalSelected(id); setSelectedId(null); onConversationChange(null); };

  const startDirect = async (person) => {
    setNewBusy(true); setNewError("");
    try {
      const id = await chatApi.startDirect(organizationId, person.user_id);
      await refreshConversations(); setShowNew(false); chooseConversation(id);
    } catch (error) { setNewError(chatErrorText(error)); } finally { setNewBusy(false); }
  };

  const submitNewGroupOrProject = async (event) => {
    event.preventDefault();
    setNewBusy(true); setNewError("");
    try {
      const id = await chatApi.createConversation({
        organizationId, kind: newKind, title: newTitle, memberIds: newKind === "project" ? [] : newMemberIds,
        departmentId: newKind === "group" ? (newDepartmentId || null) : null, projectId: newKind === "project" ? (newProjectId || null) : null,
      });
      setShowNew(false); setNewTitle(""); setNewMemberIds([]); setNewDepartmentId(""); setNewProjectId("");
      await refreshConversations(); chooseConversation(id);
      setNotice(newKind === "project" ? "Project conversation created." : "Group created.");
    } catch (error) { setNewError(chatErrorText(error)); } finally { setNewBusy(false); }
  };

  const openNew = (kind = "direct") => { setNewKind(kind); setNewError(""); setNewFilter(""); setShowNew(true); };

  // ---- sending (optimistic outbox) ----
  const outbox = useOutbox({
    send: async (item) => {
      const messageId = await chatApi.sendMessage({ conversationId: item.scope, body: item.body, files: item.files, replyToId: item.replyToId, idempotencyKey: item.key });
      return { messageId, conversationId: item.scope, row: await chatApi.messageById(messageId).catch(() => null) };
    },
    onSent: ({ messageId, conversationId, row }) => {
      if (row) setMessages((cur) => (cur.length === 0 && lastConversationRef.current !== conversationId ? cur : mergeMessages(cur, [row])));
      refreshConversations();
      chatApi.markRead(conversationId, messageId).catch(() => {});
    },
    errorText: chatErrorText,
  });

  const sendTyping = (isTyping) => {
    const subscription = subscriptionRef.current;
    if (!subscription) return;
    const now = Date.now();
    if (isTyping && now - typingLastSentRef.current < 1400) return;
    typingLastSentRef.current = now;
    subscription.setTyping(isTyping).catch(() => {});
  };

  const submitMessage = () => {
    if (!selectedId) return;
    const body = normalizeMessageBody(composer);
    const validation = validateMessage(body, selectedFiles);
    if (!validation.ok) { setComposerError(validation.error); return; }
    setComposerError("");
    outbox.enqueue({ scope: selectedId, body, files: selectedFiles, replyToId: replyTo?.id || null, replyTo: replyTo ? { id: replyTo.id, name: replyTo.senderName, preview: replyTo.preview } : null });
    setComposer(""); setSelectedFiles([]); setReplyTo(null); sendTyping(false);
    textareaRef.current?.focus();
  };

  // ---- message actions ----
  const refreshOne = async (id) => { const row = await chatApi.messageById(id); if (row) setMessages((cur) => mergeMessages(cur, [row])); return row; };
  const guarded = (message, fn) => async (...args) => {
    setBusyMessageId(message.id); setActionError("");
    try { await fn(...args); } catch (error) { setActionError(chatErrorText(error)); } finally { setBusyMessageId(null); }
  };
  const actions = useMemo(() => ({
    reply: (m) => { setReplyTo({ id: m.id, senderName: m.mine ? "yourself" : m.senderName, preview: (m.body || "Attachment").slice(0, 160) }); textareaRef.current?.focus(); },
    react: (m, reaction, reacted) => guarded(m, async () => { await chatApi.setReaction(m.id, reaction, !reacted); await refreshOne(m.id); })(),
    pin: (m, active) => guarded(m, async () => { await chatApi.togglePin(m.id, active); await refreshOne(m.id); loadPins(); })(),
    edit: (m) => setEditing({ id: m.id, body: m.body }),
    history: async (m) => { try { setEditHistory({ rows: await chatApi.messageHistory(m.id) }); } catch (error) { setActionError(chatErrorText(error)); } },
    remove: (m) => {
      if (!window.confirm("Delete this message? Its history is retained for accountability.")) return;
      guarded(m, async () => {
        const result = await chatApi.deleteMessage(m.id); await refreshOne(m.id); loadPins();
        setNotice(result?.cleanupWarning ? "Message deleted. Attachment cleanup needs a retry; the files are not available in chat." : "Message deleted.");
      })();
    },
    jumpTo: (id) => { if (messagesRef.current.some((m) => m.id === id)) setJumpMessageId(id); else setNotice("The original message isn't in the loaded history. Load earlier messages to reach it."); },
    retry: (m) => outbox.retry(m.id), discard: (m) => outbox.discard(m.id),
    openAttachment: async (attachment) => {
      if (attachment.local) return;
      setDownloadBusyId(attachment.id); setActionError("");
      let popup = null;
      try {
        popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
        const url = await chatApi.signedAttachmentUrl(attachment.object_path);
        if (!url) throw new Error("Attachment link could not be created.");
        if (popup) popup.location.href = url; else window.location.assign(url);
      } catch (error) { popup?.close(); setActionError(chatErrorText(error)); } finally { setDownloadBusyId(null); }
    },
  }), [outbox, loadPins]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveEdit = async (event) => {
    event.preventDefault();
    const body = normalizeMessageBody(editing.body);
    if (!body) { setActionError("A message can't be empty when editing."); return; }
    setBusyMessageId(editing.id);
    try { await chatApi.editMessage(editing.id, body); await refreshOne(editing.id); setEditing(null); setNotice("Message updated."); }
    catch (error) { setActionError(chatErrorText(error)); } finally { setBusyMessageId(null); }
  };

  const viewMessages = useMemo(() => messages.map((row) => {
    const mine = row.sender_user_id === userId;
    const parent = row.reply_to_id ? messages.find((m) => m.id === row.reply_to_id) : null;
    const name = mine ? "You" : nameOf(row.sender_user_id);
    return {
      id: row.id, senderKey: row.sender_user_id, senderName: name, avatar: initials(name), mine, body: row.body || "", createdAt: row.created_at,
      edited: Boolean(row.edited_at), deleted: Boolean(row.deleted_at), pinned: (row.chat_pins || []).length > 0,
      canEdit: mine && !row.deleted_at && Date.now() - Date.parse(row.created_at) < 15 * 60 * 1000,
      canDelete: mine || (isMaster && selectedConversation?.kind !== "direct"),
      attachments: row.chat_attachments || [],
      reactions: groupReactions(row.chat_reactions || [], userId).map((g) => ({ reaction: g.reaction, count: g.count, reactedByMe: g.reactedByMe, names: g.users.map(nameOf) })),
      replyTo: row.reply_to_id ? { id: row.reply_to_id, name: parent ? (parent.sender_user_id === userId ? "You" : nameOf(parent.sender_user_id)) : "Earlier message", preview: parent ? (parent.deleted_at ? "Deleted message" : (parent.body || "Attachment").slice(0, 120)) : "Message not loaded" } : null,
    };
  }), [messages, userId, nameOf, isMaster, selectedConversation]);
  const pendingMessages = useMemo(() => outboxToMessages(outbox.items.filter((i) => i.scope === selectedId), { senderKey: userId, senderName: "You" }), [outbox.items, selectedId, userId]);
  const typingNames = Object.values(typingUsers).map((t) => t.displayName);

  const runSearch = async (event) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) { setActionError("Enter at least two characters to search."); return; }
    setSearching(true); setActionError(""); setSideMode("search");
    try { setSearchResults(await chatApi.search(organizationId, query)); } catch (error) { setActionError(chatErrorText(error)); } finally { setSearching(false); }
  };
  const visitSearchResult = (result) => {
    if (result.conversation_id === selectedId) { actions.jumpTo(result.message_id); return; }
    pendingTargetRef.current = result.message_id; // the conversation effect loads a window around it
    chooseConversation(result.conversation_id);
  };

  const addConversationMember = async () => {
    if (!addingMemberId) return;
    try { await chatApi.addMember(selectedId, addingMemberId); setAddingMemberId(""); await Promise.all([loadMembers(selectedId), refreshConversations()]); setNotice("Member added."); }
    catch (error) { setActionError(chatErrorText(error)); }
  };
  const transferOwnership = async (member) => {
    if (!window.confirm(`Make ${member.display_name} the conversation owner? You may lose owner-only controls.`)) return;
    try { await chatApi.transferOwnership(selectedId, member.user_id); await Promise.all([loadMembers(selectedId), refreshConversations()]); setNotice("Ownership updated."); }
    catch (error) { setActionError(chatErrorText(error)); }
  };
  const removeMember = async (member) => {
    if (!window.confirm(`Remove ${member.display_name || "this member"} from this conversation?`)) return;
    try { await chatApi.removeMember(selectedId, member.user_id); await Promise.all([loadMembers(selectedId), refreshConversations()]); if (member.user_id === userId) chooseConversation(null); setNotice("Membership updated."); }
    catch (error) { setActionError(chatErrorText(error)); }
  };

  const themeClass = `chat-root chat-theme-${theme}`;
  const closeBtn = <button type="button" className="chat-icon-btn chat-state-close" onClick={onClose} aria-label="Close chat"><IconClose /></button>;
  if (loadingWorkspace && !memberships.length) return <div className={`${themeClass} chat-state-card`}>{closeBtn}<div className="chat-spinner" aria-hidden="true" /><h2>Opening chat</h2><p>Checking your studio access…</p></div>;
  if (loadError && !memberships.length) return <div className={`${themeClass} chat-state-card`}>{closeBtn}<h2>Chat couldn't load</h2><p>{loadError}</p><button type="button" className="chat-button primary" onClick={loadMemberships}>Retry</button></div>;
  if (!memberships.length) return <div className={`${themeClass} chat-state-card`}>{closeBtn}<h2>Chat needs studio access</h2><p>This login isn't linked to a KairFlow studio yet. Ask the studio owner to invite you from Teams.</p><button type="button" className="chat-button" onClick={loadMemberships}>Check access again</button></div>;
  if (isClient) return <div className={`${themeClass} chat-state-card`}>{closeBtn}<h2>Internal chat isn't available to client accounts</h2><p>Clients use the conversation inside their client portal link.</p></div>;

  const hasMain = Boolean(selectedConversation || selectedPortal);
  return (
    <section className={`${themeClass} chat-page${hasMain ? " has-active-conversation" : ""}`} aria-label="Studio chat">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-top">
          <div className="chat-topbar">
            <h2>Messages</h2>
            <button type="button" className="chat-icon-btn solid" onClick={() => openNew("direct")} aria-label="New chat" title="New chat"><IconNewChat /></button>
            <button type="button" className="chat-icon-btn" onClick={onClose} aria-label="Close chat" title="Close"><IconClose /></button>
          </div>
          {memberships.length > 1 && <select className="chat-org-select" aria-label="Choose studio" value={organizationId} onChange={(e) => { const next = e.target.value; setOrganizationId(next); setSelectedId(null); setMessages([]); setPortalSelected(null); onConversationChange(null); onOrganizationChange(next); }}>
            {memberships.map((m) => <option key={m.organization_id} value={m.organization_id}>{m.organization_name}</option>)}
          </select>}
          <form className="chat-search" onSubmit={runSearch}>
            <IconSearch size={17} />
            <input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); if (sideMode === "search") setSideMode("recent"); }} placeholder="Search chats · Enter to search messages" aria-label="Search chats and messages" />
            {searching && <span className="chat-spinner xs" aria-hidden="true" />}
          </form>
          <div className="chat-tabs" role="tablist" aria-label="Chat views">
            <button type="button" role="tab" aria-selected={sideMode === "recent"} className={sideMode === "recent" ? "active" : ""} onClick={() => setSideMode("recent")}>Chats</button>
            <button type="button" role="tab" aria-selected={sideMode === "people"} className={sideMode === "people" ? "active" : ""} onClick={() => setSideMode("people")}>People</button>
            {showPortalTab && <button type="button" role="tab" aria-selected={portalMode} className={portalMode ? "active" : ""} onClick={() => setSideMode("portal")}>Clients{portalThreads.some((t) => Number(t.unread_count) > 0) && <span className="dot" aria-label="unread client messages">{portalThreads.reduce((n, t) => n + Number(t.unread_count || 0), 0)}</span>}</button>}
            {searchResults.length > 0 && <button type="button" role="tab" aria-selected={sideMode === "search"} className={sideMode === "search" ? "active" : ""} onClick={() => setSideMode("search")}>Results</button>}
          </div>
        </div>
        <div className="chat-sidebar-list">
          {sideMode === "recent" && <>
            {!filteredConversations.length && <div className="chat-empty"><span className="glyph" aria-hidden="true"><IconNewChat size={26} /></span><strong>{loadingWorkspace ? "Loading…" : "No conversations yet"}</strong><p>Start a chat with the new-chat button above.</p></div>}
            {filteredConversations.map((item) => (
              <button type="button" key={item.conversation_id} className={`chat-row${selectedId === item.conversation_id ? " active" : ""}`} onClick={() => chooseConversation(item.conversation_id)}>
                <ConversationAvatar item={item} />
                <span className="chat-row-copy">
                  <span className="chat-row-title"><strong>{item.title || "Conversation"}</strong><time>{formatChatTime(item.last_message_at || item.updated_at)}</time></span>
                  <span className="chat-row-preview">{item.last_message_body || (item.kind === "project" ? "Project conversation" : item.kind === "group" ? "Group" : "Say hello")}</span>
                </span>
                {Number(item.unread_count) > 0 && <span className="chat-unread" aria-label={`${item.unread_count} unread`}>{item.unread_count > 99 ? "99+" : item.unread_count}</span>}
              </button>
            ))}
          </>}
          {sideMode === "people" && <>
            <input className="chat-inline-filter" value={peopleFilter} onChange={(e) => setPeopleFilter(e.target.value)} placeholder="Find a teammate…" aria-label="Find a teammate" />
            {!filteredDirectory.length && <div className="chat-empty"><strong>No teammates to show</strong><p>{isMaster || caps.viewDirectory ? "Only authenticated studio members appear here." : "You can see people you already chat with. Ask the studio owner for directory access to find others."}</p></div>}
            {filteredDirectory.map((person) => (
              <button type="button" key={person.user_id} className="chat-row" onClick={() => startDirect(person)} aria-label={`Message ${person.display_name}`}>
                <span className="chat-avatar" aria-hidden="true">{initials(person.display_name)}</span>
                <span className="chat-row-copy"><span className="chat-row-title"><strong>{person.display_name}</strong></span><span className="chat-row-preview">{ROLE_LABELS[person.role] || person.role}{person.department_names?.length ? ` · ${person.department_names.join(", ")}` : ""}</span></span>
              </button>
            ))}
          </>}
          {sideMode === "portal" && <PortalList threads={portalThreads} selectedId={portalSelected} onSelect={choosePortal} loading={loadingWorkspace} />}
          {sideMode === "search" && <>
            {searchResults.map((r) => <button type="button" className="chat-row" key={r.message_id} onClick={() => visitSearchResult(r)}><span className="chat-row-copy"><span className="chat-row-title"><strong>{r.sender_name}</strong><time>{formatChatTime(r.created_at)}</time></span><span className="chat-row-preview">{r.body}</span></span></button>)}
            {!searchResults.length && <div className="chat-empty"><strong>No matching messages</strong></div>}
          </>}
        </div>
      </aside>

      <main className="chat-main">
        {selectedPortal && <PortalThread key={selectedPortal.thread_id} organizationId={organizationId} userId={userId} thread={selectedPortal} onBack={() => setPortalSelected(null)} onChanged={refreshPortal} />}
        {selectedConversation && !selectedPortal && <>
          <header className="chat-header">
            <button type="button" className="chat-icon-btn chat-back" aria-label="Back to conversations" onClick={() => chooseConversation(null)}><IconBack /></button>
            <ConversationAvatar item={selectedConversation} />
            <div className="chat-header-copy">
              <h2>{conversationLabel(selectedConversation, userId, members)}</h2>
              <p>{selectedConversation.kind === "direct" ? "Direct message" : selectedConversation.kind === "project" ? "Internal project discussion" : `${members.filter((m) => m.status === "active").length} members`}{onlineCount ? ` · ${onlineCount} online` : ""}</p>
            </div>
            <span className={`chat-live${realtimeStatus === "connected" ? " on" : ""}`} title={`Realtime: ${realtimeStatus}`}><i />{realtimeStatus === "connected" ? "Live" : "…"}</span>
            <button type="button" className={`chat-icon-btn${drawer === "pins" ? " on" : ""}`} aria-label={`Pinned messages${pins.length ? ` (${pins.length})` : ""}`} aria-pressed={drawer === "pins"} title="Pinned messages" onClick={() => { setDrawer(drawer === "pins" ? null : "pins"); loadPins(); }}>
              <IconPin filled={drawer === "pins" || pins.length > 0} />{pins.length > 0 && <span className="count">{pins.length}</span>}
            </button>
            <button type="button" className={`chat-icon-btn${drawer === "members" ? " on" : ""}`} aria-label="Members" aria-pressed={drawer === "members"} title="Members" onClick={() => { setDrawer(drawer === "members" ? null : "members"); loadMembers(selectedId); }}><IconMembers /></button>
          </header>
          <div className="chat-body">
            <MessageList
              conversationKey={selectedId} messages={viewMessages} outbox={pendingMessages} typing={typingNames} loading={loadingMessages} hasOlder={hasOlder} loadingOlder={loadingOlder}
              onLoadOlder={() => { if (!loadingOlder && hasOlder) loadMessages(selectedId, { append: true }); }}
              jumpId={jumpMessageId} onJumpDone={() => setJumpMessageId(null)} actions={actions} busyId={busyMessageId} downloadBusyId={downloadBusyId}
              notices={<>
                {actionError && <div className="chat-alert error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError("")} aria-label="Dismiss error"><IconClose size={14} /></button></div>}
                {notice && <div className="chat-alert success" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notice"><IconClose size={14} /></button></div>}
              </>}
              empty={<div className="chat-empty"><strong>Start the conversation</strong><p>Only members of this conversation can read it.</p></div>}
            />
            {drawer === "pins" && (
              <aside className="chat-drawer" aria-label="Pinned messages">
                <div className="chat-drawer-head"><h3><IconPin size={15} filled /> Pinned messages</h3><button type="button" className="chat-icon-btn sm" onClick={() => setDrawer(null)} aria-label="Close pinned messages"><IconClose size={16} /></button></div>
                <div className="chat-drawer-body">
                  {!pins.length && <div className="chat-empty"><span className="glyph" aria-hidden="true"><IconPin size={24} /></span><strong>Nothing pinned</strong><p>Hover a message and choose the pin to keep it handy for everyone in this chat.</p></div>}
                  {pins.map((pin) => <button type="button" key={pin.pinId} className="chat-pin-item" onClick={() => { actions.jumpTo(pin.messageId); setDrawer(null); }}><small>{pin.sender === userId ? "You" : nameOf(pin.sender)} · pinned {formatChatTime(pin.pinnedAt)}</small><span>{pin.body}</span></button>)}
                </div>
              </aside>
            )}
            {drawer === "members" && (
              <aside className="chat-drawer" aria-label="Conversation members">
                <div className="chat-drawer-head"><h3>Members</h3><button type="button" className="chat-icon-btn sm" onClick={() => setDrawer(null)} aria-label="Close members"><IconClose size={16} /></button></div>
                <div className="chat-drawer-body">
                  {members.map((member) => (
                    <div className="chat-member" key={member.id}>
                      <span className="chat-avatar sm" aria-hidden="true">{initials(member.display_name)}</span>
                      <span><strong>{member.user_id === userId ? `${member.display_name} (you)` : member.display_name}</strong><small>{member.role}{member.status !== "active" ? ` · ${member.status}` : ""}</small></span>
                      {member.status === "active" && selectedConversation.kind !== "direct" && member.role !== "owner" && (isMaster || myMember?.role === "owner") && <button type="button" className="chat-link-btn" onClick={() => transferOwnership(member)}>Make owner</button>}
                      {member.status === "active" && canManageMembers && member.role !== "owner" && <button type="button" className="chat-icon-btn sm" aria-label={`Remove ${member.display_name}`} onClick={() => removeMember(member)}><IconClose size={15} /></button>}
                    </div>
                  ))}
                </div>
                {canManageMembers && <div className="chat-drawer-foot">
                  <select value={addingMemberId} onChange={(e) => setAddingMemberId(e.target.value)} aria-label="Add a member"><option value="">Add a member…</option>{directory.filter((p) => !selectedMemberIds.has(p.user_id)).map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}</select>
                  <button type="button" className="chat-button primary" onClick={addConversationMember} disabled={!addingMemberId}>Add member</button>
                  <button type="button" className="chat-button quiet" onClick={() => { const title = window.prompt("Group name", selectedConversation.title || ""); if (title?.trim()) chatApi.updateTitle(selectedId, title.trim()).then(refreshConversations).catch((error) => setActionError(chatErrorText(error))); }}>Rename group</button>
                </div>}
              </aside>
            )}
          </div>
          <Composer value={composer} onChange={setComposer} onSend={submitMessage} onTyping={sendTyping} files={selectedFiles} onFilesChange={setSelectedFiles} accept={ATTACH_ACCEPT}
            replyTo={replyTo} onCancelReply={() => setReplyTo(null)} textareaRef={textareaRef} error={composerError}
            placeholder={replyTo ? "Write a reply…" : "Message…"} footerNote="Enter to send · Shift+Enter for a new line" />
        </>}
        {!hasMain && (
          <div className="chat-welcome">
            <span className="glyph" aria-hidden="true"><IconNewChat size={30} /></span>
            <h2>{portalMode ? "Clients & guests" : "Your studio, in sync"}</h2>
            <p>{portalMode ? "Pick a client or guest conversation. Internal notes stay private to your team." : "Direct messages, project discussions and groups for the people who belong in your studio."}</p>
            {!portalMode && <button type="button" className="chat-button primary" onClick={() => openNew("direct")}><IconNewChat size={18} /> New chat</button>}
          </div>
        )}
      </main>

      {showNew && (
        <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNew(false); }}>
          <div className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-new-title">
            <div className="chat-modal-head"><h2 id="chat-new-title">New chat</h2><button type="button" className="chat-icon-btn" onClick={() => setShowNew(false)} aria-label="Close"><IconClose /></button></div>
            <div className="chat-kind-tabs" role="tablist" aria-label="Conversation type">
              {[["direct", "Direct", IconDirect], ["group", "Group", IconGroup], ["project", "Project", IconFolder]].map(([kind, label, Icon]) => (
                <button type="button" role="tab" key={kind} aria-selected={newKind === kind} className={newKind === kind ? "active" : ""} aria-disabled={kind === "group" && !canCreateGroups} onClick={() => { setNewKind(kind); setNewError(""); }}><Icon size={20} />{label}</button>
              ))}
            </div>
            {newError && <div className="chat-alert error" role="alert" style={{ margin: "0 18px 8px" }}><span>{newError}</span></div>}
            {newKind === "direct" && <div className="chat-modal-body">
              <input className="chat-inline-filter" value={newFilter} onChange={(e) => setNewFilter(e.target.value)} placeholder="Search people…" aria-label="Search people" autoFocus />
              <div className="chat-picker">
                {directory.filter((p) => !newFilter.trim() || p.display_name.toLowerCase().includes(newFilter.trim().toLowerCase())).map((person) => (
                  <button type="button" key={person.user_id} className="chat-row" disabled={newBusy} onClick={() => startDirect(person)}><span className="chat-avatar sm" aria-hidden="true">{initials(person.display_name)}</span><span className="chat-row-copy"><span className="chat-row-title"><strong>{person.display_name}</strong></span><span className="chat-row-preview">{ROLE_LABELS[person.role] || person.role}</span></span></button>
                ))}
                {!directory.length && <div className="chat-empty"><strong>No one to message yet</strong></div>}
              </div>
              {!isMaster && !caps.viewDirectory && <p className="chat-hint">You can message people you already share a conversation with. Ask the studio owner for directory access to find others.</p>}
            </div>}
            {newKind === "group" && (canCreateGroups ? (
              <form className="chat-modal-body" onSubmit={submitNewGroupOrProject}>
                <label className="chat-field">Group name<input required maxLength={100} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Production stand-up" autoFocus /></label>
                {departments.length > 0 && <label className="chat-field">Department (optional)<select value={newDepartmentId} onChange={(e) => setNewDepartmentId(e.target.value)}><option value="">General group</option>{departments.map((d) => <option key={d.department_id} value={d.department_id}>{d.name}</option>)}</select></label>}
                <div className="chat-field">Members</div>
                <div className="chat-picker">
                  {directory.map((person) => <label className="chat-choice" key={person.user_id}><input type="checkbox" checked={newMemberIds.includes(person.user_id)} onChange={(e) => setNewMemberIds((cur) => e.target.checked ? [...new Set([...cur, person.user_id])] : cur.filter((id) => id !== person.user_id))} /><span className="chat-avatar sm" aria-hidden="true">{initials(person.display_name)}</span><span><strong>{person.display_name}</strong><small>{ROLE_LABELS[person.role] || person.role}</small></span></label>)}
                  {!directory.length && <div className="chat-empty"><strong>No one else is available to add</strong></div>}
                </div>
                <div className="chat-modal-foot" style={{ padding: "8px 0 4px", border: 0 }}><button type="button" className="chat-button quiet" onClick={() => setShowNew(false)}>Cancel</button><button type="submit" className="chat-button primary" disabled={newBusy || !newTitle.trim()}>{newBusy ? "Creating…" : "Create group"}</button></div>
              </form>
            ) : <div className="chat-modal-body"><div className="chat-empty"><span className="glyph" aria-hidden="true"><IconGroup size={24} /></span><strong>Group creation isn't enabled for you</strong><p>Only the studio owner can create groups by default. Ask them to turn it on for your account, or start a direct message instead.</p></div></div>)}
            {newKind === "project" && (
              <form className="chat-modal-body" onSubmit={submitNewGroupOrProject}>
                <label className="chat-field">Project<select required value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}><option value="">Select a project you can access…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <p className="chat-hint">Project discussions are limited to people who already have access to that project.</p>
                <div className="chat-modal-foot" style={{ padding: "8px 0 4px", border: 0 }}><button type="button" className="chat-button quiet" onClick={() => setShowNew(false)}>Cancel</button><button type="submit" className="chat-button primary" disabled={newBusy || !newProjectId}>{newBusy ? "Creating…" : "Create discussion"}</button></div>
              </form>
            )}
          </div>
        </div>
      )}

      {editHistory && (
        <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditHistory(null); }}>
          <section className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-history-title">
            <div className="chat-modal-head"><h2 id="chat-history-title">Edit history</h2><button type="button" className="chat-icon-btn" onClick={() => setEditHistory(null)} aria-label="Close history"><IconClose /></button></div>
            <div className="chat-modal-body">
              {!editHistory.rows.length && <p className="chat-hint">No edits recorded.</p>}
              {editHistory.rows.map((row) => <article className="chat-history-item" key={row.id}><time>{formatChatTime(row.changed_at)} · {nameOf(row.editor_user_id)}</time><small>Before</small><p>{row.old_body}</p><small>After</small><p>{row.new_body}</p></article>)}
            </div>
            <div className="chat-modal-foot"><button type="button" className="chat-button" onClick={() => setEditHistory(null)}>Close</button></div>
          </section>
        </div>
      )}

      {editing && (
        <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <form className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-edit-title" onSubmit={saveEdit}>
            <div className="chat-modal-head"><h2 id="chat-edit-title">Edit message</h2><button type="button" className="chat-icon-btn" onClick={() => setEditing(null)} aria-label="Close editor"><IconClose /></button></div>
            <div className="chat-modal-body"><div className="chat-field"><textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} maxLength={10000} rows={5} aria-label="Edited message" autoFocus /></div></div>
            <div className="chat-modal-foot"><button type="button" className="chat-button quiet" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="chat-button primary" disabled={busyMessageId === editing.id}>Save</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
