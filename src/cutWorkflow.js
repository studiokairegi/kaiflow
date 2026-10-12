// src/cutWorkflow.js
//
// Pure (no React, no network) rules for the cut review -> QC -> Final QC ->
// client delivery workflow. The database functions in
// supabase/migrations/20261012090000_cut_review_final_delivery.sql are the
// authority; this module only decides what the UI should OFFER, so a button
// is never shown that the server would reject. Nothing here grants access.
//
// Two separate state fields (see the migration header):
//   workflowState  internal:  in_progress | pending_review | qc_adjustments
//                             | ready_for_client | released
//   reviewStatus   existing client-facing: in_progress | waiting | revisions | approved

export const WORKFLOW_STATES = [
  "in_progress",
  "pending_review",
  "qc_adjustments",
  "ready_for_client",
  "released",
];

export const WORKFLOW_LABELS = {
  in_progress: "In Progress",
  pending_review: "Pending Review",
  qc_adjustments: "QC Adjustments & Final Upload",
  ready_for_client: "Ready for Client",
  released: "Released to Client",
};

export const CLIENT_STATUS_LABELS = {
  in_production: "In production",
  client_review: "Ready for your review",
  client_revisions_requested: "Revisions requested",
  client_approved: "Approved",
};

// Text/shape cue so status never relies on colour alone.
export const CLIENT_STATUS_ICONS = {
  in_production: "…",
  client_review: "●",
  client_revisions_requested: "↺",
  client_approved: "✓",
};

export function workflowLabel(state) {
  return WORKFLOW_LABELS[state] || WORKFLOW_LABELS.in_progress;
}

/**
 * Can this freelancer-facing cut take a new submission right now?
 * Mirrors register_freelancer_submission().
 */
export function acceptsSubmissions(workflowState) {
  return workflowState === "in_progress" || workflowState === "pending_review";
}

/**
 * Which studio actions make sense for a cut. `versions` are cut_final_versions
 * rows (camelCase or snake_case tolerated), `submissions` are cut_submissions rows.
 * Returns plain booleans plus the exact row each action would act on.
 */
export function studioActions({ workflowState, reviewStatus, submissions = [], versions = [] }) {
  const sub = (s) => s.status;
  const pendingSubmission = submissions.find((s) => sub(s) === "pending") || null;
  const approvedSubmission =
    submissions
      .filter((s) => sub(s) === "approved")
      .sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;

  const ver = (v) => ({
    id: v.id,
    version: v.version,
    validation: v.validation_status ?? v.validationStatus,
    isCurrent: v.is_current ?? v.isCurrent,
    delivery: v.delivery_state ?? v.deliveryState,
  });
  const vs = versions.map(ver);
  const currentFinal = vs.find((v) => v.isCurrent && v.validation === "valid") || null;
  const releasedVersion = vs.find((v) => v.delivery === "released") || null;

  const reviewable = workflowState === "pending_review" && !!pendingSubmission;
  const finalUploadUnlocked =
    ["qc_adjustments", "ready_for_client", "released"].includes(workflowState) && !!approvedSubmission;
  const canRelease =
    !!currentFinal && ["unreleased", "withdrawn"].includes(currentFinal.delivery) && !!approvedSubmission;

  return {
    pendingSubmission,
    approvedSubmission,
    currentFinal,
    releasedVersion,
    canApprove: reviewable,
    canRequestCorrections: reviewable,
    canUploadFinal: finalUploadUnlocked,
    canRelease,
    canWithdraw: !!releasedVersion,
    // Studio decides how a client revision is handled; neither option is automatic.
    canRouteClientRevision:
      reviewStatus === "revisions" && ["released", "ready_for_client"].includes(workflowState),
    canRouteInternally: !!approvedSubmission,
  };
}

/** Why an action is unavailable, for the "clear feedback when unavailable" requirement. */
export function unavailableReason(action, ctx) {
  const a = studioActions(ctx);
  switch (action) {
    case "review":
      return a.canApprove ? null : "There is no submission waiting for review.";
    case "final_upload":
      return a.canUploadFinal ? null : "Final upload unlocks after the freelancer's submission passes internal QC.";
    case "release":
      if (a.canRelease) return null;
      if (!a.approvedSubmission) return "Release requires an internally approved submission.";
      if (!a.currentFinal) return "Upload a valid final file first.";
      return "This version is already released.";
    default:
      return null;
  }
}

/**
 * Client download gating. The server re-checks everything; this only decides
 * whether to render the button as active or greyed out.
 */
export function clientDownloadState(cut) {
  if (cut && cut.downloadEnabled && cut.release && cut.release.versionId) {
    return { enabled: true, reason: null };
  }
  return { enabled: false, reason: "Not yet available" };
}

/** "00:12", "1:05", "01:02:03" -> seconds; null if not a timestamp. */
export function parseTimestamp(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec > 59 || (m[1] && min > 59)) return null;
  return h * 3600 + min * 60 + sec;
}

export function formatTimestamp(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "";
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const ERROR_TEXT = {
  invalid_link: "This link isn't valid, or sharing has been turned off.",
  not_found: "That item couldn't be found.",
  not_authenticated: "Please sign in again.",
  submission_not_pending: "This submission was already reviewed.",
  correction_notes_required: "Please add notes for the freelancer describing what to fix.",
  final_upload_not_unlocked: "Final upload unlocks after the freelancer's submission passes internal QC.",
  no_qc_approval: "No approved internal QC submission exists for this cut.",
  final_file_invalid: "This file failed validation and can't be released.",
  not_current_final: "Only the current final version can be released.",
  version_not_releasable: "This version can't be released.",
  withdraw_reason_required: "Please give a reason for withdrawing the release.",
  version_not_released: "This version isn't currently released.",
  no_client_revision_pending: "There's no client revision request waiting.",
  freelancer_note_required: "Please write what the freelancer should change.",
  version_not_available: "That version is no longer the one released. Please refresh.",
  author_required: "Please enter your name.",
  body_invalid: "Please enter a comment (up to 4000 characters).",
  revision_notes_required: "Please describe the changes you'd like (at least a sentence).",
  already_approved: "This version was already approved.",
  revisions_already_requested: "Revisions were already requested on this version.",
  no_released_version: "Nothing is released to the client yet.",
  cut_not_accepting_submissions: "This cut isn't accepting new submissions right now.",
};

/** Map a Supabase/RPC/Edge error to a short human sentence. */
export function describeWorkflowError(err, fallback = "Something went wrong. Please try again.") {
  const raw = typeof err === "string" ? err : err?.message || "";
  for (const [code, text] of Object.entries(ERROR_TEXT)) {
    if (raw.includes(code)) return text;
  }
  return raw && raw.length < 200 ? raw : fallback;
}

/** Client-facing status for a cut, mirroring get_client_cuts(). */
export function deriveClientStatus({ released, decision }) {
  if (!released) return "in_production";
  if (decision === "approved") return "client_approved";
  if (decision === "revisions_requested") return "client_revisions_requested";
  return "client_review";
}

/** Stable per-attempt idempotency key for final uploads (reuse on retry of the same file). */
export function newUploadKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
