import React, { useState, useEffect } from "react";
import { supabase, functionUrl } from "./supabaseClient";
import { buildPipeline, projectProgress as pipelineProjectProgress } from "./pipeline.js";

const ink = "#14191c";
const inkSoft = "#1c2327";
const paper = "#EDEAE3";
const teal = "#2FBFA6";
const tealLight = "#7FE0D0";
const border = "#2a3338";
const textMuted = "#8b9a98";

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

// Progress math is no longer duplicated here (design report v2 §12, §15):
// pipeline.js is the single source of truth. Until the project_stages
// schema migration ships, every shared project still uses the same
// legacy pipeline every project in the app uses today, built from the
// same 12 stages this file used to hard-code as STAGE_ORDER.
const LEGACY_STAGES = [
  ["character_design", "Character Design"],
  ["bg_lighting", "BG & Lighting Design"],
  ["storyboard", "Storyboard"],
  ["layout", "Layout"],
  ["genga", "Genga"],
  ["douga", "Douga"],
  ["backgrounds", "Backgrounds"],
  ["frametest", "Frame Test"],
  ["cleanup", "Cleanup & Color"],
  ["compositing", "Compositing"],
  ["editing", "Editing"],
];
const LEGACY_PIPELINE = buildPipeline(
  LEGACY_STAGES.map(([id, label], i) => ({
    stageKey: id,
    name: label,
    phase: null,
    sortOrder: i * 10,
    kind: "stage",
    isEnabled: true,
  })).concat([{ stageKey: "delivered", name: "Delivered", phase: null, sortOrder: 1000, kind: "terminal", isEnabled: true }])
);

export function genShareToken() {
  // These are public portal credentials (a client or freelancer with the
  // link can act as whoever holds it), so they need to be unguessable,
  // not just unique - Math.random() is neither cryptographically random
  // nor uniformly distributed enough for that job. crypto.getRandomValues
  // is available in every browser this app already targets.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const wrapStyle = {
  minHeight: "100vh",
  background: ink,
  color: paper,
  fontFamily: "'Inter', sans-serif",
  padding: "32px 20px",
};

const cardStyle = {
  background: inkSoft,
  border: `1px solid ${border}`,
  borderRadius: 16,
  padding: 18,
  marginBottom: 12,
};

