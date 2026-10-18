import React, { useCallback, useEffect, useRef, useState } from "react";
import { startAutoRefresh } from "./autoRefresh.js";
import {
  getClientCuts,
  clientAddComment,
  clientRequestRevisions,
  clientApproveCut,
  clientDownload,
} from "./cutWorkflowApi.js";
import {
  CLIENT_STATUS_LABELS,
  CLIENT_STATUS_ICONS,
  clientDownloadState,
  parseTimestamp,
  formatTimestamp,
} from "./cutWorkflow.js";

// Client-facing review of RELEASED cuts. Everything shown here comes from
// get_client_cuts(), which only ever returns released versions, client-visible
// comments and decisions. It cannot return freelancer submissions, Drive ids
// or internal notes, so nothing here needs to hide them.
//
// The Download button is purely presentational: client-final-download
// independently verifies token, cut, version and release state per request.

const C = {
  ink: "#14191c",
  inkSoft: "#1c2327",
  paper: "#EDEAE3",
  teal: "#2FBFA6",
  border: "#2a3338",
  muted: "#8b9a98",
  green: "#3DDC84",
  red: "#FF4D4D",
  blue: "#4A90D9",
};
const STATUS_COLOR = {
  in_production: C.muted,
  client_review: C.blue,
  client_revisions_requested: C.red,
  client_approved: C.green,
};
const card = { background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
const field = {
  width: "100%",
  boxSizing: "border-box",
  background: C.ink,
  color: C.paper,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 8,
  fontSize: 13.5,
  fontFamily: "inherit",
};
const button = (color, disabled) => ({
  padding: "10px 16px",
  minHeight: 40,
  borderRadius: 10,
  border: `1px solid ${disabled ? C.border : color}`,
  background: disabled ? "rgba(255,255,255,0.03)" : `${color}22`,
  color: disabled ? C.muted : color,
  fontSize: 13.5,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});
const fmt = (d) => (d ? new Date(d).toLocaleString() : "");

function CutCard({ cut, token, author, onAuthorChange, reload }) {
  const [comment, setComment] = useState("");
  const [stamp, setStamp] = useState("");
  const [mode, setMode] = useState(null); // null | 'revisions' | 'approve'
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ type: "", text: "" });

  const status = cut.clientStatus;
  const release = cut.release;
  const dl = clientDownloadState(cut);
  const decided = !!release?.decision;
  const authorOk = author.trim().length > 0;
  const stampValue = stamp.trim() ? parseTimestamp(stamp) : null;
  const stampInvalid = stamp.trim() && stampValue === null;

  const act = async (fn, okText) => {
    if (busy) return;
    setBusy(true);
    setMsg({ type: "", text: "" });
    try {
      await fn();
      setMsg({ type: "ok", text: okText });
      setMode(null);
      setNotes("");
      await reload();
    } catch (e) {
      setMsg({ type: "err", text: e.message });
    }
    setBusy(false);
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{cut.title}</div>
        <span
          style={{ fontSize: 11.5, padding: "3px 10px", borderRadius: 999, border: `1px solid ${STATUS_COLOR[status]}`, color: STATUS_COLOR[status] }}
        >
          <span aria-hidden="true">{CLIENT_STATUS_ICONS[status]} </span>
          {CLIENT_STATUS_LABELS[status]}
        </span>
      </div>

      {release ? (
        <p style={{ fontSize: 12.5, color: C.muted, margin: "6px 0 10px" }}>
          Version {release.version} · released {fmt(release.releasedAt)} · {release.fileName}
          {release.notes ? <span style={{ display: "block", color: C.paper, marginTop: 4 }}>Studio note: {release.notes}</span> : null}
        </p>
      ) : (
        <p style={{ fontSize: 12.5, color: C.muted, margin: "6px 0 10px" }}>The studio hasn't released this cut for review yet.</p>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!dl.enabled || busy}
          aria-disabled={!dl.enabled || busy}
          style={button(C.teal, !dl.enabled || busy)}
          onClick={() =>
            act(() => clientDownload(token, cut.shotId, release.versionId), "Your download is starting.")
          }
        >
          Download v{release ? release.version : "—"}
        </button>
        {!dl.enabled && <span style={{ fontSize: 12.5, color: C.muted }}>{dl.reason}</span>}
      </div>

      {release && (
        <>
          {cut.history.length > 1 && (
            <p style={{ fontSize: 12, color: C.muted, margin: "10px 0 0" }}>
              Release history:{" "}
              {cut.history
                .map(
                  (h) =>
                    `v${h.version}${h.current ? " (current)" : ""}${
                      h.decision === "approved" ? " – approved" : h.decision === "revisions_requested" ? " – revisions requested" : ""
                    }`
                )
                .join(" · ")}
            </p>
          )}

          <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.muted, margin: "0 0 8px" }}>Feedback</p>
            {cut.comments.length === 0 && <p style={{ fontSize: 13, color: C.muted, margin: "0 0 8px" }}>No comments yet.</p>}
            {cut.comments.map((c) => (
              <div key={c.id} style={{ fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                <span style={{ color: C.muted }}>
                  {c.author}
                  {c.authorKind === "studio" ? " (studio)" : ""} · {fmt(c.createdAt)}
                  {c.kind === "revision_request" ? " · revision request" : ""}
                </span>
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {c.seconds !== null && c.seconds !== undefined ? `${formatTimestamp(c.seconds)} — ` : ""}
                  {c.body}
                </div>
              </div>
            ))}

            <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 10 }} htmlFor={`author-${cut.shotId}`}>Your name</label>
            <input id={`author-${cut.shotId}`} value={author} onChange={(e) => onAuthorChange(e.target.value)} maxLength={80} style={field} />

            {!decided && (
              <>
                <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 8 }} htmlFor={`comment-${cut.shotId}`}>
                  Add a note (optionally start with a timestamp such as 00:12 in the box below)
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    aria-label="Timestamp (optional), e.g. 00:12"
                    placeholder="00:12"
                    value={stamp}
                    onChange={(e) => setStamp(e.target.value)}
                    style={{ ...field, width: 90, borderColor: stampInvalid ? C.red : C.border }}
                  />
                  <textarea id={`comment-${cut.shotId}`} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} style={field} />
                </div>
                {stampInvalid && <p role="alert" style={{ color: C.red, fontSize: 12, margin: "4px 0 0" }}>Use mm:ss, for example 00:12.</p>}
                <button
                  type="button"
                  style={{ ...button(C.teal, busy || !authorOk || !comment.trim() || !!stampInvalid), marginTop: 8 }}
                  disabled={busy || !authorOk || !comment.trim() || !!stampInvalid}
                  onClick={() =>
                    act(async () => {
                      await clientAddComment(token, cut.shotId, release.versionId, author, comment, stampValue);
                      setComment("");
                      setStamp("");
                    }, "Note sent.")
                  }
                >
                  Send note
                </button>

                <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                  <button type="button" style={button(C.red, busy)} disabled={busy} onClick={() => setMode(mode === "revisions" ? null : "revisions")}>
                    Request revisions
                  </button>
                  <button type="button" style={button(C.green, busy)} disabled={busy} onClick={() => setMode(mode === "approve" ? null : "approve")}>
                    Approve cut
                  </button>
                </div>

                {mode === "revisions" && (
                  <div role="dialog" aria-label="Confirm revision request" style={{ ...card, marginTop: 10, borderColor: C.red }}>
                    <p style={{ margin: "0 0 6px", fontSize: 13 }}>
                      <strong>Request revisions on version {release.version}?</strong> Describe what should change.
                    </p>
                    <textarea aria-label="Revision notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} style={field} />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        type="button"
                        style={button(C.red, busy || !authorOk || notes.trim().length < 10)}
                        disabled={busy || !authorOk || notes.trim().length < 10}
                        onClick={() => act(() => clientRequestRevisions(token, cut.shotId, release.versionId, author, notes), "Revision request sent to the studio.")}
                      >
                        Send revision request
                      </button>
                      <button type="button" style={button(C.muted, busy)} disabled={busy} onClick={() => setMode(null)}>Cancel</button>
                    </div>
                    {!authorOk && <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0" }}>Enter your name above first.</p>}
                  </div>
                )}

                {mode === "approve" && (
                  <div role="dialog" aria-label="Confirm approval" style={{ ...card, marginTop: 10, borderColor: C.green }}>
                    <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                      <strong>Approve version {release.version} of {cut.title}?</strong> This records your approval of this exact version.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" style={button(C.green, busy || !authorOk)} disabled={busy || !authorOk}
                        onClick={() => act(() => clientApproveCut(token, cut.shotId, release.versionId, author), "Approved. Thank you!")}>
                        Confirm approval
                      </button>
                      <button type="button" style={button(C.muted, busy)} disabled={busy} onClick={() => setMode(null)}>Cancel</button>
                    </div>
                    {!authorOk && <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0" }}>Enter your name above first.</p>}
                  </div>
                )}
              </>
            )}

            {decided && (
              <p style={{ fontSize: 13, margin: "12px 0 0" }}>
                {release.decision === "approved"
                  ? `✓ You approved version ${release.version} on ${fmt(release.decidedAt)}.`
                  : `↺ You requested revisions on version ${release.version} on ${fmt(release.decidedAt)}. The studio will release an updated version for review.`}
              </p>
            )}
          </div>
        </>
      )}

      {msg.text && (
        <p role={msg.type === "err" ? "alert" : "status"} style={{ fontSize: 12.5, margin: "10px 0 0", color: msg.type === "err" ? C.red : C.green }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export default function ClientCutReview({ token }) {
  const [cuts, setCuts] = useState(null); // null = loading, [] = none, false = unavailable (feature not deployed)
  const [author, setAuthor] = useState("");

  const lastSig = useRef("");

  // background = true is the silent auto-refresh: it never hides the section on a network blip,
  // and it only touches state when the data actually changed (so open comment boxes stay put).
  const load = useCallback(async (background = false) => {
    try {
      const data = await getClientCuts(token);
      const next = Array.isArray(data) ? data : false;
      const sig = JSON.stringify(next);
      if (sig !== lastSig.current) {
        lastSig.current = sig;
        setCuts(next);
      }
    } catch {
      // Migration not applied yet (or transient error): the portal keeps working exactly as before.
      if (!background) setCuts(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // Pick up a release, a withdrawal or the studio's reply without the client reloading the page.
  useEffect(() => startAutoRefresh(() => load(true)), [load]);

  if (cuts === null || cuts === false) return null;
  // Every cut is listed, released or not: unreleased ones show a greyed-out
  // Download with "Not yet available" instead of silently disappearing.
  if (cuts.length === 0) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <p style={{ fontSize: 12.5, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 10px" }}>
        Cuts &amp; deliveries
      </p>
      {cuts.map((cut) => (
        <CutCard key={cut.shotId} cut={cut} token={token} author={author} onAuthorChange={setAuthor} reload={load} />
      ))}
    </div>
  );
}
