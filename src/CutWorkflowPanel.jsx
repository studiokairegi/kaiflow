import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  loadCutWorkspace,
  qcApprove,
  qcRequestCorrections,
  qcMarkInHouse,
  releaseFinalVersion,
  withdrawRelease,
  routeClientRevision,
  addCutNote,
  uploadFinalFile,
} from "./cutWorkflowApi.js";
import {
  workflowLabel,
  studioActions,
  unavailableReason,
  isInHouseSubmission,
  formatTimestamp,
  newUploadKey,
} from "./cutWorkflow.js";

// Studio QC workspace for ONE cut: review the freelancer's submission, upload
// the QC-adjusted final file, explicitly release it, and handle client
// feedback. Self-contained: it loads and mutates through cutWorkflowApi and
// reports state changes upward via onChanged so the board stays in sync.

const C = {
  ink: "#14191c",
  inkSoft: "#1c2327",
  paper: "#EDEAE3",
  teal: "#2FBFA6",
  border: "#2a3338",
  muted: "#8b9a98",
  green: "#3DDC84",
  red: "#FF4D4D",
  amber: "#F2A65A",
  blue: "#4A90D9",
};

const box = { background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
const h = { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.muted, margin: "0 0 8px" };
const btn = (color, disabled) => ({
  padding: "8px 14px",
  borderRadius: 10,
  border: `1px solid ${disabled ? C.border : color}`,
  background: disabled ? "transparent" : `${color}22`,
  color: disabled ? C.muted : color,
  fontSize: 13,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.55 : 1,
});
const input = {
  width: "100%",
  boxSizing: "border-box",
  background: C.ink,
  color: C.paper,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
};

const DELIVERY_LABEL = {
  unreleased: "Not released",
  released: "Released to client",
  withdrawn: "Withdrawn",
  superseded: "Replaced by a newer release",
};
const DELIVERY_ICON = { unreleased: "○", released: "●", withdrawn: "⊘", superseded: "↻" };
const SUB_LABEL = {
  pending: "Pending review",
  approved: "Passed internal QC",
  corrections_requested: "Corrections requested",
  superseded: "Superseded by a newer upload",
};
const fmt = (d) => (d ? new Date(d).toLocaleString() : "");
const size = (n) => (n ? `${(n / (1024 * 1024)).toFixed(1)} MB` : "");

export default function CutWorkflowPanel({ shotId, projectName, clientName, shareEnabled, onChanged }) {
  const [ws, setWs] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState("");
  const [corrections, setCorrections] = useState("");
  const [confirm, setConfirm] = useState(null); // { type: 'release'|'withdraw', versionId }
  const [releaseNotes, setReleaseNotes] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [routeNote, setRouteNote] = useState("");
  const [inHouseOpen, setInHouseOpen] = useState(false);
  const [inHouseNote, setInHouseNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [progress, setProgress] = useState(null);
  const [upload, setUpload] = useState({ error: "", pending: null }); // pending keeps file + key for retry
  const fileRef = useRef(null);
  // Held in a ref so a parent re-render with a new callback identity can never retrigger a load.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refresh = useCallback(async () => {
    try {
      const next = await loadCutWorkspace(shotId);
      setWs(next);
      setError("");
      if (onChangedRef.current && next.shot) {
        onChangedRef.current(shotId, next.shot.workflow_state, next.shot.review_status);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [shotId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Runs a server action once; `busy` blocks double-clicks while it's in flight.
  const run = async (name, fn) => {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    }
    setBusy("");
  };

  const doUpload = async (file, key) => {
    setUpload({ error: "", pending: { file, key } });
    setProgress(0);
    setBusy("upload");
    try {
      await uploadFinalFile({ shotId, file, uploadKey: key, onProgress: setProgress });
      setUpload({ error: "", pending: null });
      await refresh();
    } catch (e) {
      setUpload({ error: e.message, pending: { file, key } }); // keep file + key => safe retry
      await refresh();
    }
    setProgress(null);
    setBusy("");
  };

  if (error && !ws) return <div role="alert" style={{ color: C.red, fontSize: 13 }}>{error}</div>;
  if (!ws) return <div style={{ color: C.muted, fontSize: 13 }}>Loading QC workspace…</div>;

  const { shot, submissions, versions, comments, reviews, activity } = ws;
  const a = studioActions({
    workflowState: shot.workflow_state,
    reviewStatus: shot.review_status,
    submissions,
    versions,
  });
  const clientComments = comments.filter((c) => c.audience === "client");
  const internalComments = comments.filter((c) => c.audience === "internal");
  const latestRevisionReq = reviews.find((r) => r.decision === "revisions_requested");
  const confirmVersion = confirm && versions.find((v) => v.id === confirm.versionId);

  return (
    <section aria-label="Cut review workspace" style={{ marginTop: 8 }}>
      <div style={{ ...box, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {projectName} · {shot.title}
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            Freelancer: {shot.assigned_to || "unassigned"} · Client: {clientName || "—"}
          </div>
        </div>
        <span
          style={{ fontSize: 12, padding: "4px 12px", borderRadius: 999, border: `1px solid ${C.teal}`, color: C.teal }}
          aria-label={`Workflow status: ${workflowLabel(shot.workflow_state)}`}
        >
          {workflowLabel(shot.workflow_state)}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ ...box, borderColor: C.red, color: C.red, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- QC review */}
      <div style={box}>
        <p style={h}>1 · Freelancer submissions &amp; internal QC</p>
        {submissions.length === 0 ? (
          <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>No submission yet. Waiting for the freelancer.</p>
        ) : (
          submissions.map((s) => (
            <div key={s.id} style={{ borderTop: `1px solid ${C.border}`, padding: "8px 0", fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>
                  v{s.version} · {isInHouseSubmission(s) ? "Internal QC check passed (marked by studio)" : s.file_name} <span style={{ color: C.muted }}>{size(s.size_bytes)}</span>
                </span>
                <span style={{ color: s.status === "approved" ? C.green : s.status === "corrections_requested" ? C.red : C.blue }}>
                  {s.status === "approved" ? "✓ " : s.status === "corrections_requested" ? "↺ " : "● "}
                  {SUB_LABEL[s.status]}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted }}>
                {isInHouseSubmission(s) ? "Marked" : "Submitted"} {fmt(s.submitted_at)} by {s.submitted_by || "freelancer"}
                {s.reviewed_at ? ` · Reviewed ${fmt(s.reviewed_at)}` : ""}
                {!isInHouseSubmission(s) && (
                  <>
                    {" "}·{" "}
                    <a href={`https://drive.google.com/file/d/${s.drive_file_id}/view`} target="_blank" rel="noreferrer" style={{ color: C.teal }}>
                      Open in Drive (internal only)
                    </a>
                  </>
                )}
              </div>
            </div>
          ))
        )}

        {a.canApprove ? (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 12, color: C.muted }} htmlFor="qc-notes">Internal QC notes (never shown to client)</label>
            <textarea id="qc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={input} />
            <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 8 }} htmlFor="qc-corrections">
              Corrections for the freelancer (required to request corrections)
            </label>
            <textarea id="qc-corrections" value={corrections} onChange={(e) => setCorrections(e.target.value)} rows={3} style={input} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={btn(C.green, !!busy)}
                disabled={!!busy}
                onClick={() => run("approve", async () => { await qcApprove(a.pendingSubmission.id, notes); setNotes(""); })}
              >
                Approve submission (internal QC)
              </button>
              <button
                type="button"
                style={btn(C.red, !!busy || corrections.trim().length < 3)}
                disabled={!!busy || corrections.trim().length < 3}
                onClick={() => run("corrections", async () => { await qcRequestCorrections(a.pendingSubmission.id, corrections, notes); setCorrections(""); setNotes(""); })}
              >
                Request corrections
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: C.muted, margin: "6px 0 0" }}>
              Approving means the freelancer's work passed internal QC. It does not release anything to the client.
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: C.muted, margin: "8px 0 0" }}>{unavailableReason("review", { workflowState: shot.workflow_state, submissions, versions })}</p>
        )}

        {a.canMarkInHouse && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
            {!inHouseOpen ? (
              <>
                <p style={{ fontSize: 12.5, color: C.muted, margin: "0 0 6px" }}>
                  Work was done in-house, or the freelancer's file didn't arrive through the portal? If you've checked it yourself, you can mark the internal QC check as passed.
                </p>
                <button type="button" style={btn(C.blue, !!busy)} disabled={!!busy} onClick={() => setInHouseOpen(true)}>
                  Mark as in-house QC check passed…
                </button>
              </>
            ) : (
              <div role="dialog" aria-label="Confirm in-house QC check passed">
                <p style={{ margin: "0 0 6px", fontSize: 13 }}><strong>Mark the internal QC check as passed?</strong></p>
                <p style={{ margin: "0 0 8px", fontSize: 12.5, color: C.muted }}>
                  This records that the studio checked the work and it passed internal QC, and unlocks the final upload. Nothing is released to the client yet:
                  you still upload the final file and release it explicitly.
                </p>
                <label style={{ fontSize: 12, color: C.muted }} htmlFor="inhouse-note">Internal note (optional)</label>
                <textarea id="inhouse-note" value={inHouseNote} onChange={(e) => setInHouseNote(e.target.value)} rows={2} style={input} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" style={btn(C.blue, !!busy)} disabled={!!busy}
                    onClick={() => run("inhouse", async () => { await qcMarkInHouse(shotId, inHouseNote); setInHouseOpen(false); setInHouseNote(""); })}>
                    {busy === "inhouse" ? "Saving…" : "Confirm QC check passed"}
                  </button>
                  <button type="button" style={btn(C.muted, !!busy)} disabled={!!busy} onClick={() => setInHouseOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------- Final QC + delivery */}
      <div style={box}>
        <p style={h}>2 · QC adjustments &amp; final upload</p>
        {a.approvedSubmission && (
          <p style={{ fontSize: 12, color: C.muted, margin: "0 0 8px" }}>
            Produced from freelancer submission v{a.approvedSubmission.version} (approved {fmt(a.approvedSubmission.reviewed_at)}).
          </p>
        )}

        {a.canUploadFinal ? (
          <>
            <input
              ref={fileRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) doUpload(f, newUploadKey());
              }}
            />
            <button type="button" style={btn(C.teal, !!busy)} disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === "upload" ? "Uploading…" : "Upload QC-adjusted final file"}
            </button>
            {progress !== null && (
              <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} style={{ marginTop: 8 }}>
                <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.08)" }}>
                  <div style={{ height: "100%", width: `${progress}%`, background: C.teal, borderRadius: 999 }} />
                </div>
                <span style={{ fontSize: 11.5, color: C.muted }}>{progress}%{progress === 100 ? " · verifying in Drive…" : ""}</span>
              </div>
            )}
            {upload.error && (
              <div role="alert" style={{ marginTop: 8, color: C.red, fontSize: 13 }}>
                {upload.error}{" "}
                {upload.pending && (
                  <button type="button" style={btn(C.amber, !!busy)} disabled={!!busy} onClick={() => doUpload(upload.pending.file, upload.pending.key)}>
                    Retry upload
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: C.muted, margin: 0 }}>
            {unavailableReason("final_upload", { workflowState: shot.workflow_state, submissions, versions })}
          </p>
        )}

        {versions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {versions.map((v) => (
              <div key={v.id} style={{ borderTop: `1px solid ${C.border}`, padding: "8px 0", fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <span>
                    {v.version ? `Final v${v.version}` : "Failed upload"} · {v.file_name} <span style={{ color: C.muted }}>{size(v.size_bytes)}</span>
                    {v.is_current ? " · latest" : ""}
                  </span>
                  <span style={{ color: v.delivery_state === "released" ? C.green : v.validation_status === "invalid" ? C.red : C.muted }}>
                    {v.validation_status === "invalid"
                      ? "✕ Failed validation"
                      : `${DELIVERY_ICON[v.delivery_state]} ${DELIVERY_LABEL[v.delivery_state]}`}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: C.muted }}>
                  Uploaded {fmt(v.uploaded_at)}
                  {v.released_at ? ` · Released ${fmt(v.released_at)}` : ""}
                  {v.withdrawn_at ? ` · Withdrawn ${fmt(v.withdrawn_at)}: ${v.withdraw_reason}` : ""}
                  {v.validation_error ? ` · ${v.validation_error}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Delivery is a separate, explicit action. */}
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={btn(C.green, !a.canRelease || !!busy)}
            disabled={!a.canRelease || !!busy}
            onClick={() => setConfirm({ type: "release", versionId: a.currentFinal.id })}
            title={a.canRelease ? "" : unavailableReason("release", { workflowState: shot.workflow_state, submissions, versions }) || ""}
          >
            Release to client…
          </button>
          {a.canWithdraw && (
            <button type="button" style={btn(C.amber, !!busy)} disabled={!!busy} onClick={() => setConfirm({ type: "withdraw", versionId: a.releasedVersion.id })}>
              Withdraw release…
            </button>
          )}
        </div>
        {!a.canRelease && (
          <p style={{ fontSize: 11.5, color: C.muted, margin: "6px 0 0" }}>{unavailableReason("release", { workflowState: shot.workflow_state, submissions, versions })}</p>
        )}

        {confirm && confirmVersion && (
          <div role="dialog" aria-label={confirm.type === "release" ? "Confirm release" : "Confirm withdrawal"} style={{ ...box, marginTop: 10, borderColor: C.amber }}>
            {confirm.type === "release" ? (
              <>
                <p style={{ margin: "0 0 6px", fontSize: 13 }}><strong>Release to client?</strong></p>
                <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12.5 }}>
                  <li>Project / cut: {projectName} · {shot.title}</li>
                  <li>File: {confirmVersion.file_name} (v{confirmVersion.version})</li>
                  <li>Client: {clientName || "—"}</li>
                </ul>
                {!shareEnabled && (
                  <p role="alert" style={{ color: C.amber, fontSize: 12.5 }}>
                    Client portal sharing is off for this project, so the client won't be able to open it until you enable sharing.
                  </p>
                )}
                <label style={{ fontSize: 12, color: C.muted }} htmlFor="rel-notes">Delivery notes for the client (optional)</label>
                <textarea id="rel-notes" value={releaseNotes} onChange={(e) => setReleaseNotes(e.target.value)} rows={2} style={input} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" style={btn(C.green, !!busy)} disabled={!!busy}
                    onClick={() => run("release", async () => { await releaseFinalVersion(confirm.versionId, releaseNotes); setConfirm(null); setReleaseNotes(""); })}>
                    {busy === "release" ? "Releasing…" : "Confirm release"}
                  </button>
                  <button type="button" style={btn(C.muted, !!busy)} disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: "0 0 6px", fontSize: 13 }}><strong>Withdraw v{confirmVersion.version} from the client?</strong> Downloads stop immediately; history is kept.</p>
                <label style={{ fontSize: 12, color: C.muted }} htmlFor="wd-reason">Reason (required)</label>
                <textarea id="wd-reason" value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} rows={2} style={input} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" style={btn(C.amber, !!busy || withdrawReason.trim().length < 3)} disabled={!!busy || withdrawReason.trim().length < 3}
                    onClick={() => run("withdraw", async () => { await withdrawRelease(confirm.versionId, withdrawReason); setConfirm(null); setWithdrawReason(""); })}>
                    Confirm withdrawal
                  </button>
                  <button type="button" style={btn(C.muted, !!busy)} disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- Client feedback */}
      <div style={box}>
        <p style={h}>3 · Client feedback</p>
        {reviews.length === 0 && clientComments.length === 0 ? (
          <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>No client feedback yet.</p>
        ) : (
          <>
            {reviews.map((r) => {
              const v = versions.find((x) => x.id === r.final_version_id);
              return (
                <div key={r.id} style={{ fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: r.decision === "approved" ? C.green : C.red }}>
                    {r.decision === "approved" ? "✓ Approved" : "↺ Revisions requested"}
                  </span>{" "}
                  v{v?.version ?? "?"} by {r.reviewer_name} · {fmt(r.created_at)}
                  {r.notes && <div style={{ whiteSpace: "pre-wrap", color: C.paper }}>{r.notes}</div>}
                </div>
              );
            })}
            {clientComments.filter((c) => c.kind === "note").map((c) => (
              <div key={c.id} style={{ fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                <span style={{ color: C.muted }}>{c.author_name} · {fmt(c.created_at)}</span>
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {c.video_seconds !== null && c.video_seconds !== undefined ? `${formatTimestamp(c.video_seconds)} — ` : ""}
                  {c.body}
                </div>
              </div>
            ))}
          </>
        )}

        {a.canRouteClientRevision && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: 12.5, margin: "0 0 6px" }}>
              The client requested revisions. Nothing is assigned automatically; choose how to handle it:
            </p>
            <label style={{ fontSize: 12, color: C.muted }} htmlFor="route-note">
              Instructions to share with the freelancer (required to send it back to them)
            </label>
            <textarea id="route-note" value={routeNote} onChange={(e) => setRouteNote(e.target.value)} rows={3} style={input} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button type="button" style={btn(C.blue, !!busy || routeNote.trim().length < 3)} disabled={!!busy || routeNote.trim().length < 3}
                onClick={() => run("route", async () => { await routeClientRevision(shotId, "freelancer", routeNote); setRouteNote(""); })}>
                Send back to freelancer
              </button>
              <button type="button" style={btn(C.teal, !!busy || !a.canRouteInternally)} disabled={!!busy || !a.canRouteInternally}
                onClick={() => run("route", async () => { await routeClientRevision(shotId, "internal", null); })}>
                Handle internally (QC adjustments)
              </button>
            </div>
          </div>
        )}
        {latestRevisionReq && shot.review_status !== "revisions" && (
          <p style={{ fontSize: 11.5, color: C.muted, margin: "8px 0 0" }}>Earlier revision requests are kept in history above.</p>
        )}
      </div>

      {/* ------------------------------------------------------ Internal notes */}
      <div style={box}>
        <p style={h}>Internal QC notes (studio only)</p>
        {internalComments.length === 0 && <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>None yet.</p>}
        {internalComments.map((c) => (
          <div key={c.id} style={{ fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
            <span style={{ color: C.muted }}>{fmt(c.created_at)}</span>
            <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
          </div>
        ))}
        <textarea aria-label="New internal note" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} rows={2} style={{ ...input, marginTop: 8 }} placeholder="Add an internal note…" />
        <button type="button" style={{ ...btn(C.teal, !!busy || !internalNote.trim()), marginTop: 6 }} disabled={!!busy || !internalNote.trim()}
          onClick={() => run("note", async () => { await addCutNote(shotId, internalNote, "internal"); setInternalNote(""); })}>
          Add note
        </button>
      </div>

      <details style={box}>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>Activity history ({activity.length})</summary>
        {activity.map((e) => (
          <div key={e.id} style={{ fontSize: 12.5, padding: "4px 0", color: C.muted }}>
            {fmt(e.created_at)} · {e.audience === "client" ? "[client-visible] " : "[internal] "}
            <span style={{ color: C.paper }}>{e.description}</span>
          </div>
        ))}
      </details>
    </section>
  );
}