function LoadingState() {
  return (
    <div style={{ ...wrapStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: teal }}>Loading...</span>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div style={{ ...wrapStyle, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div>
        <p style={{ fontSize: 15, marginBottom: 8 }}>{message}</p>
        <p style={{ fontSize: 13, color: textMuted }}>
          Ask the studio for a fresh link if you think this is a mistake.
        </p>
      </div>
    </div>
  );
}

export function ClientPortalView({ token }) {
  const [rows, setRows] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("get_shared_project", { p_token: token });
      if (error || !data || data.length === 0) {
        setError("This link isn't valid, or sharing has been turned off for this project.");
        return;
      }
      setRows(data);

      // Additive RPC (design report v2 §12) — the project's own pipeline,
      // for real stage names and project-specific completion instead of
      // always assuming the shared LEGACY_PIPELINE fallback. Swallowed on
      // failure (e.g. this RPC doesn't exist yet, pre-migration) so the
      // portal keeps working exactly as it does today.
      try {
        const { data: pipelineRows, error: pipelineError } = await supabase.rpc("get_shared_project_pipeline", {
          p_token: token,
        });
        if (!pipelineError && pipelineRows && pipelineRows.length > 0) {
          setPipeline(
            buildPipeline(
              pipelineRows.map((r) => ({
                stageKey: r.stage_key,
                name: r.name,
                phase: r.phase,
                sortOrder: r.sort_order,
                kind: r.kind,
                isEnabled: r.is_enabled,
              }))
            )
          );
        }
      } catch (pipelineFetchErr) {
        console.error("Fetching the shared project's pipeline failed:", pipelineFetchErr);
      }
    })();
  }, [token]);

  if (error) return <ErrorState message={error} />;
  if (!rows) return <LoadingState />;

  const project = rows[0];
  const shots = rows.filter((r) => r.shot_title).map((r) => ({
    title: r.shot_title,
    stage: r.shot_stage,
    reviewStatus: r.shot_review_status,
  }));
  const activePipeline = pipeline || LEGACY_PIPELINE;
  const stageName = (stageKey) => activePipeline.byKey.get(stageKey)?.name || String(stageKey || "").replace(/_/g, " ");
  const { percent } = pipelineProjectProgress(
    activePipeline,
    shots.map((s) => s.stage)
  );

  return (
    <div style={wrapStyle}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <p style={{ color: textMuted, fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Client Portal
        </p>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, margin: "4px 0 2px" }}>
          {project.project_name}
        </h1>
        <p style={{ color: textMuted, fontSize: 13.5, marginBottom: 24 }}>{project.client_name}</p>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
            <span>Overall progress</span>
            <span style={{ color: teal, fontFamily: "monospace" }}>
              {percent === null ? "No shots yet" : `${percent}%`}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${percent ?? 0}%`, background: teal }} />
          </div>
          {project.deadline && (
            <p style={{ marginTop: 10, fontSize: 12.5, color: textMuted }}>Expected: {project.deadline}</p>
          )}
        </div>

        <p style={{ fontSize: 12.5, color: textMuted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "20px 0 10px" }}>
          Shots
        </p>
        {shots.length === 0 ? (
          <p style={{ color: textMuted, fontSize: 13.5 }}>No shots added yet.</p>
        ) : (
          shots.map((s, i) => (
            <div key={i} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13.5 }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: textMuted, textTransform: "capitalize" }}>
                  {stageName(s.stage)}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: `1px solid ${REVIEW_COLORS[s.reviewStatus] || textMuted}`,
                  color: REVIEW_COLORS[s.reviewStatus] || textMuted,
                }}
              >
                {REVIEW_LABELS[s.reviewStatus] || "In Progress"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function FreelancerView({ token }) {
  const [shot, setShot] = useState(null);
  const [stageInfo, setStageInfo] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadOk, setUploadOk] = useState(false);
  const fileInputRef = React.useRef(null);

  const loadShot = React.useCallback(async () => {
    const { data, error } = await supabase.rpc("get_shared_shot", { p_token: token });
    if (error || !data || data.length === 0) {
      setError("This link isn't valid or has expired.");
      return;
    }
    setShot(data[0]);

    // Additive RPC (design report v2 §12) — this cut's real stage name
    // (e.g. "Shiage" instead of the raw "shiage" key). Swallowed on
    // failure so the portal keeps working exactly as it does today if
    // this RPC isn't available yet (pre-migration).
    try {
      const { data: stageRows, error: stageError } = await supabase.rpc("get_shared_shot_stage", { p_token: token });
      if (!stageError && stageRows && stageRows.length > 0) {
        setStageInfo(stageRows[0]);
      }
    } catch (stageFetchErr) {
      console.error("Fetching the shared shot's stage failed:", stageFetchErr);
    }
  }, [token]);

  useEffect(() => {
    loadShot();
  }, [loadShot]);

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    setUploadOk(false);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("token", token);
      form.append("file", file);

      const res = await fetch(functionUrl("freelancer-drive-upload"), {
        method: "POST",
        body: form,
      });
      const result = await res.json().catch(() => ({}));

      if (result?.error === "not_connected") {
        // Previously fell back to uploading straight into the public
        // Supabase Storage bucket when a project wasn't Drive-connected
        // yet. All uploads - studio and freelancer - now go to Drive
        // only, so there's nothing to fall back to: surface this clearly
        // instead of silently switching storage backends.
        throw new Error(result?.message || "This project isn't set up to receive Drive uploads yet - let the studio know.");
      } else if (!res.ok || !result?.success) {
        throw new Error(result?.error || result?.message || "Upload failed");
      }

      setUploadOk(true);
      await loadShot();
    } catch (err) {
      console.error("Upload failed:", err);
      setUploadError(err.message || "Upload failed, please try again.");
    }
    setUploading(false);
  };

  if (error) return <ErrorState message={error} />;
  if (!shot) return <LoadingState />;

  const attachments = Array.isArray(shot.attachments) ? shot.attachments : [];
  const deliverables = Array.isArray(shot.deliverables) ? shot.deliverables : [];
  const isApproved = shot.review_status === "approved";

  return (
    <div style={wrapStyle}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <p style={{ color: textMuted, fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {shot.studio_name}
        </p>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, margin: "4px 0 2px" }}>
          {shot.shot_title}
        </h1>
        <p style={{ color: textMuted, fontSize: 13.5, marginBottom: 24 }}>{shot.project_name}</p>

        <div
          style={{
            ...cardStyle,
            border: `1px solid ${REVIEW_COLORS[shot.review_status] || border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: REVIEW_COLORS[shot.review_status] || paper }}>
            {isApproved ? "Approved" : "Not yet approved"}
          </span>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 999,
              border: `1px solid ${REVIEW_COLORS[shot.review_status] || textMuted}`,
              color: REVIEW_COLORS[shot.review_status] || textMuted,
            }}
          >
            {REVIEW_LABELS[shot.review_status] || "In Progress"}
          </span>
        </div>

        <div style={cardStyle}>
          <p style={{ fontSize: 12.5, color: textMuted, marginBottom: shot.assigned_to ? 6 : 0 }}>
            Stage: {stageInfo?.name || String(shot.stage || "").replace(/_/g, " ")}
          </p>
          {shot.assigned_to && (
            <p style={{ fontSize: 12.5, color: textMuted, margin: 0 }}>Assigned to: {shot.assigned_to}</p>
          )}
        </div>

        {shot.notes && (
          <div style={cardStyle}>
            <p style={{ fontSize: 12.5, color: textMuted, marginBottom: 6 }}>Brief / notes</p>
            <p style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{shot.notes}</p>
          </div>
        )}

        <p style={{ fontSize: 12.5, color: textMuted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "20px 0 10px" }}>
          Attachments from studio
        </p>
        {attachments.length === 0 ? (
          <p style={{ color: textMuted, fontSize: 13.5 }}>No files attached yet.</p>
        ) : (
          attachments.map((file, i) => (
            <a
              key={i}
              href={file.url}
              target="_blank"
              rel="noreferrer"
              style={{
                ...cardStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                color: tealLight,
                textDecoration: "none",
              }}
            >
              <span style={{ fontSize: 13.5 }}>{file.name}</span>
              <span style={{ fontSize: 11.5, color: teal }}>Download</span>
            </a>
          ))
        )}

        <p style={{ fontSize: 12.5, color: textMuted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "20px 0 10px" }}>
          Your uploads
        </p>
        {deliverables.length === 0 ? (
          <p style={{ color: textMuted, fontSize: 13.5 }}>Nothing uploaded yet.</p>
        ) : (
          deliverables
            .slice()
            .reverse()
            .map((file, i) => (
              <a
                key={i}
                href={file.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  ...cardStyle,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  color: tealLight,
                  textDecoration: "none",
                }}
              >
                <span style={{ fontSize: 13.5 }}>{file.name}</span>
                <span style={{ fontSize: 11, color: textMuted }}>
                  {file.uploadedAt ? new Date(file.uploadedAt).toLocaleString() : ""}
                </span>
              </a>
            ))
        )}

        <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelected} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            width: "100%",
            marginTop: 8,
            padding: "12px 16px",
            borderRadius: 12,
            border: `1px dashed ${teal}`,
            background: "rgba(47,191,166,0.08)",
            color: teal,
            fontSize: 13.5,
            cursor: uploading ? "default" : "pointer",
          }}
        >
          {uploading ? "Uploading..." : "Upload finished work"}
        </button>
        {uploadOk && (
          <p style={{ fontSize: 12.5, color: "#3DDC84", marginTop: 8 }}>Uploaded, thanks!</p>
        )}
        {uploadError && <p style={{ fontSize: 12.5, color: "#FF4D4D", marginTop: 8 }}>{uploadError}</p>}
      </div>
    </div>
  );
}
