// src/contactsApi.js
// Network layer for Contacts, as a factory so it can be tested with a fake
// Supabase client. It imports nothing; the app instance lives in
// contactsInstance.js. Every write goes through RLS (owner only) and the
// database's own uniqueness/ownership checks.

import { contactFromRow, contactToRowPatch, validateContactInput, describeContactError, newRequestKey } from "./contacts.js";

export function makeContactsApi(sb) {
  const fail = (error) => {
    const e = new Error(describeContactError(error));
    e.code = error?.code;
    throw e;
  };

  return {
    async list() {
      const { data, error } = await sb.from("contacts").select("*").order("name", { ascending: true });
      if (error) fail(error);
      return (data || []).map(contactFromRow);
    },

    async get(id) {
      const { data, error } = await sb.from("contacts").select("*").eq("id", id).maybeSingle();
      if (error) fail(error);
      return data ? contactFromRow(data) : null;
    },

    /** Look-alikes for the duplicate pre-check. Failure is non-fatal: returns []. */
    async findMatches({ name, email, company }) {
      const { data, error } = await sb.rpc("find_contact_matches", {
        p_name: name || "",
        p_email: email || null,
        p_company: company || null,
      });
      if (error) return [];
      return (data || []).map((m) => ({
        id: m.id, name: m.name, email: m.email || "", company: m.company || "",
        relationship: m.relationship, reason: m.reason,
      }));
    },

    /**
     * Idempotent create. Re-sending the same requestKey (double click / retry)
     * returns the first row; the same email returns the existing contact.
     * Resolves { contact, created, duplicate }.
     */
    async create(input, { relationship = "prospect", requestKey = newRequestKey() } = {}) {
      const v = validateContactInput(input);
      if (!v.ok) {
        const e = new Error(Object.values(v.errors)[0]);
        e.validation = v.errors;
        throw e;
      }
      const { data, error } = await sb.rpc("create_contact", {
        p_name: v.value.name,
        p_email: v.value.email || null,
        p_phone: v.value.phone || null,
        p_company: v.value.company || null,
        p_role_title: v.value.roleTitle || null,
        p_website: v.value.website || null,
        p_notes: v.value.notes || null,
        p_relationship: relationship,
        p_request_key: requestKey,
      });
      if (error) fail(error);
      return { contact: contactFromRow(data.contact), created: !!data.created, duplicate: !!data.duplicate };
    },

    async update(id, input) {
      const v = validateContactInput(input);
      if (!v.ok) {
        const e = new Error(Object.values(v.errors)[0]);
        e.validation = v.errors;
        throw e;
      }
      const { data, error } = await sb.from("contacts").update(contactToRowPatch(v.value)).eq("id", id).select().single();
      if (error) fail(error);
      return contactFromRow(data);
    },

    async setRelationship(id, relationship) {
      const { data, error } = await sb.from("contacts").update({ relationship }).eq("id", id).select().single();
      if (error) fail(error);
      return contactFromRow(data);
    },

    /** Deals and projects that reference this contact (RLS limits to the owner). */
    async links(contactId) {
      const [leads, projects] = await Promise.all([
        sb.from("leads").select("id, company_name, stage").eq("contact_id", contactId),
        sb.from("projects").select("id, name, archived").eq("contact_id", contactId),
      ]);
      if (leads.error) fail(leads.error);
      if (projects.error) fail(projects.error);
      return {
        leads: (leads.data || []).map((l) => ({ id: l.id, name: l.company_name, stage: l.stage })),
        projects: (projects.data || []).map((p) => ({ id: p.id, name: p.name, archived: !!p.archived })),
      };
    },

    /** Links a created project to its contact (separate from the project-create RPC on purpose). */
    async linkProject(projectId, contactId) {
      const { error } = await sb.from("projects").update({ contact_id: contactId }).eq("id", projectId);
      if (error) fail(error);
    },

    async backfillFromWonLeads() {
      const { data, error } = await sb.rpc("backfill_contacts_from_won_leads");
      if (error) fail(error);
      return data;
    },
  };
}
