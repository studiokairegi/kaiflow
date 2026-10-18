// Run: node --test src/cutWorkflow.inhouse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as W from "./cutWorkflow.js";

const sub = (over = {}) => ({ id: "s1", version: 1, status: "pending", drive_file_id: "abc", ...over });

test("in-house is offered only when nothing is waiting on QC", () => {
  const offer = (workflowState, submissions = []) => W.studioActions({ workflowState, reviewStatus: "in_progress", submissions, versions: [] }).canMarkInHouse;
  assert.equal(offer("in_progress"), true);
  assert.equal(offer("in_progress", [sub({ status: "corrections_requested" })]), true);
  assert.equal(offer("pending_review", [sub()]), false);
  assert.equal(offer("qc_adjustments", [sub({ status: "approved" })]), false);
  assert.equal(offer("ready_for_client", [sub({ status: "approved" })]), false);
  assert.equal(offer("released", [sub({ status: "approved" })]), false);
});

test("an in-house record unlocks final upload and (with a valid final) release", () => {
  const inHouse = sub({ status: "approved", drive_file_id: "inhouse:1234" });
  assert.equal(W.isInHouseSubmission(inHouse), true);
  assert.equal(W.isInHouseSubmission(sub()), false);
  const a = W.studioActions({ workflowState: "qc_adjustments", reviewStatus: "in_progress", submissions: [inHouse], versions: [] });
  assert.equal(a.canUploadFinal, true);
  assert.equal(a.canRelease, false);
  const v = { id: "v1", version: 1, validation_status: "valid", is_current: true, delivery_state: "unreleased" };
  assert.equal(W.studioActions({ workflowState: "ready_for_client", reviewStatus: "in_progress", submissions: [inHouse], versions: [v] }).canRelease, true);
});

test("upload-locked messages say what to do for each state", () => {
  const msg = (workflowState, submissions) => W.unavailableReason("final_upload", { workflowState, submissions, versions: [] });
  assert.match(msg("in_progress", []), /No freelancer submission yet.*in-house QC check as passed/);
  assert.match(msg("in_progress", [sub({ status: "corrections_requested" })]), /corrected upload/);
  assert.match(msg("pending_review", [sub()]), /Approve .*internal QC/);
  assert.match(msg("qc_adjustments", [sub()]), /internal QC/);
  assert.equal(msg("qc_adjustments", [sub({ status: "approved" })]), null);
});

test("server error code is translated", () => {
  assert.match(W.describeWorkflowError("in_house_not_available"), /in-house QC check/);
});
