// Unit tests for the pure workflow rules (src/cutWorkflow.js) plus the Edge
// Function helpers that need no network (final-file validation, download tickets).
// Run: node --test src/cutWorkflow.test.mjs
//
// These cover what Node can execute. The database transitions (RLS, row locks,
// idempotency, version-specific approval) live in SQL and are covered by
// cut_review_tests.sql, which must be run against a real Postgres.

import test from "node:test";
import assert from "node:assert/strict";
import * as W from "./cutWorkflow.js";
import { validateFinalUploadInput, validateDriveFile, MAX_FINAL_BYTES } from "../supabase/functions/_shared/final_validation.ts";
import { signTicket, verifyTicket } from "../supabase/functions/_shared/download_ticket.ts";

const sub = (over = {}) => ({ id: "s1", version: 1, status: "pending", ...over });
const ver = (over = {}) => ({ id: "v1", version: 1, validation_status: "valid", is_current: true, delivery_state: "unreleased", ...over });

// ---------------------------------------------------------------- QC stage
test("pending review: approve and request-corrections are offered; final upload is not", () => {
  const a = W.studioActions({ workflowState: "pending_review", reviewStatus: "in_progress", submissions: [sub()], versions: [] });
  assert.equal(a.canApprove, true);
  assert.equal(a.canRequestCorrections, true);
  assert.equal(a.canUploadFinal, false);
  assert.equal(a.canRelease, false);
});

test("in progress: nothing to review, nothing to upload", () => {
  const a = W.studioActions({ workflowState: "in_progress", reviewStatus: "in_progress", submissions: [sub({ status: "corrections_requested" })], versions: [] });
  assert.equal(a.canApprove, false);
  assert.equal(a.canUploadFinal, false);
});

test("internal QC approval unlocks final upload but NOT release or downloads", () => {
  const a = W.studioActions({ workflowState: "qc_adjustments", reviewStatus: "in_progress", submissions: [sub({ status: "approved" })], versions: [] });
  assert.equal(a.canUploadFinal, true);
  assert.equal(a.canRelease, false);
  assert.equal(W.clientDownloadState({ downloadEnabled: false, release: null }).enabled, false);
});

test("final upload stays locked without an approved submission, whatever the state says", () => {
  const a = W.studioActions({ workflowState: "qc_adjustments", reviewStatus: "in_progress", submissions: [sub()], versions: [] });
  assert.equal(a.canUploadFinal, false);
  assert.match(W.unavailableReason("final_upload", { workflowState: "qc_adjustments", submissions: [sub()], versions: [] }), /internal QC/);
});

// ------------------------------------------------------- delivery gating
test("a valid current final can be released only after QC approval", () => {
  const ok = W.studioActions({ workflowState: "ready_for_client", reviewStatus: "in_progress", submissions: [sub({ status: "approved" })], versions: [ver()] });
  assert.equal(ok.canRelease, true);
  const noApproval = W.studioActions({ workflowState: "ready_for_client", reviewStatus: "in_progress", submissions: [sub()], versions: [ver()] });
  assert.equal(noApproval.canRelease, false);
});

test("an invalid / non-current / already released final cannot be released", () => {
  const base = { workflowState: "ready_for_client", reviewStatus: "in_progress", submissions: [sub({ status: "approved" })] };
  assert.equal(W.studioActions({ ...base, versions: [ver({ validation_status: "invalid" })] }).canRelease, false);
  assert.equal(W.studioActions({ ...base, versions: [ver({ is_current: false })] }).canRelease, false);
  assert.equal(W.studioActions({ ...base, versions: [ver({ delivery_state: "released" })] }).canRelease, false);
});

test("a withdrawn current version can be released again; withdraw is offered only while released", () => {
  const base = { workflowState: "ready_for_client", reviewStatus: "in_progress", submissions: [sub({ status: "approved" })] };
  assert.equal(W.studioActions({ ...base, versions: [ver({ delivery_state: "withdrawn" })] }).canRelease, true);
  assert.equal(W.studioActions({ ...base, versions: [ver({ delivery_state: "released" })] }).canWithdraw, true);
  assert.equal(W.studioActions({ ...base, versions: [ver()] }).canWithdraw, false);
});

test("a replacement can be uploaded while an older version stays released", () => {
  const a = W.studioActions({
    workflowState: "released", reviewStatus: "waiting", submissions: [sub({ status: "approved" })],
    versions: [ver({ id: "v2", version: 2 }), ver({ id: "v1", version: 1, is_current: false, delivery_state: "released" })],
  });
  assert.equal(a.canUploadFinal, true);
  assert.equal(a.canRelease, true);
  assert.equal(a.releasedVersion.id, "v1");
  assert.equal(a.currentFinal.id, "v2");
});

// ------------------------------------------------------ client revisions
test("client revision request is routed by the studio, never automatically", () => {
  const a = W.studioActions({ workflowState: "released", reviewStatus: "revisions", submissions: [sub({ status: "approved" })], versions: [ver({ delivery_state: "released" })] });
  assert.equal(a.canRouteClientRevision, true);
  assert.equal(a.canRouteInternally, true);
  const none = W.studioActions({ workflowState: "released", reviewStatus: "waiting", submissions: [sub({ status: "approved" })], versions: [ver({ delivery_state: "released" })] });
  assert.equal(none.canRouteClientRevision, false);
});

