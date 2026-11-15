// src/cutWorkflowApi.js
// Thin network layer for the cut review workflow. Every state change goes
// through a server-side function (SECURITY DEFINER RPC or Edge Function);
// nothing here writes the workflow tables directly.

import { supabase, functionUrl } from "./supabaseClient";
import { describeWorkflowError } from "./cutWorkflow.js";
import { uploadResumableDriveFile, pendingStorageKey } from "./resumableDriveUpload.js";

function rpcError(error) {
  return new Error(describeWorkflowError(error));
}

// ------------------------------------------------------------------ studio

/** Everything the QC workspace shows for one cut. RLS limits rows to the owner. */
export async function loadCutWorkspace(shotId) {
  const [shot, subs, finals, comments, reviews, activity] = await Promise.all([
    supabase.from("shots").select("id, title, project_id, assigned_to, workflow_state, review_status, revisions").eq("id", shotId).maybeSingle(),
    supabase.from("cut_submissions").select("*").eq("shot_id", shotId).order("version", { ascending: false }),
    supabase.from("cut_final_versions").select("*").eq("shot_id", shotId).order("uploaded_at", { ascending: false }),
    supabase.from("cut_comments").select("*").eq("shot_id", shotId).order("created_at", { ascending: false }),
    supabase.from("cut_client_reviews").select("*").eq("shot_id", shotId).order("created_at", { ascending: false }),
    supabase.from("activity_log").select("id, event_type, description, audience, created_at").eq("shot_id", shotId).order("created_at", { ascending: false }).limit(50),
  ]);
  const firstError = [shot, subs, finals, comments, reviews, activity].find((r) => r.error)?.error;
  if (firstError) throw rpcError(firstError);
  return {
    shot: shot.data,
    submissions: subs.data || [],
    versions: finals.data || [],
    comments: comments.data || [],
    reviews: reviews.data || [],
    activity: activity.data || [],
  };
}

async function call(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw rpcError(error);
  return data;
}

export const qcApprove = (submissionId, internalNotes) =>
  call("qc_review_submission", {
    p_submission_id: submissionId,
    p_decision: "approve",
    p_internal_notes: internalNotes || null,
    p_correction_notes: null,
  });

export const qcRequestCorrections = (submissionId, correctionNotes, internalNotes) =>
  call("qc_review_submission", {
    p_submission_id: submissionId,
    p_decision: "corrections",
    p_internal_notes: internalNotes || null,
    p_correction_notes: correctionNotes,
  });

export const qcMarkInHouse = (shotId, note) =>
  call("qc_mark_in_house", { p_shot_id: shotId, p_note: note || null });

export const releaseFinalVersion = (versionId, notes) =>
  call("release_final_version", { p_version_id: versionId, p_notes: notes || null });

export const withdrawRelease = (versionId, reason) =>
  call("withdraw_release", { p_version_id: versionId, p_reason: reason });

export const routeClientRevision = (shotId, route, note) =>
  call("route_client_revision", { p_shot_id: shotId, p_route: route, p_note: note || null });

export const addCutNote = (shotId, body, audience = "internal") =>
  call("add_cut_note", { p_shot_id: shotId, p_body: body, p_audience: audience });

/** Upload the QC-adjusted final file directly to Drive using a resumable session. */
export async function uploadFinalFile({ shotId, file, uploadKey, onProgress, onStatus }) {
  // The auth header is resolved for EVERY request (init, recover, finalize), not once up front: a transfer that outlives
  // the access-token lifetime must still finalize with the refreshed session (getSession() refreshes an expired token).
  const getHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Please sign in again.");
    return { Authorization: `Bearer ${session.access_token}` };
  };
  await getHeaders(); // fail fast, before reading the file, when signed out
  let result;
  try {
    result = await uploadResumableDriveFile({
      url: functionUrl("final-qc-upload"),
      headers: getHeaders,
      actionPayload: { shotId, uploadKey },
      // Persisted per shot + file content: after a reload the original upload key is reused (it wins over
      // `uploadKey`), so the interrupted upload is recovered/finalized instead of duplicated.
      uploadId: uploadKey,
      storageKey: pendingStorageKey(`finalqc.${shotId}`),
      file,
      onProgress,
      onStatus,
    });
  } catch (error) {
    // The Final QC upload key doubles as the Drive upload id. A file whose bytes did not match what the user selected is
    // permanently bound to that key (a retry would find the same bad file again), so surface it exactly like a validation
    // rejection: the panel rotates to a NEW key and the retry uploads fresh.
    if (error?.code === "file_mismatch") {
      const rejected = new Error(error.message);
      rejected.code = "final_invalid";
      throw rejected;
    }
    throw error;
  }
  if (!result?.success) {
    // The server stores a rejected file against its upload key permanently, so the caller must use a NEW key to retry.
    const failure = new Error(result?.error || "The final file failed Drive validation.");
    failure.code = "final_invalid";
    throw failure;
  }
  return result;
}

// ------------------------------------------------------------------ client

/** null => invalid link. Never contains Drive ids, raw submissions or internal notes. */
export async function getClientCuts(token) {
  const { data, error } = await supabase.rpc("get_client_cuts", { p_token: token });
  if (error) throw rpcError(error);
  return data;
}

export const clientAddComment = (token, shotId, versionId, author, body, seconds) =>
  call("client_add_comment", {
    p_token: token,
    p_shot_id: shotId,
    p_version_id: versionId,
    p_author: author,
    p_body: body,
    p_seconds: seconds ?? null,
  });

export const clientRequestRevisions = (token, shotId, versionId, author, notes) =>
  call("client_request_revisions", {
    p_token: token,
    p_shot_id: shotId,
    p_version_id: versionId,
    p_author: author,
    p_notes: notes,
  });

export const clientApproveCut = (token, shotId, versionId, author) =>
  call("client_approve_cut", { p_token: token, p_shot_id: shotId, p_version_id: versionId, p_author: author });

/** Asks the server for a 60-second signed download URL, then navigates to it. */
export async function clientDownload(token, shotId, versionId) {
  const res = await fetch(functionUrl("client-final-download"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, shotId, versionId }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || !result.url) throw new Error("This file isn't available for download right now.");
  window.location.assign(result.url);
}

// -------------------------------------------------------------- freelancer

/** Additive to get_shared_shot; null on failure so the portal degrades to today's behaviour. */
export async function getFreelancerReview(token) {
  try {
    const { data, error } = await supabase.rpc("get_shared_shot_review", { p_token: token });
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}
