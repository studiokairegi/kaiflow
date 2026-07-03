import React, { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";

const STAGES = [
  { id: "storyboard", label: "Storyboard" },
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
  };
}

function emptyProject() {
  return {
    name: "",
    client: "",
    notes: "",
    shotCount: "",
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
    user_id: userId,
  };
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

const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" />
  </svg>
);

const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 16V4m0 0 4 4m-4-4-4 4M5 20h14" />
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

  const [data, setData] = useState({ projects: [], cards: [] });
  const { projects, cards } = data;
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("projects");
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [editingCard, setEditingCard] = useState(null);
  const [editingProject, setEditingProject] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [dragVisual, setDragVisual] = useState(null);
  const [saveState, setSaveState] = useState("idle");

  const dataRef = useRef(data);
  const dragStateRef = useRef(null);
  const suppressClickRef = useRef(false);
  const fileInputRef = useRef(null);
  const [importMessage, setImportMessage] = useState("");

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
      const [projectsRes, shotsRes] = await Promise.all([
        supabase.from("projects").select("*").order("created_at"),
        supabase.from("shots").select("*").order("created_at"),
      ]);
      if (projectsRes.error) throw projectsRes.error;
      if (shotsRes.error) throw shotsRes.error;
      const nextProjects = (projectsRes.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
        notes: p.notes,
      }));
      const nextCards = (shotsRes.data || []).map(cardFromRow);
      setData({ projects: nextProjects, cards: nextCards });
    } catch (e) {
      console.error("Shot Tracker load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadData();
    else setData({ projects: [], cards: [] });
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
          .update({ name: project.name, client: project.client, notes: project.notes })
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
            { id: inserted.id, name: inserted.name, client: inserted.client, notes: inserted.notes },
          ],
          cards: [...prev.cards, ...newCards],
        }));
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
    setData((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, stage } : c)),
    }));
    setSaveState("saving");
    try {
      const { error } = await supabase.from("shots").update({ stage }).eq("id", id);
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

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const importedProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
        const importedCards = Array.isArray(parsed.cards) ? parsed.cards : [];
        const idMap = {};
        for (const p of importedProjects) {
          const { data: inserted, error } = await supabase
            .from("projects")
            .insert({ name: p.name, client: p.client, notes: p.notes, user_id: userId })
            .select()
            .single();
          if (error) throw error;
          idMap[p.id] = inserted.id;
        }
        for (const c of importedCards) {
          const newProjectId = idMap[c.projectId];
          if (!newProjectId) continue;
          await supabase
            .from("shots")
            .insert(cardToRow({ ...c, projectId: newProjectId }, userId));
        }
        await loadData();
        setImportMessage(`Imported ${importedProjects.length} projects, ${importedCards.length} shots`);
      } catch (err) {
        console.error("Import failed:", err);
        setImportMessage("Import failed, file wasn't valid backup JSON");
      }
      setTimeout(() => setImportMessage(""), 3500);
    };
    reader.readAsText(file);
    e.target.value = "";
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
          moveCardStageRef.current(ds.id, stage);
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

  const handlePointerDown = (e, card) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      id: card.id,
      title: card.title,
      client: card.client,
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
          <h1 style={styles.title}>Shot Tracker</h1>
          <p style={styles.subtitle}>
            {authMode === "signin" ? "Sign in to your studio" : "Create your studio account"}
          </p>

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
              {view === "board" ? selectedProject?.name || "Project" : "Shot Tracker"}
            </h1>
            <p style={styles.subtitle}>
              {view === "board"
                ? selectedProject?.client || "Studio Kairegi"
                : session.user.email}
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
          <button style={styles.iconButtonGhost} onClick={handleImportClick} title="Import backup">
            <UploadIcon />
          </button>
          <button style={styles.iconButtonGhost} onClick={handleSignOut} title="Sign out">
            <SignOutIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />
          {view === "projects" ? (
            <button style={styles.newButton} onClick={() => setEditingProject(emptyProject())}>
              <PlusIcon />
              New project
            </button>
          ) : (
            <button
              style={styles.newButton}
              onClick={() => setEditingCard(emptyCard(STAGES[0].id, selectedProjectId))}
            >
              <PlusIcon />
              New shot
            </button>
          )}
        </div>
      </header>

      {importMessage && (
        <div style={styles.importToast}>{importMessage}</div>
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

      {view === "projects" && (
        <ProjectsGrid
          projects={projects}
          cards={cards}
          onOpen={openProject}
          onEdit={setEditingProject}
          onNew={() => setEditingProject(emptyProject())}
        />
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
    </div>
  );
}

function ProjectsGrid({ projects, cards, onOpen, onEdit, onNew }) {
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
    <div style={styles.projectsGrid}>
      {projects.map((project) => {
        const projectCards = cards.filter((c) => c.projectId === project.id);
        const { delivered, percent } = projectProgress(projectCards);
        return (
          <div key={project.id} style={styles.projectCard} onClick={() => onOpen(project.id)}>
            <div style={styles.projectCardTop}>
              <div style={styles.projectIconMark}><FolderIcon /></div>
              <button
                style={styles.iconButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(project);
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
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
      })}
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

function CardEditor({ card, onCancel, onSave, onDelete, isNew }) {
  const [form, setForm] = useState(card);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

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
  projectCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
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