// ------------------------------------------------------- client download
test("client Download is disabled until a version is released", () => {
  assert.deepEqual(W.clientDownloadState({ downloadEnabled: false, release: null }), { enabled: false, reason: "Not yet available" });
  assert.equal(W.clientDownloadState(undefined).enabled, false);
  assert.equal(W.clientDownloadState({ downloadEnabled: true, release: null }).enabled, false);
  assert.equal(W.clientDownloadState({ downloadEnabled: true, release: { versionId: "x" } }).enabled, true);
});

test("client status derivation is version-specific", () => {
  assert.equal(W.deriveClientStatus({ released: false }), "in_production");
  assert.equal(W.deriveClientStatus({ released: true }), "client_review");
  assert.equal(W.deriveClientStatus({ released: true, decision: "approved" }), "client_approved");
  assert.equal(W.deriveClientStatus({ released: true, decision: "revisions_requested" }), "client_revisions_requested");
  // a NEW release has no decision yet, so an earlier approval does not carry over
  assert.equal(W.deriveClientStatus({ released: true, decision: undefined }), "client_review");
});

test("freelancer submissions accepted only while in progress / pending", () => {
  for (const s of ["in_progress", "pending_review"]) assert.equal(W.acceptsSubmissions(s), true);
  for (const s of ["qc_adjustments", "ready_for_client", "released"]) assert.equal(W.acceptsSubmissions(s), false);
});

// ------------------------------------------------------------- helpers
test("timestamp parsing and formatting round-trip", () => {
  assert.equal(W.parseTimestamp("00:12"), 12);
  assert.equal(W.parseTimestamp("1:05"), 65);
  assert.equal(W.parseTimestamp("01:02:03"), 3723);
  assert.equal(W.parseTimestamp("00:75"), null);
  assert.equal(W.parseTimestamp("abc"), null);
  assert.equal(W.formatTimestamp(12), "00:12");
  assert.equal(W.formatTimestamp(3723), "1:02:03");
  assert.equal(W.formatTimestamp(null), "");
});

test("server error codes map to readable text", () => {
  assert.match(W.describeWorkflowError({ message: "boom: correction_notes_required" }), /notes for the freelancer/);
  assert.match(W.describeWorkflowError({ message: "version_not_available" }), /refresh/);
  assert.equal(W.describeWorkflowError({ message: "x".repeat(500) }), "Something went wrong. Please try again.");
});

test("upload keys are unique per attempt", () => {
  assert.notEqual(W.newUploadKey(), W.newUploadKey());
  assert.match(W.newUploadKey(), /^[0-9a-f]{32}$/);
});

// --------------------------------------------- Edge Function: validation
test("final upload input validation", () => {
  assert.equal(validateFinalUploadInput({ name: "cut01.mov", size: 1000 }).ok, true);
  assert.equal(validateFinalUploadInput({ name: "cut01.mov", size: 0 }).ok, false);
  assert.equal(validateFinalUploadInput({ name: "cut01.mov", size: 5 * 1024 ** 3 }).ok, true); // no app-level size cap
  assert.equal(MAX_FINAL_BYTES, Number.POSITIVE_INFINITY);
  assert.equal(validateFinalUploadInput({ name: "setup.exe", size: 10 }).ok, false);
  assert.equal(validateFinalUploadInput({ name: "", size: 10 }).ok, false);
});

test("Drive-side validation catches missing, trashed, misplaced and mismatched files", () => {
  const exp = { fileId: "f1", folderId: "fold", sizeBytes: 100 };
  const good = { id: "f1", parents: ["fold"], size: "100", trashed: false };
  assert.equal(validateDriveFile(good, exp), null);
  assert.match(validateDriveFile(null, exp), /could not be found/);
  assert.match(validateDriveFile({ ...good, trashed: true }, exp), /trash/);
  assert.match(validateDriveFile({ ...good, parents: ["other"] }, exp), /Final QC folder/);
  assert.match(validateDriveFile({ ...good, size: "99" }, exp), /size/);
  assert.match(validateDriveFile({ ...good, id: "zzz" }, exp), /different file/);
});

// ------------------------------------------- Edge Function: download tickets
test("download tickets: valid, tampered, expired, wrong secret", async () => {
  const now = 1_000_000;
  const t = await signTicket({ v: "ver", s: "shot", exp: now + 60 }, "secret-a");
  assert.deepEqual(await verifyTicket(t, "secret-a", now), { v: "ver", s: "shot", exp: now + 60 });
  assert.equal(await verifyTicket(t, "secret-b", now), null);            // wrong key
  assert.equal(await verifyTicket(t, "secret-a", now + 61), null);       // expired
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ v: "OTHER", s: "shot", exp: now + 60 })).toString("base64url");
  assert.equal(await verifyTicket(`${forged}.${sig}`, "secret-a", now), null); // payload swapped
  assert.equal(await verifyTicket("garbage", "secret-a", now), null);
  assert.equal(await verifyTicket(`${body}.`, "secret-a", now), null);
});
