import React, { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";

const STAGES = [
  { id: "character_design", label: "Character Design" },
  { id: "bg_lighting", label: "BG & Lighting Design" },
  { id: "storyboard", label: "Storyboard" },
  { id: "layout", label: "Layout" },
  { id: "genga", label: "Genga" },
  { id: "douga", label: "Douga" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "frametest", label: "Frame Test" },
  { id: "cleanup", label: "Cleanup & Color" },
  { id: "compositing", label: "Compositing" },
  { id: "editing", label: "Editing" },
  { id: "delivered", label: "Delivered" },
];

const PRIORITY_COLORS = {
  low: "#7FE0D0",
  normal: "#2FBFA6",
  rush: "#F2A65A",
};

const REVIEW_COLORS = {
  in_progress: "#5C6B70",
  waiting: "#4A90D9",
  approved: "#3DDC84",
  revisions: "#FF4D4D",
};

const REVIEW_LABELS = {
  in_progress: "In Progress",
  waiting: "Waiting Review",
  approved: "Approved",
  revisions: "Requested Revisions",
};

const REVIEW_STATUS_ORDER = ["in_progress", "waiting", "approved", "revisions"];

const LEAD_STAGES = [
  { id: "pool", label: "Email Pool" },
  { id: "cold_email", label: "Cold Email" },
  { id: "no_response", label: "No Response" },
  { id: "responded", label: "Responded" },
  { id: "successful", label: "Successful Leads" },
  { id: "lost", label: "Lost Leads" },
  { id: "won", label: "Deal Won" },
  { id: "closed", label: "Deal Closed" },
];

const LOST_REASONS = [
  "Budget",
  "Timing",
  "Chose another studio",
  "No longer producing",
  "No response",
  "Other",
];

function stagePercent(stageId) {
  const index = STAGES.findIndex((s) => s.id === stageId);
  if (index === -1) return 0;
  return Math.round((index / (STAGES.length - 1)) * 100);
}

function projectProgress(projectCards) {
  const delivered = projectCards.filter((c) => c.stage === "delivered").length;
  if (projectCards.length === 0) return { delivered, percent: 0 };
  const total = projectCards.reduce((sum, c) => sum + stagePercent(c.stage), 0);
  const percent = Math.round(total / projectCards.length);
  return { delivered, percent };
}

function emptyCard(stage, projectId) {
  return {
    projectId,
    title: "",
    client: "",
    rate: "",
    due: "",
    priority: "normal",
    notes: "",
    stage,
    reviewStatus: "in_progress",
    revisions: [],
    revisionVersion: 1,
  };
}

function emptyProject(overrides = {}) {
  return {
    name: "",
    client: "",
    notes: "",
    shotCount: "",
    budget: "",
    deadline: "",
    priority: "normal",
    archived: false,
    ...overrides,
  };
}

function cardFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    client: row.client,
    rate: row.rate,
    due: row.due,
    priority: row.priority,
    notes: row.notes,
    stage: row.stage,
    reviewStatus: row.review_status || "in_progress",
    revisions: Array.isArray(row.revisions) ? row.revisions : [],
    revisionVersion: row.revision_version || 1,
  };
}

function cardToRow(card, userId) {
  return {
    project_id: card.projectId,
    title: card.title,
    client: card.client,
    rate: card.rate,
    due: card.due,
    priority: card.priority,
    notes: card.notes,
    stage: card.stage,
    review_status: card.reviewStatus || "in_progress",
    revisions: card.revisions || [],
    revision_version: card.revisionVersion || 1,
    user_id: userId,
  };
}

function shotFileName(card) {
  const slug = (card.title || "shot").trim().toLowerCase().replace(/\s+/g, "_");
  const version = String(card.revisionVersion || 1).padStart(2, "0");
  return `${slug}_${card.stage}_v${version}`;
}

function generateShotChecklist(count, projectId, client) {
  const total = Math.max(0, Math.min(500, parseInt(count, 10) || 0));
  const padWidth = Math.max(2, String(total).length);
  return Array.from({ length: total }, (_, i) => ({
    projectId,
    title: `Cut ${String(i + 1).padStart(padWidth, "0")}`,
    client: client || "",
    rate: "",
    due: "",
    priority: "normal",
    notes: "",
    stage: STAGES[0].id,
  }));
}

function emptyEmails() {
  return [
    { label: "Initial Email", message: "", sent: false, dateSent: null },
    { label: "Follow-up 1", message: "", sent: false, dateSent: null },
    { label: "Follow-up 2", message: "", sent: false, dateSent: null },
    { label: "Follow-up 3", message: "", sent: false, dateSent: null },
  ];
}

function emptyLead() {
  return {
    companyName: "",
    contactPerson: "",
    email: "",
    website: "",
    country: "",
    notes: "",
    stage: "pool",
    emails: emptyEmails(),
    proposedBudget: "",
    estimatedDeadline: "",
    projectNotes: "",
    lostReason: "",
    linkedProjectId: null,
  };
}

function leadFromRow(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    contactPerson: row.contact_person,
    email: row.email,
    website: row.website,
    country: row.country,
    notes: row.notes,
    stage: row.stage,
    emails: row.emails && row.emails.length ? row.emails : emptyEmails(),
    proposedBudget: row.proposed_budget,
    estimatedDeadline: row.estimated_deadline,
    projectNotes: row.project_notes,
    lostReason: row.lost_reason,
    linkedProjectId: row.linked_project_id,
  };
}

function leadToRow(lead, userId) {
  return {
    company_name: lead.companyName,
    contact_person: lead.contactPerson,
    email: lead.email,
    website: lead.website,
    country: lead.country,
    notes: lead.notes,
    stage: lead.stage,
    emails: lead.emails,
    proposed_budget: lead.proposedBudget,
    estimated_deadline: lead.estimatedDeadline,
    project_notes: lead.projectNotes,
    lost_reason: lead.lostReason,
    linked_project_id: lead.linkedProjectId || null,
    user_id: userId,
  };
}

function friendlyAuthError(err) {
  const msg = err?.message || "Something went wrong";
  const map = {
    "Invalid login credentials": "Incorrect email or password.",
    "User already registered": "An account already exists with that email.",
    "Password should be at least 6 characters.": "Password should be at least 6 characters.",
  };
  return map[msg] || msg;
}

const ClapperIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5 20 5l.7 3.5L4 12z" />
    <path d="M3 8.5 20.5 12 19 20a1 1 0 0 1-1 .8H5a1 1 0 0 1-1-1z" />
    <path d="m7 6 3 3M12 5l3 3M17 4l3 3" />
  </svg>
);

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />
  </svg>
);

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);

const ArchiveIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" />
  </svg>
);

const SignOutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

export default function ShotTracker() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");

  const [data, setData] = useState({ projects: [], cards: [], leads: [] });
  const { projects, cards, leads } = data;
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState("projects"); // "projects" | "leads"
  const [view, setView] = useState("projects");
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [editingCard, setEditingCard] = useState(null);
  const [editingProject, setEditingProject] = useState(null);
  const [editingLead, setEditingLead] = useState(null);
  const [pendingLeadLinkId, setPendingLeadLinkId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [dragVisual, setDragVisual] = useState(null);
  const [saveState, setSaveState] = useState("idle");

  const dataRef = useRef(data);
  const dragStateRef = useRef(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Auth session bootstrap and listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id || null;

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [projectsRes, shotsRes, leadsRes] = await Promise.all([
        supabase.from("projects").select("*").order("created_at"),
        supabase.from("shots").select("*").order("created_at"),
        supabase.from("leads").select("*").order("created_at"),
      ]);
      if (projectsRes.error) throw projectsRes.error;
      if (shotsRes.error) throw shotsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      const nextProjects = (projectsRes.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
        notes: p.notes,
        budget: p.budget,
        deadline: p.deadline,
        priority: p.priority,
        archived: p.archived,
      }));
      const nextCards = (shotsRes.data || []).map(cardFromRow);
      const nextLeads = (leadsRes.data || []).map(leadFromRow);
      setData({ projects: nextProjects, cards: nextCards, leads: nextLeads });
    } catch (e) {
      console.error("Shot Tracker load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadData();
    else setData({ projects: [], cards: [], leads: [] });
  }, [userId, loadData]);

  const flashSave = (ok) => {
    setSaveState(ok ? "saved" : "error");
    setTimeout(() => setSaveState("idle"), 1200);
  };

  const handleSaveProject = async (project) => {
    setSaveState("saving");
    try {
      if (project.id) {
        const { error } = await supabase
          .from("projects")
          .update({
            name: project.name,
            client: project.client,
            notes: project.notes,
            budget: project.budget,
            deadline: project.deadline,
            priority: project.priority,
          })
          .eq("id", project.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          projects: prev.projects.map((p) => (p.id === project.id ? project : p)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("projects")
          .insert({
            name: project.name,
            client: project.client,
            notes: project.notes,
            budget: project.budget,
            deadline: project.deadline,
            priority: project.priority,
            user_id: userId,
          })
          .select()
          .single();
        if (error) throw error;

        let newCards = [];
        const checklist = generateShotChecklist(project.shotCount, inserted.id, project.client);
        if (checklist.length > 0) {
          const rows = checklist.map((c) => cardToRow(c, userId));
          const { data: insertedShots, error: shotsError } = await supabase
            .from("shots")
            .insert(rows)
            .select();
          if (shotsError) throw shotsError;
          newCards = (insertedShots || []).map(cardFromRow);
        }

        setData((prev) => ({
          ...prev,
          projects: [
            ...prev.projects,
            {
              id: inserted.id,
              name: inserted.name,
              client: inserted.client,
              notes: inserted.notes,
              budget: inserted.budget,
              deadline: inserted.deadline,
              priority: inserted.priority,
            },
          ],
          cards: [...prev.cards, ...newCards],
        }));

        if (pendingLeadLinkId) {
          const linkId = pendingLeadLinkId;
          setPendingLeadLinkId(null);
          try {
            await supabase
              .from("leads")
              .update({ linked_project_id: inserted.id })
              .eq("id", linkId);
            setData((prev) => ({
              ...prev,
              leads: prev.leads.map((l) =>
                l.id === linkId ? { ...l, linkedProjectId: inserted.id } : l
              ),
            }));
          } catch (linkErr) {
            console.error("Linking lead to project failed:", linkErr);
          }
        }
      }
      flashSave(true);
    } catch (e) {
      console.error("Project save failed:", e);
      flashSave(false);
    }
    setEditingProject(null);
  };

  const handleDeleteProject = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        projects: prev.projects.filter((p) => p.id !== id),
        cards: prev.cards.filter((c) => c.projectId !== id),
      }));
      flashSave(true);
    } catch (e) {
      console.error("Project delete failed:", e);
      flashSave(false);
    }
    setEditingProject(null);
    if (selectedProjectId === id) {
      setView("projects");
      setSelectedProjectId(null);
    }
  };

  const handleToggleArchive = async (id, archived) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("projects").update({ archived }).eq("id", id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === id ? { ...p, archived } : p)),
      }));
      flashSave(true);
    } catch (e) {
      console.error("Archive toggle failed:", e);
      flashSave(false);
    }
  };

  const handleSaveCard = async (card) => {
    setSaveState("saving");
    try {
      if (card.id) {
        const { error } = await supabase
          .from("shots")
          .update(cardToRow(card, userId))
          .eq("id", card.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          cards: prev.cards.map((c) => (c.id === card.id ? card : c)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("shots")
          .insert(cardToRow(card, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, cards: [...prev.cards, cardFromRow(inserted)] }));
      }
      flashSave(true);
    } catch (e) {
      console.error("Shot save failed:", e);
      flashSave(false);
    }
    setEditingCard(null);
  };

  const handleDeleteCard = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("shots").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, cards: prev.cards.filter((c) => c.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Shot delete failed:", e);
      flashSave(false);
    }
    setEditingCard(null);
  };

  const moveCardStage = async (id, stage) => {
    const resetFields = { reviewStatus: "in_progress", revisions: [], revisionVersion: 1 };
    setData((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, stage, ...resetFields } : c)),
    }));
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("shots")
        .update({
          stage,
          review_status: resetFields.reviewStatus,
          revisions: resetFields.revisions,
          revision_version: resetFields.revisionVersion,
        })
        .eq("id", id);
      if (error) throw error;
      flashSave(true);
    } catch (e) {
      console.error("Stage move failed:", e);
      flashSave(false);
    }
  };

  const moveCardStageRef = useRef(moveCardStage);
  useEffect(() => {
    moveCardStageRef.current = moveCardStage;
  });

  const handleSaveLead = async (lead) => {
    setSaveState("saving");
    try {
      if (lead.id) {
        await supabase.from("leads").update(leadToRow(lead, userId)).eq("id", lead.id);
        setData((prev) => ({
          ...prev,
          leads: prev.leads.map((l) => (l.id === lead.id ? lead : l)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("leads")
          .insert(leadToRow(lead, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, leads: [...prev.leads, leadFromRow(inserted)] }));
      }
      flashSave(true);
    } catch (e) {
      console.error("Lead save failed:", e);
      flashSave(false);
    }
    setEditingLead(null);
  };

  const handleDeleteLead = async (id) => {
    setSaveState("saving");
    try {
      await supabase.from("leads").delete().eq("id", id);
      setData((prev) => ({ ...prev, leads: prev.leads.filter((l) => l.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Lead delete failed:", e);
      flashSave(false);
    }
    setEditingLead(null);
  };

  const moveLeadStage = async (id, stage) => {
    setData((prev) => ({
      ...prev,
      leads: prev.leads.map((l) => (l.id === id ? { ...l, stage } : l)),
    }));
    setSaveState("saving");
    try {
      await supabase.from("leads").update({ stage }).eq("id", id);
      flashSave(true);
    } catch (e) {
      console.error("Lead stage move failed:", e);
      flashSave(false);
    }
  };

  const moveLeadStageRef = useRef(moveLeadStage);
  useEffect(() => {
    moveLeadStageRef.current = moveLeadStage;
  });

  // Called from the lead editor: saves the lead as "won" and opens a
  // prefilled New Project form so no data has to be typed twice.
  const handleMarkWon = async (lead) => {
    const wonLead = { ...lead, stage: "won" };
    await handleSaveLead(wonLead);
    setPendingLeadLinkId(lead.id || null);
    setWorkspace("projects");
    setView("projects");
    setEditingProject(
      emptyProject({
        name: lead.companyName,
        client: lead.contactPerson || lead.companyName,
        notes: lead.projectNotes || lead.notes,
        budget: lead.proposedBudget,
        deadline: lead.estimatedDeadline,
      })
    );
  };

  const handleMarkLost = async (lead, reason) => {
    await handleSaveLead({ ...lead, stage: "lost", lostReason: reason });
  };

  const handleExport = () => {
    const payload = JSON.stringify(data, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `shot-tracker-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthBusy(true);
    try {
      if (authMode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
        setAuthNotice("Check your inbox to confirm your email, then sign in.");
      }
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setData({ projects: [], cards: [] });
    setView("projects");
    setSelectedProjectId(null);
  };

  const endDrag = useCallback(() => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    dragStateRef.current = null;
    setDragVisual(null);
    setDragOverStage(null);
  }, []);

  const handlePointerMove = useCallback((e) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.hypot(dx, dy) > 6) {
      ds.moved = true;
    }
    if (ds.moved) {
      e.preventDefault();
      setDragVisual({
        title: ds.title,
        client: ds.client,
        x: e.clientX - ds.offsetX,
        y: e.clientY - ds.offsetY,
        width: ds.width,
      });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const columnEl = el && el.closest("[data-stage]");
      setDragOverStage(columnEl ? columnEl.getAttribute("data-stage") : null);
    }
  }, []);

  const handlePointerUp = useCallback(
    (e) => {
      const ds = dragStateRef.current;
      if (ds && ds.moved) {
        suppressClickRef.current = true;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const columnEl = el && el.closest("[data-stage]");
        const stage = columnEl ? columnEl.getAttribute("data-stage") : null;
        if (stage) {
          if (ds.kind === "lead") {
            moveLeadStageRef.current(ds.id, stage);
          } else {
            moveCardStageRef.current(ds.id, stage);
          }
        }
      }
      endDrag();
    },
    [endDrag]
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const handlePointerDown = (e, card, kind = "shot") => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      kind,
      id: card.id,
      title: kind === "lead" ? card.companyName : card.title,
      client: kind === "lead" ? card.contactPerson : card.client,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      moved: false,
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleCardClick = (card) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setEditingCard(card);
  };

  const handleLeadClick = (lead) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setEditingLead(lead);
  };

  const openProject = (id) => {
    setSelectedProjectId(id);
    setView("board");
  };

  if (authLoading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingClap}><ClapperIcon /></div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={styles.app}>
        <style>{fontImport}</style>
        <div style={styles.lockScreen}>
          <div style={styles.logoMark}><ClapperIcon /></div>
          <h1 style={styles.title}>KaiFlow</h1>
          <p style={styles.subtitle}>CRM plus Shot Tracker</p>

          <button style={styles.googleButton} onClick={handleGoogleSignIn} type="button">
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.67-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.85A11 11 0 0 0 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.05H2.18a11 11 0 0 0 0 9.9z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.85C6.71 7.3 9.14 5.38 12 5.38z" />
            </svg>
            Continue with Google
          </button>

          <div style={styles.dividerRow}>
            <div style={styles.dividerLine} />
            <span style={styles.dividerText}>or</span>
            <div style={styles.dividerLine} />
          </div>

          <form onSubmit={handleAuthSubmit} style={styles.lockForm}>
            <input
              style={styles.input}
              type="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              autoFocus
              required
            />
            <input
              style={styles.input}
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="Password"
              autoComplete={authMode === "signin" ? "current-password" : "new-password"}
              minLength={6}
              required
            />
            <button type="submit" style={styles.newButton} disabled={authBusy}>
              {authBusy ? "Please wait..." : authMode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          {authError && <p style={styles.lockError}>{authError}</p>}
          {authNotice && <p style={styles.lockNotice}>{authNotice}</p>}

          <button
            style={styles.switchModeButton}
            onClick={() => {
              setAuthMode(authMode === "signin" ? "signup" : "signin");
              setAuthError("");
              setAuthNotice("");
            }}
          >
            {authMode === "signin"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingClap}><ClapperIcon /></div>
      </div>
    );
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectCards = cards.filter((c) => c.projectId === selectedProjectId);
  const { delivered: deliveredCount, percent: overallPercent } = projectProgress(projectCards);
  const showTabs = view !== "board";

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>

      <header style={styles.header}>
        <div style={styles.headerLeft}>
          {view === "board" ? (
            <button style={styles.backButton} onClick={() => setView("projects")}>
              <BackIcon />
            </button>
          ) : (
            <div style={styles.logoMark}><ClapperIcon /></div>
          )}
          <div>
            <h1 style={styles.title}>
              {view === "board"
                ? selectedProject?.name || "Project"
                : workspace === "leads"
                ? "Leads"
                : "KaiFlow"}
            </h1>
            <p style={styles.subtitle}>
              {view === "board" ? selectedProject?.client || "Studio Kairegi" : session.user.email}
            </p>
          </div>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.saveIndicator}>
            {saveState === "saving" && "Saving..."}
            {saveState === "saved" && "Saved"}
            {saveState === "error" && "Save failed"}
          </span>
          <button style={styles.iconButtonGhost} onClick={handleExport} title="Export backup">
            <DownloadIcon />
          </button>
          <button style={styles.iconButtonGhost} onClick={handleSignOut} title="Sign out">
            <SignOutIcon />
          </button>
          {view === "board" ? (
            <button
              style={styles.newButton}
              onClick={() => setEditingCard(emptyCard(STAGES[0].id, selectedProjectId))}
            >
              <PlusIcon />
              New shot
            </button>
          ) : workspace === "leads" ? (
            <button style={styles.newButton} onClick={() => setEditingLead(emptyLead())}>
              <PlusIcon />
              New lead
            </button>
          ) : (
            <button style={styles.newButton} onClick={() => setEditingProject(emptyProject())}>
              <PlusIcon />
              New project
            </button>
          )}
        </div>
      </header>

      {showTabs && (
        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tabButton, ...(workspace === "projects" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("projects")}
          >
            Projects
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "leads" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("leads")}
          >
            Leads
          </button>
        </div>
      )}

      {view === "board" && (
        <div style={styles.progressBar}>
          <div style={styles.progressLabelRow}>
            <span style={styles.progressLabel}>
              {projectCards.length === 0
                ? "No shots yet"
                : `${deliveredCount} of ${projectCards.length} shots delivered`}
            </span>
            <span style={styles.progressPercent}>{overallPercent}%</span>
          </div>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${overallPercent}%` }} />
          </div>
        </div>
      )}

      {view === "projects" && workspace === "projects" && (
        <ProjectsGrid
          projects={projects}
          cards={cards}
          onOpen={openProject}
          onEdit={setEditingProject}
          onNew={() => setEditingProject(emptyProject())}
          onToggleArchive={handleToggleArchive}
        />
      )}

      {view === "projects" && workspace === "leads" && (
        <div style={{ ...styles.board, touchAction: dragVisual ? "none" : "auto" }}>
          {LEAD_STAGES.map((stage) => {
            const stageLeads = leads.filter((l) => l.stage === stage.id);
            const isOver = dragOverStage === stage.id;
            return (
              <div
                key={stage.id}
                data-stage={stage.id}
                style={{ ...styles.column, ...(isOver ? styles.columnOver : {}) }}
              >
                <div style={styles.columnHeader}>
                  <span style={styles.columnLabel}>{stage.label}</span>
                  <span style={styles.columnCount}>{stageLeads.length}</span>
                </div>
                <div style={styles.columnBody}>
                  {stageLeads.length === 0 && (
                    <button
                      style={styles.emptyAdd}
                      onClick={() => setEditingLead(emptyLead())}
                    >
                      <PlusIcon />
                      Add lead
                    </button>
                  )}
                  {stageLeads.map((lead) => {
                    const sentCount = lead.emails.filter((e) => e.sent).length;
                    return (
                      <div
                        key={lead.id}
                        onPointerDown={(e) => handlePointerDown(e, lead, "lead")}
                        onClick={() => handleLeadClick(lead)}
                        style={{
                          ...styles.card,
                          opacity: dragStateRef.current?.id === lead.id && dragVisual ? 0.4 : 1,
                          touchAction: "none",
                        }}
                      >
                        <div style={styles.cardTop}>
                          <span style={styles.cardTitle}>
                            {lead.companyName || "Untitled lead"}
                          </span>
                        </div>
                        {lead.contactPerson && (
                          <div style={styles.cardMeta}>{lead.contactPerson}</div>
                        )}
                        <div style={styles.cardFooter}>
                          {sentCount > 0 && (
                            <span style={styles.cardTag}>{sentCount}/4 emails sent</span>
                          )}
                          {lead.stage === "lost" && lead.lostReason && (
                            <span style={styles.cardTag}>{lead.lostReason}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === "board" && (
        <div style={{ ...styles.board, touchAction: dragVisual ? "none" : "auto" }}>
          {STAGES.map((stage) => {
            const stageCards = projectCards.filter((c) => c.stage === stage.id);
            const isOver = dragOverStage === stage.id;
            return (
              <div
                key={stage.id}
                data-stage={stage.id}
                style={{ ...styles.column, ...(isOver ? styles.columnOver : {}) }}
              >
                <div style={styles.columnHeader}>
                  <span style={styles.columnLabel}>{stage.label}</span>
                  <span style={styles.columnCount}>{stageCards.length}</span>
                </div>
                <div style={styles.columnBody}>
                  {stageCards.length === 0 && (
                    <button
                      style={styles.emptyAdd}
                      onClick={() => setEditingCard(emptyCard(stage.id, selectedProjectId))}
                    >
                      <PlusIcon />
                      Add shot
                    </button>
                  )}
                  {stageCards.map((card) => (
                    <div
                      key={card.id}
                      onPointerDown={(e) => handlePointerDown(e, card)}
                      onClick={() => handleCardClick(card)}
                      style={{
                        ...styles.card,
                        opacity: dragStateRef.current?.id === card.id && dragVisual ? 0.4 : 1,
                        touchAction: "none",
                      }}
                    >
                      <div style={styles.cardTop}>
                        <span
                          style={{
                            ...styles.priorityDot,
                            background: PRIORITY_COLORS[card.priority] || PRIORITY_COLORS.normal,
                          }}
                        />
                        <span style={styles.cardTitle}>{card.title || "Untitled shot"}</span>
                        <span style={{ flex: 1 }} />
                        <span
                          title={REVIEW_LABELS[card.reviewStatus] || REVIEW_LABELS.waiting}
                          style={{
                            ...styles.reviewDot,
                            background: REVIEW_COLORS[card.reviewStatus] || REVIEW_COLORS.waiting,
                          }}
                        />
                      </div>
                      {card.client && <div style={styles.cardMeta}>{card.client}</div>}
                      <div style={styles.cardFooter}>
                        {card.rate && <span style={styles.cardTag}>{card.rate}</span>}
                        {card.due && <span style={styles.cardTag}>{card.due}</span>}
                      </div>
                      <div style={styles.cardProgressTrack}>
                        <div
                          style={{
                            ...styles.cardProgressFill,
                            width: `${stagePercent(card.stage)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dragVisual && (
        <div style={{ ...styles.dragGhost, left: dragVisual.x, top: dragVisual.y, width: dragVisual.width }}>
          <div style={styles.cardTop}>
            <span style={styles.cardTitle}>{dragVisual.title || "Untitled shot"}</span>
          </div>
          {dragVisual.client && <div style={styles.cardMeta}>{dragVisual.client}</div>}
        </div>
      )}

      {editingCard && (
        <CardEditor
          card={editingCard}
          onCancel={() => setEditingCard(null)}
          onSave={handleSaveCard}
          onDelete={handleDeleteCard}
          isNew={!editingCard.id}
        />
      )}

      {editingProject && (
        <ProjectEditor
          project={editingProject}
          onCancel={() => setEditingProject(null)}
          onSave={handleSaveProject}
          onDelete={handleDeleteProject}
          isNew={!editingProject.id}
        />
      )}

      {editingLead && (
        <LeadEditor
          lead={editingLead}
          onCancel={() => setEditingLead(null)}
          onSave={handleSaveLead}
          onDelete={handleDeleteLead}
          onMarkWon={handleMarkWon}
          onMarkLost={handleMarkLost}
          isNew={!editingLead.id}
        />
      )}
    </div>
  );
}

function ProjectsGrid({ projects, cards, onOpen, onEdit, onNew, onToggleArchive }) {
  const [showArchived, setShowArchived] = useState(false);
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  if (projects.length === 0) {
    return (
      <div style={styles.projectsEmpty}>
        <div style={styles.projectsEmptyIcon}><FolderIcon /></div>
        <p style={styles.projectsEmptyText}>No projects yet</p>
        <button style={styles.newButton} onClick={onNew}>
          <PlusIcon />
          New project
        </button>
      </div>
    );
  }

  return (
    <div>
      {activeProjects.length === 0 ? (
        <div style={styles.projectsEmpty}>
          <div style={styles.projectsEmptyIcon}><FolderIcon /></div>
          <p style={styles.projectsEmptyText}>No active projects</p>
          <button style={styles.newButton} onClick={onNew}>
            <PlusIcon />
            New project
          </button>
        </div>
      ) : (
        <div style={styles.projectsGrid}>
          {activeProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              cards={cards}
              onOpen={onOpen}
              onEdit={onEdit}
              onToggleArchive={onToggleArchive}
            />
          ))}
        </div>
      )}

      {archivedProjects.length > 0 && (
        <div style={styles.archiveSection}>
          <button
            style={styles.archiveToggle}
            onClick={() => setShowArchived(!showArchived)}
          >
            <ArchiveIcon />
            {showArchived ? "Hide" : "Show"} archived ({archivedProjects.length})
          </button>
          {showArchived && (
            <div style={styles.projectsGrid}>
              {archivedProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  cards={cards}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onToggleArchive={onToggleArchive}
                  archived
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, cards, onOpen, onEdit, onToggleArchive, archived }) {
  const projectCards = cards.filter((c) => c.projectId === project.id);
  const { delivered, percent } = projectProgress(projectCards);
  return (
    <div
      style={{ ...styles.projectCard, ...(archived ? styles.projectCardArchived : {}) }}
      onClick={() => onOpen(project.id)}
    >
      <div style={styles.projectCardTop}>
        <div style={styles.projectIconMark}><FolderIcon /></div>
        <div style={styles.projectCardActions}>
          <button
            style={styles.iconButton}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(project);
            }}
            title="Edit"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
          <button
            style={styles.iconButton}
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchive(project.id, !archived);
            }}
            title={archived ? "Restore" : "Archive"}
          >
            {archived ? <RestoreIcon /> : <ArchiveIcon />}
          </button>
        </div>
      </div>
      <div style={styles.projectName}>{project.name || "Untitled project"}</div>
      {project.client && <div style={styles.projectClient}>{project.client}</div>}
      <div style={styles.projectStats}>
        <span style={styles.progressLabel}>
          {projectCards.length === 0 ? "No shots yet" : `${delivered} of ${projectCards.length} delivered`}
        </span>
        <span style={styles.progressPercent}>{percent}%</span>
      </div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ProjectEditor({ project, onCancel, onSave, onDelete, isNew }) {
  const [form, setForm] = useState(project);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New project" : "Edit project"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Project name</label>
          <input
            style={styles.input}
            value={form.name}
            onChange={set("name")}
            placeholder="e.g. Nightfall Trailer"
            autoFocus
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Client</label>
          <input
            style={styles.input}
            value={form.client}
            onChange={set("client")}
            placeholder="e.g. Vicente Carro"
          />
        </div>

        {isNew && (
          <div style={styles.field}>
            <label style={styles.label}>Number of shots</label>
            <input
              style={styles.input}
              type="number"
              min="0"
              max="500"
              value={form.shotCount || ""}
              onChange={set("shotCount")}
              placeholder="e.g. 24"
            />
            <p style={styles.fieldHint}>
              Creates Cut 01, Cut 02... as a starting checklist. Leave blank to add shots one at a time later.
            </p>
          </div>
        )}

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Budget</label>
            <input
              style={styles.input}
              value={form.budget || ""}
              onChange={set("budget")}
              placeholder="e.g. $2,000"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Deadline</label>
            <input
              style={styles.input}
              value={form.deadline || ""}
              onChange={set("deadline")}
              placeholder="e.g. Aug 15"
            />
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Priority</label>
          <select style={styles.input} value={form.priority || "normal"} onChange={set("priority")}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="rush">Rush</option>
          </select>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Scope, deadlines, contract terms..."
            rows={3}
          />
        </div>

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, name: form.name || "Untitled project" })}
          >
            Save project
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadEditor({ lead, onCancel, onSave, onDelete, onMarkWon, onMarkLost, isNew }) {
  const [form, setForm] = useState(lead);
  const [showLostReasons, setShowLostReasons] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const updateEmail = (index, patch) => {
    const nextEmails = form.emails.map((em, i) => {
      if (i !== index) return em;
      const updated = { ...em, ...patch };
      if (patch.sent === true && !em.sent) {
        updated.dateSent = new Date().toISOString().slice(0, 10);
      }
      if (patch.sent === false) {
        updated.dateSent = null;
      }
      return updated;
    });

    // Automation: sending the initial email moves a lead out of the pool,
    // and sending the final follow-up assumes no reply yet, so it moves to
    // No Response. Either can always be corrected manually afterward.
    let nextStage = form.stage;
    if (index === 0 && patch.sent === true && form.stage === "pool") {
      nextStage = "cold_email";
    }
    if (index === 3 && patch.sent === true && (form.stage === "pool" || form.stage === "cold_email")) {
      nextStage = "no_response";
    }
    setForm({ ...form, emails: nextEmails, stage: nextStage });
  };

  const showNegotiation = !["pool", "cold_email"].includes(form.stage);

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New lead" : "Edit lead"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Company name</label>
          <input
            style={styles.input}
            value={form.companyName}
            onChange={set("companyName")}
            placeholder="e.g. Nightfall Games"
            autoFocus
          />
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Contact person</label>
            <input
              style={styles.input}
              value={form.contactPerson}
              onChange={set("contactPerson")}
              placeholder="e.g. Jamie Fox"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              value={form.email}
              onChange={set("email")}
              placeholder="jamie@studio.com"
            />
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Website</label>
            <input
              style={styles.input}
              value={form.website}
              onChange={set("website")}
              placeholder="nightfallgames.com"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Country</label>
            <input
              style={styles.input}
              value={form.country}
              onChange={set("country")}
              placeholder="e.g. United States"
            />
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Client notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="What they do, style, references, budget signals, source of lead..."
            rows={3}
          />
        </div>

        <div style={styles.fieldDivider}>Outreach</div>

        {form.emails.map((em, i) => (
          <div key={i} style={styles.emailRow}>
            <div style={styles.emailRowHeader}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={em.sent}
                  onChange={(e) => updateEmail(i, { sent: e.target.checked })}
                />
                {em.label}
              </label>
              {em.sent && em.dateSent && (
                <span style={styles.fieldHint}>Sent {em.dateSent}</span>
              )}
            </div>
            <textarea
              style={styles.textarea}
              value={em.message}
              onChange={(e) => updateEmail(i, { message: e.target.value })}
              placeholder={`${em.label} draft...`}
              rows={2}
            />
          </div>
        ))}

        {showNegotiation && (
          <>
            <div style={styles.fieldDivider}>Negotiation</div>
            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Proposed budget</label>
                <input
                  style={styles.input}
                  value={form.proposedBudget}
                  onChange={set("proposedBudget")}
                  placeholder="e.g. $2,500"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Estimated deadline</label>
                <input
                  style={styles.input}
                  value={form.estimatedDeadline}
                  onChange={set("estimatedDeadline")}
                  placeholder="e.g. Sept 1"
                />
              </div>
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Project notes</label>
              <textarea
                style={styles.textarea}
                value={form.projectNotes}
                onChange={set("projectNotes")}
                placeholder="Scope discussed, expectations..."
                rows={2}
              />
            </div>
          </>
        )}

        {form.stage === "lost" && form.lostReason && (
          <p style={styles.fieldHint}>Marked lost: {form.lostReason}</p>
        )}

        {form.linkedProjectId && (
          <p style={styles.fieldHint}>Linked to an active project.</p>
        )}

        {showLostReasons && (
          <div style={styles.field}>
            <label style={styles.label}>Reason lost</label>
            <div style={styles.lostReasonGrid}>
              {LOST_REASONS.map((reason) => (
                <button
                  key={reason}
                  style={styles.lostReasonButton}
                  onClick={() => onMarkLost(form, reason)}
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          {!showLostReasons && form.stage !== "won" && form.stage !== "closed" && (
            <button
              style={styles.cancelButton}
              onClick={() => setShowLostReasons(true)}
            >
              Mark lost
            </button>
          )}
          {form.stage !== "won" && form.stage !== "closed" && (
            <button style={styles.wonButton} onClick={() => onMarkWon(form)}>
              Mark won
            </button>
          )}
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, companyName: form.companyName || "Untitled lead" })}
          >
            Save lead
          </button>
        </div>
      </div>
    </div>
  );
}

function CardEditor({ card, onCancel, onSave, onDelete, isNew }) {
  const [form, setForm] = useState(card);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSetStatus = (status) => {
    if (status === "revisions" && form.reviewStatus !== "revisions" && form.revisions.length === 0) {
      setForm({
        ...form,
        reviewStatus: status,
        revisions: [""],
        revisionVersion: (form.revisionVersion || 1) + 1,
      });
    } else {
      setForm({ ...form, reviewStatus: status });
    }
  };

  const addRevision = () => {
    setForm({
      ...form,
      revisions: [...form.revisions, ""],
      revisionVersion: (form.revisionVersion || 1) + 1,
    });
  };

  const updateRevisionText = (index, text) => {
    setForm({
      ...form,
      revisions: form.revisions.map((r, i) => (i === index ? text : r)),
    });
  };

  const [copied, setCopied] = useState(false);
  const handleCopyFileName = async () => {
    const name = shotFileName(form);
    try {
      await navigator.clipboard.writeText(name);
    } catch (e) {
      // clipboard API unavailable, fall back to a manual select prompt
      window.prompt("Copy the file name:", name);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New shot" : "Edit shot"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Shot name</label>
          <input
            style={styles.input}
            value={form.title}
            onChange={set("title")}
            placeholder="e.g. Trailer opening pan"
            autoFocus
          />
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Client</label>
            <input
              style={styles.input}
              value={form.client}
              onChange={set("client")}
              placeholder="e.g. Vicente Carro"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Rate</label>
            <input
              style={styles.input}
              value={form.rate}
              onChange={set("rate")}
              placeholder="e.g. $300"
            />
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Due date</label>
            <input
              style={styles.input}
              value={form.due}
              onChange={set("due")}
              placeholder="e.g. Jul 12"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Priority</label>
            <select style={styles.input} value={form.priority} onChange={set("priority")}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="rush">Rush</option>
            </select>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Specs, revision notes, reference links..."
            rows={3}
          />
        </div>

        <div style={styles.fieldDivider}>Client Review</div>
        <div style={styles.reviewStatusRow}>
          {REVIEW_STATUS_ORDER.map((status) => {
            const active = form.reviewStatus === status;
            return (
              <button
                key={status}
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: active ? REVIEW_COLORS[status] : border,
                  color: active ? REVIEW_COLORS[status] : textMuted,
                  background: active ? `${REVIEW_COLORS[status]}1a` : "transparent",
                }}
                onClick={() => handleSetStatus(status)}
              >
                <span style={{ ...styles.reviewDot, background: REVIEW_COLORS[status] }} />
                {REVIEW_LABELS[status]}
              </button>
            );
          })}
        </div>
        <div style={styles.fileNameRow}>
          <span style={styles.fieldHint}>{shotFileName(form)}</span>
          <button type="button" style={styles.copyButton} onClick={handleCopyFileName}>
            <CopyIcon />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        {form.reviewStatus === "revisions" && (
          <div style={styles.field}>
            <label style={styles.label}>Revisions requested</label>
            {form.revisions.map((text, i) => (
              <textarea
                key={i}
                style={{ ...styles.textarea, marginBottom: 6 }}
                value={text}
                onChange={(e) => updateRevisionText(i, e.target.value)}
                placeholder={`Revision ${i + 1} notes...`}
                rows={2}
              />
            ))}
            <button type="button" style={styles.addRevisionButton} onClick={addRevision}>
              <PlusIcon />
              Add another revision
            </button>
          </div>
        )}

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, title: form.title || "Untitled shot" })}
          >
            Save shot
          </button>
        </div>
      </div>
    </div>
  );
}

const fontImport = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
`;

const ink = "#14191c";
const inkSoft = "#1c2327";
const paper = "#EDEAE3";
const teal = "#2FBFA6";
const tealLight = "#7FE0D0";
const border = "#2a3338";
const textMuted = "#8b9a98";

const styles = {
  app: {
    minHeight: "100vh",
    background: ink,
    color: paper,
    fontFamily: "'Inter', sans-serif",
    display: "flex",
    flexDirection: "column",
  },
  loadingScreen: {
    minHeight: "100vh",
    background: ink,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: teal,
  },
  loadingClap: {
    animation: "pulse 1.4s ease-in-out infinite",
  },
  lockScreen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "40px 24px",
    textAlign: "center",
  },
  lockForm: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    width: "100%",
    maxWidth: 320,
    marginTop: 4,
  },
  lockError: {
    color: "#E07A5F",
    fontSize: 12.5,
    margin: 0,
    maxWidth: 320,
  },
  lockNotice: {
    color: tealLight,
    fontSize: 12.5,
    margin: 0,
    maxWidth: 320,
  },
  googleButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    maxWidth: 320,
    background: "#ffffff",
    color: "#1f2623",
    border: "none",
    borderRadius: 999,
    padding: "11px 18px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  dividerRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    maxWidth: 320,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: border,
  },
  dividerText: {
    fontSize: 11.5,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  switchModeButton: {
    background: "transparent",
    border: "none",
    color: teal,
    fontSize: 12.5,
    cursor: "pointer",
    marginTop: 4,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 28px",
    borderBottom: `1px solid ${border}`,
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logoMark: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "rgba(47,191,166,0.12)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "rgba(255,255,255,0.05)",
    border: `1px solid ${border}`,
    color: paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  title: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 19,
    fontWeight: 600,
    margin: 0,
    letterSpacing: "-0.01em",
  },
  subtitle: {
    fontSize: 12.5,
    color: textMuted,
    margin: "2px 0 0",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  saveIndicator: {
    fontSize: 12,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    minWidth: 60,
    textAlign: "right",
  },
  newButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: teal,
    color: ink,
    border: "none",
    borderRadius: 999,
    padding: "10px 18px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  iconButtonGhost: {
    width: 36,
    height: 36,
    borderRadius: 999,
    background: "rgba(255,255,255,0.05)",
    border: `1px solid ${border}`,
    color: paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  importToast: {
    margin: "0 28px 14px",
    background: "rgba(47,191,166,0.1)",
    border: `1px solid ${teal}`,
    color: tealLight,
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 12.5,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  progressBar: {
    padding: "0 28px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  progressLabelRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  progressLabel: {
    fontSize: 12.5,
    color: textMuted,
  },
  progressPercent: {
    fontSize: 13,
    fontFamily: "'IBM Plex Mono', monospace",
    color: teal,
    fontWeight: 500,
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    background: `linear-gradient(90deg, ${teal}, ${tealLight})`,
    transition: "width 0.3s ease",
  },
  projectsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 14,
    padding: "6px 28px 32px",
  },
  projectsEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "60px 20px",
    color: textMuted,
  },
  projectsEmptyIcon: {
    color: teal,
    opacity: 0.6,
  },
  projectsEmptyText: {
    fontSize: 14,
    margin: 0,
  },
  projectCard: {
    background: inkSoft,
    border: `1px solid ${border}`,
    borderRadius: 16,
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    cursor: "pointer",
  },
  projectCardArchived: {
    opacity: 0.6,
  },
  projectCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  projectCardActions: {
    display: "flex",
    gap: 4,
  },
  archiveSection: {
    padding: "8px 0 32px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  archiveToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    marginLeft: 28,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    fontSize: 12.5,
    padding: "8px 14px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  projectIconMark: {
    width: 32,
    height: 32,
    borderRadius: 9,
    background: "rgba(47,191,166,0.12)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  projectName: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15.5,
    fontWeight: 600,
  },
  projectClient: {
    fontSize: 12.5,
    color: textMuted,
    marginTop: -6,
  },
  projectStats: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 4,
  },
  board: {
    display: "flex",
    gap: 16,
    padding: "0 28px 32px",
    overflowX: "auto",
    flex: 1,
  },
  column: {
    background: inkSoft,
    borderRadius: 16,
    minWidth: 250,
    maxWidth: 250,
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${border}`,
    transition: "border-color 0.15s ease",
  },
  columnOver: {
    borderColor: teal,
  },
  columnHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: `1px solid ${border}`,
  },
  columnLabel: {
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: "'Space Grotesk', sans-serif",
    letterSpacing: "0.01em",
  },
  columnCount: {
    fontSize: 11,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 999,
    padding: "2px 8px",
  },
  columnBody: {
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    flex: 1,
    minHeight: 80,
  },
  emptyAdd: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    border: `1px dashed ${border}`,
    borderRadius: 12,
    background: "transparent",
    color: textMuted,
    fontSize: 12.5,
    padding: "18px 0",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  card: {
    background: "#20282c",
    border: `1px solid ${border}`,
    borderRadius: 12,
    padding: "12px 14px",
    cursor: "grab",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  dragGhost: {
    position: "fixed",
    background: "#263135",
    border: `1px solid ${teal}`,
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    pointerEvents: "none",
    zIndex: 200,
    boxShadow: "0 12px 28px rgba(0,0,0,0.4)",
    transform: "rotate(-1.5deg)",
  },
  cardTop: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  priorityDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  reviewDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    cursor: "default",
  },
  cardTitle: {
    fontSize: 13.5,
    fontWeight: 500,
    lineHeight: 1.3,
  },
  cardMeta: {
    fontSize: 12,
    color: textMuted,
  },
  cardFooter: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginTop: 2,
  },
  cardTag: {
    fontSize: 10.5,
    fontFamily: "'IBM Plex Mono', monospace",
    color: tealLight,
    background: "rgba(47,191,166,0.1)",
    borderRadius: 999,
    padding: "3px 8px",
  },
  cardProgressTrack: {
    height: 4,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    overflow: "hidden",
    marginTop: 2,
  },
  cardProgressFill: {
    height: "100%",
    borderRadius: 999,
    background: teal,
    transition: "width 0.3s ease",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(10,14,15,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 100,
  },
  modal: {
    background: inkSoft,
    borderRadius: 18,
    border: `1px solid ${border}`,
    width: "100%",
    maxWidth: 420,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 16,
    fontWeight: 600,
  },
  iconButton: {
    background: "transparent",
    border: "none",
    color: textMuted,
    cursor: "pointer",
    display: "flex",
    padding: 4,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
  },
  fieldRow: {
    display: "flex",
    gap: 12,
  },
  label: {
    fontSize: 11.5,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  fieldHint: {
    fontSize: 11.5,
    color: textMuted,
    margin: "2px 0 0",
    lineHeight: 1.4,
  },
  tabRow: {
    display: "flex",
    gap: 8,
    padding: "0 28px 16px",
  },
  tabButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    fontSize: 13,
    fontWeight: 500,
    padding: "8px 16px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  tabButtonActive: {
    background: "rgba(47,191,166,0.12)",
    borderColor: teal,
    color: teal,
  },
  fieldDivider: {
    fontSize: 11.5,
    fontFamily: "'IBM Plex Mono', monospace",
    color: teal,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderTop: `1px solid ${border}`,
    paddingTop: 12,
    marginTop: 4,
  },
  emailRow: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  emailRowHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: paper,
  },
  lostReasonGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  lostReasonButton: {
    background: "rgba(224,122,95,0.1)",
    border: "1px solid #E07A5F",
    color: "#E07A5F",
    borderRadius: 999,
    padding: "7px 14px",
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  wonButton: {
    background: "rgba(47,191,166,0.15)",
    border: `1px solid ${teal}`,
    borderRadius: 999,
    color: tealLight,
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  reviewStatusRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  fileNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    justifyContent: "space-between",
  },
  copyButton: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: teal,
    fontSize: 11,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
    flexShrink: 0,
  },
  reviewStatusButton: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid",
    borderRadius: 999,
    fontSize: 12.5,
    padding: "7px 13px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  addRevisionButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    background: "transparent",
    border: `1px dashed ${border}`,
    borderRadius: 999,
    color: teal,
    fontSize: 12.5,
    padding: "8px 14px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  input: {
    background: "#171d20",
    border: `1px solid ${border}`,
    borderRadius: 10,
    padding: "10px 12px",
    color: paper,
    fontSize: 13.5,
    fontFamily: "'Inter', sans-serif",
    outline: "none",
  },
  textarea: {
    background: "#171d20",
    border: `1px solid ${border}`,
    borderRadius: 10,
    padding: "10px 12px",
    color: paper,
    fontSize: 13.5,
    fontFamily: "'Inter', sans-serif",
    outline: "none",
    resize: "vertical",
  },
  modalFooter: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  deleteButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    border: "none",
    color: "#E07A5F",
    fontSize: 13,
    cursor: "pointer",
    padding: "8px 4px",
  },
  cancelButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: paper,
    fontSize: 13,
    padding: "9px 16px",
    cursor: "pointer",
  },
  saveButton: {
    background: teal,
    border: "none",
    borderRadius: 999,
    color: ink,
    fontWeight: 600,
    fontSize: 13,
    padding: "9px 18px",
    cursor: "pointer",
  },
};
