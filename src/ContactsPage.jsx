import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contactsApi } from "./contactsInstance.js";
import {
  filterContacts,
  contactSubtitle,
  validateContactInput,
  newRequestKey,
  MATCH_REASON_TEXT,
  RELATIONSHIP_LABELS,
  planInlineCreate,
} from "./contacts.js";

// CRM > Contacts. List + search + client/prospect filter, a detail pane with
// linked deals and projects, and create/edit. Uses the same contacts API,
// validation and duplicate rules as the New Project selector.

const C = { ink: "#14191c", inkSoft: "#1c2327", paper: "#EDEAE3", teal: "#2FBFA6", border: "#2a3338", muted: "#8b9a98", red: "#FF4D4D", green: "#3DDC84", amber: "#F2A65A" };
const card = { background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 };
const field = { width: "100%", boxSizing: "border-box", background: C.ink, color: C.paper, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", fontSize: 13.5, fontFamily: "inherit" };
const btn = (color, disabled) => ({ padding: "8px 14px", borderRadius: 10, border: `1px solid ${disabled ? C.border : color}`, background: disabled ? "transparent" : `${color}22`, color: disabled ? C.muted : color, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 });

const EMPTY = { name: "", email: "", phone: "", company: "", roleTitle: "", website: "", notes: "" };

function ContactForm({ initial, isNew, onSaved, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial });
  const [relationship, setRelationship] = useState(initial?.relationship || "prospect");
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [matches, setMatches] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const keyRef = useRef(newRequestKey());
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setMatches(null); };

  const submit = async (confirmedCreateAnyway = false) => {
    if (busyRef.current) return;
    const v = validateContactInput(form);
    if (!v.ok) { setErrors(v.errors); return; }
    setErrors({}); setError("");
    busyRef.current = true; setBusy(true);
    try {
      if (isNew) {
        const found = await contactsApi.findMatches(v.value);
        const plan = planInlineCreate({ matches: found, confirmedCreateAnyway });
        if (plan.action === "use_existing") {
          setError(`A contact with that email already exists (${plan.existing.name}).`);
          setMatches(found);
        } else if (plan.action === "confirm") {
          setMatches(plan.matches);
        } else {
          const { contact } = await contactsApi.create(v.value, { relationship, requestKey: keyRef.current });
          onSaved(contact);
        }
      } else {
        const updated = await contactsApi.update(initial.id, v.value);
        if (updated.relationship !== relationship) onSaved(await contactsApi.setRelationship(initial.id, relationship));
        else onSaved(updated);
      }
    } catch (e) {
      setError(e.message);
      if (e.validation) setErrors(e.validation);
    }
    busyRef.current = false; setBusy(false);
  };

  const rows = [["name", "Name *"], ["email", "Email"], ["phone", "Phone"], ["company", "Company / studio"], ["roleTitle", "Role / title"], ["website", "Website"]];
  return (
    <div style={card} role="form" aria-label={isNew ? "New contact" : "Edit contact"}>
      <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>{isNew ? "New contact" : "Edit contact"}</h3>
      {rows.map(([k, l]) => (
        <div key={k} style={{ marginBottom: 8 }}>
          <label htmlFor={`cf-${k}`} style={{ fontSize: 12, color: C.muted }}>{l}</label>
          <input id={`cf-${k}`} style={{ ...field, borderColor: errors[k] ? C.red : C.border }} value={form[k]} onChange={set(k)} autoFocus={k === "name"} />
          {errors[k] && <p role="alert" style={{ color: C.red, fontSize: 12, margin: "2px 0 0" }}>{errors[k]}</p>}
        </div>
      ))}
      <label htmlFor="cf-notes" style={{ fontSize: 12, color: C.muted }}>Notes</label>
      <textarea id="cf-notes" rows={3} style={{ ...field, marginBottom: 8 }} value={form.notes} onChange={set("notes")} />
      <fieldset style={{ border: "none", padding: 0, margin: "0 0 8px" }}>
        <legend style={{ fontSize: 12, color: C.muted }}>Relationship</legend>
        {Object.entries(RELATIONSHIP_LABELS).map(([id, label]) => (
          <label key={id} style={{ marginRight: 14, fontSize: 13 }}>
            <input type="radio" name="rel" checked={relationship === id} onChange={() => setRelationship(id)} /> {label}
          </label>
        ))}
      </fieldset>
      {matches && (
        <div role="alert" style={{ margin: "8px 0", padding: 8, border: `1px solid ${C.amber}`, borderRadius: 8, fontSize: 12.5 }}>
          <p style={{ margin: "0 0 4px", color: C.amber }}>Possible duplicates already in your contacts:</p>
          {matches.map((m) => (<div key={m.id}>{m.name}{m.company ? ` · ${m.company}` : ""}{m.email ? ` · ${m.email}` : ""} <span style={{ color: C.muted }}>({MATCH_REASON_TEXT[m.reason]})</span></div>))}
        </div>
      )}
      {error && <p role="alert" style={{ color: C.red, fontSize: 13, margin: "6px 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {matches && !matches.some((m) => m.reason === "same_email") ? (
          <button type="button" style={btn(C.amber, busy)} disabled={busy} onClick={() => submit(true)}>{busy ? "Saving…" : "Create anyway"}</button>
        ) : (
          <button type="button" style={btn(C.teal, busy)} disabled={busy} onClick={() => submit(false)}>{busy ? "Saving…" : "Save contact"}</button>
        )}
        <button type="button" style={btn(C.muted, busy)} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ContactDetail({ contact, stageLabels, onEdit, onChanged }) {
  const [links, setLinks] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLinks(null);
    contactsApi.links(contact.id).then((l) => alive && setLinks(l)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [contact.id]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { onChanged(await contactsApi.setRelationship(contact.id, contact.relationship === "client" ? "prospect" : "client")); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };

  const rows = [["Email", contact.email], ["Phone", contact.phone], ["Company", contact.company], ["Role", contact.roleTitle], ["Website", contact.website]].filter(([, v]) => v);
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17 }}>{contact.name}</h3>
          <span style={{ fontSize: 12, color: contact.relationship === "client" ? C.green : C.muted }}>
            {contact.relationship === "client" ? "✓ Client" : "○ Prospect"}
            {contact.clientSince ? ` since ${new Date(contact.clientSince).toLocaleDateString()}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={btn(C.teal, false)} onClick={onEdit}>Edit</button>
          <button type="button" style={btn(C.muted, busy)} disabled={busy} onClick={toggle}>{contact.relationship === "client" ? "Mark as prospect" : "Mark as client"}</button>
        </div>
      </div>
      {rows.map(([l, v]) => (<p key={l} style={{ margin: "8px 0 0", fontSize: 13.5 }}><span style={{ color: C.muted }}>{l}: </span>{v}</p>))}
      {contact.notes && <p style={{ whiteSpace: "pre-wrap", fontSize: 13.5, marginTop: 10 }}>{contact.notes}</p>}
      {error && <p role="alert" style={{ color: C.red, fontSize: 13 }}>{error}</p>}

      <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.muted, margin: "0 0 6px" }}>Deals</p>
        {links === null ? <p style={{ fontSize: 13, color: C.muted }}>Loading…</p>
          : links.leads.length === 0 ? <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>No linked deals.</p>
          : links.leads.map((l) => (<div key={l.id} style={{ fontSize: 13.5 }}>{l.name} <span style={{ color: C.muted }}>· {stageLabels[l.stage] || l.stage}</span></div>))}
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.muted, margin: "12px 0 6px" }}>Projects</p>
        {links === null ? null
          : links.projects.length === 0 ? <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>No linked projects.</p>
          : links.projects.map((p) => (<div key={p.id} style={{ fontSize: 13.5 }}>{p.name}{p.archived ? <span style={{ color: C.muted }}> · archived</span> : null}</div>))}
      </div>
    </div>
  );
}

export default function ContactsPage({ stageLabels = {}, onContactsChanged }) {
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // 'view' | 'new' | 'edit'
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try { setContacts(await contactsApi.list()); setError(""); }
    catch (e) { setError(e.message); setContacts((c) => c || []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => filterContacts(contacts || [], query, filter), [contacts, query, filter]);
  const selected = (contacts || []).find((c) => c.id === selectedId) || null;

  const saved = async (contact) => {
    await load();
    setSelectedId(contact.id);
    setMode("view");
    if (onContactsChanged) onContactsChanged();
  };

  const runImport = async () => {
    if (importing) return;
    setImporting(true); setImportMsg("");
    try {
      const r = await contactsApi.backfillFromWonLeads();
      setImportMsg(`Linked ${r.leadsLinked} won deal(s) to contacts and ${r.projectsLinked} project(s).`);
      await load();
      if (onContactsChanged) onContactsChanged();
    } catch (e) { setImportMsg(e.message); }
    setImporting(false);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input aria-label="Search contacts" style={{ ...field, flex: "1 1 220px" }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email or company…" />
        <select aria-label="Filter by relationship" style={{ ...field, width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All contacts</option>
          <option value="client">Clients</option>
          <option value="prospect">Prospects</option>
        </select>
        <button type="button" style={btn(C.teal, false)} onClick={() => { setMode("new"); setSelectedId(null); }}>+ New contact</button>
      </div>

      {error && <p role="alert" style={{ color: C.red, fontSize: 13 }}>{error}</p>}
      {contacts === null && <p style={{ color: C.muted, fontSize: 13.5 }}>Loading contacts…</p>}

      {contacts !== null && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            {contacts.length === 0 && !error ? (
              <div style={card}>
                <p style={{ margin: "0 0 6px", fontSize: 14 }}>No contacts yet.</p>
                <p style={{ margin: "0 0 10px", fontSize: 13, color: C.muted }}>Add one, mark a deal Won (it becomes a client automatically), or import clients from deals you've already won.</p>
                <button type="button" style={btn(C.muted, importing)} disabled={importing} onClick={runImport}>{importing ? "Importing…" : "Import clients from won deals"}</button>
                {importMsg && <p role="status" style={{ fontSize: 12.5, color: C.muted }}>{importMsg}</p>}
              </div>
            ) : visible.length === 0 ? (
              <p style={{ color: C.muted, fontSize: 13.5 }}>No contacts match your search.</p>
            ) : (
              <ul role="listbox" aria-label="Contacts" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {visible.map((c) => (
                  <li key={c.id} role="option" aria-selected={c.id === selectedId} tabIndex={0}
                    onClick={() => { setSelectedId(c.id); setMode("view"); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(c.id); setMode("view"); } }}
                    style={{ ...card, padding: 10, cursor: "pointer", borderColor: c.id === selectedId ? C.teal : C.border }}>
                    <div style={{ fontSize: 14 }}>{c.name} <span style={{ fontSize: 11, color: c.relationship === "client" ? C.green : C.muted }}>{c.relationship === "client" ? "✓ Client" : "○ Prospect"}</span></div>
                    {contactSubtitle(c) && <div style={{ fontSize: 12, color: C.muted }}>{contactSubtitle(c)}</div>}
                  </li>
                ))}
              </ul>
            )}
            {contacts.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <button type="button" style={btn(C.muted, importing)} disabled={importing} onClick={runImport}>{importing ? "Importing…" : "Import clients from won deals"}</button>
                {importMsg && <p role="status" style={{ fontSize: 12.5, color: C.muted }}>{importMsg}</p>}
              </div>
            )}
          </div>

          <div style={{ flex: "2 1 320px", minWidth: 0 }}>
            {mode === "new" ? (
              <ContactForm isNew initial={EMPTY} onSaved={saved} onCancel={() => setMode("view")} />
            ) : mode === "edit" && selected ? (
              <ContactForm initial={selected} onSaved={saved} onCancel={() => setMode("view")} />
            ) : selected ? (
              <ContactDetail contact={selected} stageLabels={stageLabels} onEdit={() => setMode("edit")} onChanged={saved} />
            ) : (
              <p style={{ color: C.muted, fontSize: 13.5 }}>Select a contact to see details.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
