import test from "node:test";
import assert from "node:assert/strict";
import { allowedWorkspaceKeys, buildInviteLink, createInviteToken, normalizeInviteEmail } from "./access.js";

test("Master User retains the full workspace set while Chat is not a workspace module", () => {
  const keys = allowedWorkspaceKeys({ is_member: true, role: "master_user" });
  assert.deepEqual(keys, ["dashboard", "leads", "planner", "projects", "teams", "finance", "payments"]);
  assert.equal(keys.includes("chat"), false);
});

test("Sales staff only gets dashboard and CRM when no other permissions are granted", () => {
  assert.deepEqual(allowedWorkspaceKeys({ is_member: true, role: "staff", department_permission_keys: ["crm.read", "contacts.read"] }), ["dashboard", "leads"]);
});

test("assigned project access enables Projects without granting Finance or Teams", () => {
  assert.deepEqual(allowedWorkspaceKeys({ is_member: true, role: "freelancer", department_permission_keys: [], assigned_project_count: 1 }), ["dashboard", "projects"]);
});

test("read-only finance permission does not mount the owner-scoped ledger for staff", () => {
  assert.deepEqual(allowedWorkspaceKeys({ is_member: true, role: "staff", department_permission_keys: ["invoices.read"] }), ["dashboard"]);
});

test("secure invite token is 256-bit lowercase hex and link retains only invite parameter", () => {
  const cryptoObject = { getRandomValues: (bytes) => { bytes.fill(7); return bytes; } };
  const token = createInviteToken(cryptoObject);
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
  const url = new URL(buildInviteLink(token, "https://app.studiokairegi.com"));
  assert.equal(url.origin, "https://app.studiokairegi.com");
  assert.equal(url.searchParams.get("studio-invite"), token);
  assert.equal(url.searchParams.has("signup"), false);
});

test("invite link rejects malformed bearer tokens and email comparison normalizes case", () => {
  assert.throws(() => buildInviteLink("not-a-token", "https://app.studiokairegi.com"), /Invalid invitation token/);
  assert.equal(normalizeInviteEmail("  STAFF@Studio.example "), "staff@studio.example");
});

test("explicit non-membership fails closed while legacy RPC absence can fall back", () => {
  assert.deepEqual(allowedWorkspaceKeys({ is_member: false }), ["dashboard"]);
  assert.deepEqual(allowedWorkspaceKeys(null, { legacyFallback: false }), ["dashboard"]);
  assert.deepEqual(allowedWorkspaceKeys(null, { legacyFallback: true }), ["dashboard", "leads", "planner", "projects", "teams", "finance", "payments"]);
});
