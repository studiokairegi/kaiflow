// Tests for Contacts & Clients logic that Node can execute: validation, search,
// duplicate-handling plan, project/contact hand-off, and the API layer against
// a fake Supabase client (verifies what is sent and how failures surface).
// Uniqueness, ownership, the Won-deal trigger and the backfill live in SQL:
// see contacts_tests.sql, which needs a real Postgres.
// Run: node --test src/contacts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as K from "./contacts.js";
import { makeContactsApi } from "./contactsApi.js";

const row = (o = {}) => ({ id: "c1", name: "Vicente Carro", email: "v@anime.is", company: "Anime GenSys", relationship: "prospect", ...o });

// ---------------------------------------------------------------- validation
test("name is required; email must look valid; limits enforced", () => {
  assert.equal(K.validateContactInput({ name: "  " }).ok, false);
  assert.equal(K.validateContactInput({ name: "A", email: "nope" }).errors.email.length > 0, true);
  assert.equal(K.validateContactInput({ name: "A", email: "a@b.co" }).ok, true);
  assert.equal(K.validateContactInput({ name: "x".repeat(201) }).ok, false);
  assert.equal(K.validateContactInput({ name: "A", notes: "n".repeat(5001) }).ok, false);
  assert.equal(K.validateContactInput({ name: "  Ana  " }).value.name, "Ana");
});

test("email normalization for duplicate detection", () => {
  assert.equal(K.normalizeEmail("  Vicente@Anime.IS "), "vicente@anime.is");
  assert.equal(K.normalizeEmail(""), null);
  assert.equal(K.normalizeEmail(undefined), null);
});

// ------------------------------------------------------------ search/display
test("search matches name, company and email; every token must match", () => {
  const cs = [
    K.contactFromRow(row()),
    K.contactFromRow(row({ id: "c2", name: "Vicente Lopez", email: "vl@other.com", company: "Other Studio", relationship: "client" })),
    K.contactFromRow(row({ id: "c3", name: "Mia", email: "mia@x.io", company: "" })),
  ];
  assert.equal(K.filterContacts(cs, "vicente").length, 2);
  assert.deepEqual(K.filterContacts(cs, "gensys").map((c) => c.id), ["c1"]);
  assert.deepEqual(K.filterContacts(cs, "MIA@X").map((c) => c.id), ["c3"]);
  assert.deepEqual(K.filterContacts(cs, "vicente other").map((c) => c.id), ["c2"]);
  assert.equal(K.filterContacts(cs, "zzz").length, 0);
  assert.deepEqual(K.filterContacts(cs, "", "client").map((c) => c.id), ["c2"]);
  // clients rank before prospects among equal matches
  assert.equal(K.filterContacts(cs, "vicente")[0].id, "c2");
});

test("similar names are distinguishable in the selector subtitle", () => {
  const a = K.contactFromRow(row());
  const b = K.contactFromRow(row({ id: "c2", email: "other@x.com", company: "Other Studio" }));
  assert.notEqual(K.contactSubtitle(a), K.contactSubtitle(b));
  assert.match(K.contactSubtitle(a), /Anime GenSys · v@anime.is/);
});

// ------------------------------------------------------ duplicate handling
test("inline create: same email reuses; look-alikes need confirmation; nothing found creates", () => {
  assert.equal(K.planInlineCreate({ matches: [{ id: "x", reason: "same_email" }] }).action, "use_existing");
  assert.equal(K.planInlineCreate({ matches: [{ id: "x", reason: "same_email" }], confirmedCreateAnyway: true }).action, "use_existing"); // never two rows per email
  assert.equal(K.planInlineCreate({ matches: [{ id: "x", reason: "same_name" }] }).action, "confirm");
  assert.equal(K.planInlineCreate({ matches: [{ id: "x", reason: "same_name" }], confirmedCreateAnyway: true }).action, "create");
  assert.equal(K.planInlineCreate({ matches: [] }).action, "create");
});

// ------------------------------------------------- project <-> contact link
test("selecting a contact sets the stable id and keeps the legacy client text in step", () => {
  const p = { name: "Trailer", client: "Old Name", contactId: null, budget: "100" };
  const q = K.applyContactSelection(p, { contactId: "c1", name: "Vicente Carro" });
  assert.equal(q.contactId, "c1");
  assert.equal(q.client, "Vicente Carro");
  assert.equal(q.budget, "100"); // unrelated fields untouched
  assert.deepEqual(K.applyContactSelection(p, null).contactId, null);
});

test("project updates never write contact_id when the column isn't present (legacy rows / pre-migration)", () => {
  assert.deepEqual(K.projectContactUpdateFields({ contactId: undefined }), {});
  assert.deepEqual(K.projectContactUpdateFields({ contactId: null }), { contact_id: null });
  assert.deepEqual(K.projectContactUpdateFields({ contactId: "c1" }), { contact_id: "c1" });
});

// ------------------------------------------------------------- API layer
function fakeSb({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  const chain = (name, result) => {
    const q = { _name: name };
    for (const m of ["select", "order", "eq", "update", "insert"]) q[m] = (...a) => { calls.push([name, m, a]); return q; };
    q.maybeSingle = async () => result;
    q.single = async () => result;
    q.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return q;
  };
  return {
    calls,
    from: (name) => chain(name, tables[name] ?? { data: [], error: null }),
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return rpc[name] ? (typeof rpc[name] === "function" ? rpc[name](args) : rpc[name]) : { data: null, error: null }; },
  };
}

