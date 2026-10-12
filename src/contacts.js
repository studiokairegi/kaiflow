// src/contacts.js
//
// Pure (no React, no network) rules for Contacts & Clients. The database
// (supabase/migrations/20261012120000_contacts_clients.sql) is the authority
// for uniqueness and ownership; this module mirrors the validation so the UI
// can explain problems before a round trip, and decides how duplicate
// look-alikes are handled.

export const RELATIONSHIP_LABELS = { prospect: "Prospect", client: "Client" };

export function normalizeEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return v || null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Trim + validate contact form input. Returns { ok, errors, value }.
 * Only the name is required (matches the table's CHECK constraints).
 */
export function validateContactInput(input) {
  const v = {
    name: String(input?.name ?? "").trim(),
    email: String(input?.email ?? "").trim(),
    phone: String(input?.phone ?? "").trim(),
    company: String(input?.company ?? "").trim(),
    roleTitle: String(input?.roleTitle ?? "").trim(),
    website: String(input?.website ?? "").trim(),
    notes: String(input?.notes ?? "").trim(),
  };
  const errors = {};
  if (!v.name) errors.name = "Name is required.";
  else if (v.name.length > 200) errors.name = "Name is too long (200 characters max).";
  if (v.email && !EMAIL_RE.test(v.email)) errors.email = "That email address doesn't look valid.";
  if (v.email.length > 320) errors.email = "Email is too long.";
  if (v.phone.length > 60) errors.phone = "Phone is too long (60 characters max).";
  if (v.company.length > 200) errors.company = "Company is too long (200 characters max).";
  if (v.roleTitle.length > 120) errors.roleTitle = "Role is too long (120 characters max).";
  if (v.website.length > 500) errors.website = "Website is too long.";
  if (v.notes.length > 5000) errors.notes = "Notes are too long (5000 characters max).";
  return { ok: Object.keys(errors).length === 0, errors, value: v };
}

/** Row (snake_case) -> app object. */
export function contactFromRow(row) {
  return {
    id: row.id,
    name: row.name || "",
    email: row.email || "",
    phone: row.phone || "",
    company: row.company || "",
    roleTitle: row.role_title || "",
    website: row.website || "",
    notes: row.notes || "",
    relationship: row.relationship === "client" ? "client" : "prospect",
    clientSince: row.client_since || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/** One-line description that tells similar names apart. */
export function contactSubtitle(c) {
  return [c.company, c.email, c.roleTitle].filter(Boolean).join(" · ");
}

/**
 * Case-insensitive search across name, company and email. Every whitespace
 * separated token must match somewhere. Name-prefix matches rank first, then
 * clients before prospects, then alphabetical.
 */
export function filterContacts(contacts, query = "", relationship = "all") {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = contacts.filter((c) => {
    if (relationship !== "all" && c.relationship !== relationship) return false;
    if (tokens.length === 0) return true;
    const hay = `${c.name}\n${c.company}\n${c.email}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const q = tokens.join(" ");
  const score = (c) => (q && c.name.toLowerCase().startsWith(q) ? 0 : 1);
  return matches.sort(
    (a, b) =>
      score(a) - score(b) ||
      (a.relationship === b.relationship ? 0 : a.relationship === "client" ? -1 : 1) ||
      a.name.localeCompare(b.name)
  );
}

export const MATCH_REASON_TEXT = {
  same_email: "Same email address",
  same_name_and_company: "Same name and company",
  same_name: "Same name",
};

/**
 * Decide what the inline "Add new contact" flow does next, given the
 * duplicate pre-check result. Never merges automatically.
 *   same_email match      -> 'use_existing' (a second contact with that email can't exist)
 *   other look-alikes     -> 'confirm' until the user explicitly chooses to create anyway
 *   nothing found         -> 'create'
 */
export function planInlineCreate({ matches = [], confirmedCreateAnyway = false }) {
  const emailMatch = matches.find((m) => m.reason === "same_email");
  if (emailMatch) return { action: "use_existing", existing: emailMatch };
  if (matches.length > 0 && !confirmedCreateAnyway) return { action: "confirm", matches };
  return { action: "create" };
}

export function newRequestKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ERROR_TEXT = {
  name_required: "Name is required.",
  email_invalid: "That email address doesn't look valid.",
  contact_not_found: "That contact no longer exists or isn't yours.",
  relationship_invalid: "Invalid relationship type.",
  not_authenticated: "Please sign in again.",
};

/** Map a Supabase/Postgres error to a short human sentence. */
export function describeContactError(err, fallback = "Something went wrong. Please try again.") {
  if (!err) return fallback;
  const raw = typeof err === "string" ? err : err.message || "";
  if (err.code === "23505" || /duplicate key|contacts_user_email/i.test(raw)) {
    return "Another contact already uses that email address.";
  }
  if (err.code === "42501" || /row-level security|permission denied/i.test(raw)) {
    return "You don't have permission to do that.";
  }
  if (err.code === "PGRST116") return "That contact couldn't be found.";
  for (const [code, text] of Object.entries(ERROR_TEXT)) {
    if (raw.includes(code)) return text;
  }
  if (/relation .*contacts.* does not exist|Could not find the table/i.test(raw)) {
    return "Contacts aren't set up yet. Apply the contacts migration first.";
  }
  return raw && raw.length < 160 ? raw : fallback;
}

/** Form -> DB row patch (snake_case) for updates. */
export function contactToRowPatch(value) {
  const n = (s) => (s ? s : null);
  return {
    name: value.name,
    email: n(value.email),
    phone: n(value.phone),
    company: n(value.company),
    role_title: n(value.roleTitle),
    website: n(value.website),
    notes: n(value.notes),
  };
}

/**
 * Apply a picker selection to a project form. The contact's stable id is the
 * relationship; `client` stays populated with the contact's name because the
 * rest of the app (invoice "Bill to", shot cards, dashboards) still reads the
 * legacy text field.
 */
export function applyContactSelection(project, selection) {
  return { ...project, contactId: selection?.contactId || null, client: selection?.name || "" };
}

/**
 * Extra columns for a project UPDATE. Empty when the project was loaded
 * without a contact_id column (contacts migration not applied), so saving
 * an existing project can never touch a column that doesn't exist.
 */
export function projectContactUpdateFields(project) {
  return project.contactId === undefined ? {} : { contact_id: project.contactId || null };
}
