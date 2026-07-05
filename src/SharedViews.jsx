import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

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

export function genShareToken() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
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
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("get_shared_project", { p_token: token });
      if (error || !data || data.length === 0) {
        setError("This link isn't valid, or sharing has been turned off for this project.");
        return;
      }
      setRows(data);
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
  const approved = shots.filter((s) => s.reviewStatus === "approved").length;
  const percent = shots.length ? Math.round((approved / shots.length) * 100) : 0;

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
            <span style={{ color: teal, fontFamily: "monospace" }}>{percent}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${percent}%`, background: teal }} />
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
                  {String(s.stage || "").replace(/_/g, " ")}
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
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("get_shared_shot", { p_token: token });
      if (error || !data || data.length === 0) {
        setError("This link isn't valid or has expired.");
        return;
      }
      setShot(data[0]);
    })();
  }, [token]);

  if (error) return <ErrorState message={error} />;
  if (!shot) return <LoadingState />;

  const attachments = Array.isArray(shot.attachments) ? shot.attachments : [];

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

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, color: textMuted, textTransform: "capitalize" }}>
              Stage: {String(shot.stage || "").replace(/_/g, " ")}
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
          {shot.assigned_to && (
            <p style={{ fontSize: 12.5, color: textMuted }}>Assigned to: {shot.assigned_to}</p>
          )}
        </div>

        {shot.notes && (
          <div style={cardStyle}>
            <p style={{ fontSize: 12.5, color: textMuted, marginBottom: 6 }}>Brief / notes</p>
            <p style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{shot.notes}</p>
          </div>
        )}

        <p style={{ fontSize: 12.5, color: textMuted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "20px 0 10px" }}>
          Attachments
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

        <p style={{ fontSize: 12, color: textMuted, marginTop: 20 }}>
          Uploading finished work back through this link is coming soon. For now, please send completed
          files back to the studio directly.
        </p>
      </div>
    </div>
  );
}