test("create: validates before any network call", async () => {
  const sb = fakeSb();
  await assert.rejects(makeContactsApi(sb).create({ name: "" }), /Name is required/);
  assert.equal(sb.calls.length, 0);
});

test("create: sends normalized fields and the idempotency key; maps the result", async () => {
  const sb = fakeSb({ rpc: { create_contact: { data: { contact: row(), created: true, duplicate: false }, error: null } } });
  const r = await makeContactsApi(sb).create({ name: " Vicente Carro ", email: "v@anime.is", company: "Anime GenSys" }, { relationship: "client", requestKey: "key12345" });
  const call = sb.calls.find((c) => c[0] === "rpc");
  assert.equal(call[2].p_name, "Vicente Carro");
  assert.equal(call[2].p_relationship, "client");
  assert.equal(call[2].p_request_key, "key12345");
  assert.equal(r.created, true);
  assert.equal(r.contact.id, "c1");
});

test("repeated submission with the same key resolves to the same contact, created=false", async () => {
  const first = { data: { contact: row(), created: true, duplicate: false }, error: null };
  const again = { data: { contact: row(), created: false, duplicate: false }, error: null };
  let n = 0;
  const sb = fakeSb({ rpc: { create_contact: () => (n++ === 0 ? first : again) } });
  const api = makeContactsApi(sb);
  const a = await api.create({ name: "Vicente" }, { requestKey: "samekey1" });
  const b = await api.create({ name: "Vicente" }, { requestKey: "samekey1" });
  assert.equal(a.contact.id, b.contact.id);
  assert.equal(b.created, false);
  const keys = sb.calls.filter((c) => c[0] === "rpc").map((c) => c[2].p_request_key);
  assert.deepEqual(keys, ["samekey1", "samekey1"]);
});

test("existing email returns the existing contact flagged as duplicate", async () => {
  const sb = fakeSb({ rpc: { create_contact: { data: { contact: row(), created: false, duplicate: true }, error: null } } });
  const r = await makeContactsApi(sb).create({ name: "Vicente C", email: "V@ANIME.IS" });
  assert.deepEqual([r.created, r.duplicate], [false, true]);
});

test("a created contact appears in the next list() call (available in later project forms)", async () => {
  const store = [row()];
  const sb = fakeSb({ tables: { contacts: { data: store, error: null } }, rpc: { create_contact: () => { store.push(row({ id: "c9", name: "New Person", email: "n@p.io" })); return { data: { contact: row({ id: "c9", name: "New Person" }), created: true, duplicate: false }, error: null }; } } });
  const api = makeContactsApi(sb);
  assert.equal((await api.list()).length, 1);
  await api.create({ name: "New Person", email: "n@p.io" });
  assert.deepEqual((await api.list()).map((c) => c.id), ["c1", "c9"]);
});

test("edit: sends only contact fields, never ownership or relationship ids", async () => {
  const sb = fakeSb({ tables: { contacts: { data: row({ name: "Renamed" }), error: null } } });
  const updated = await makeContactsApi(sb).update("c1", { name: "Renamed", email: "" });
  const upd = sb.calls.find((c) => c[1] === "update")[2][0];
  assert.deepEqual(Object.keys(upd).sort(), ["company", "email", "name", "notes", "phone", "role_title", "website"]);
  assert.equal(upd.email, null);
  assert.equal(updated.name, "Renamed");
});

test("failures surface as readable errors: duplicate email, permission, missing table, generic", async () => {
  const mk = (error) => makeContactsApi(fakeSb({ tables: { contacts: { data: null, error } }, rpc: { create_contact: { data: null, error } } }));
  await assert.rejects(mk({ code: "23505", message: "duplicate key value violates unique constraint \"contacts_user_email_uidx\"" }).update("c1", { name: "A" }), /already uses that email/);
  await assert.rejects(mk({ code: "42501", message: "new row violates row-level security policy" }).update("c1", { name: "A" }), /permission/);
  await assert.rejects(mk({ message: "Could not find the table 'public.contacts'" }).list(), /migration/);
  await assert.rejects(mk({ message: "x".repeat(400) }).create({ name: "A" }), /Something went wrong/);
  await assert.rejects(mk({ message: "email_invalid" }).create({ name: "A" }), /doesn't look valid/);
});

test("findMatches failure is non-fatal (the create path still works)", async () => {
  const sb = fakeSb({ rpc: { find_contact_matches: { data: null, error: { message: "boom" } } } });
  assert.deepEqual(await makeContactsApi(sb).findMatches({ name: "A" }), []);
});

test("links() returns deals and projects for a contact and surfaces failures", async () => {
  const sb = fakeSb({ tables: { leads: { data: [{ id: "l1", company_name: "Anime GenSys", stage: "won" }], error: null }, projects: { data: [{ id: "p1", name: "Trailer", archived: false }], error: null } } });
  const l = await makeContactsApi(sb).links("c1");
  assert.deepEqual(l.leads[0], { id: "l1", name: "Anime GenSys", stage: "won" });
  assert.equal(l.projects[0].name, "Trailer");
  const bad = makeContactsApi(fakeSb({ tables: { leads: { data: null, error: { code: "42501", message: "rls" } } } }));
  await assert.rejects(bad.links("c1"), /permission/);
});

test("request keys are unique per form", () => {
  assert.notEqual(K.newRequestKey(), K.newRequestKey());
  assert.match(K.newRequestKey(), /^[0-9a-f]{32}$/);
});
