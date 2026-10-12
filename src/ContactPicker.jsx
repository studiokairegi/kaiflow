import React, { useEffect, useMemo, useRef, useState } from "react";
import { contactsApi } from "./contactsInstance.js";
import {
  filterContacts,
  contactSubtitle,
  planInlineCreate,
  validateContactInput,
  newRequestKey,
  MATCH_REASON_TEXT,
  RELATIONSHIP_LABELS,
} from "./contacts.js";

// Searchable client selector used by the project form. It stores the contact's
// stable id (value.contactId) and also reports the contact's name so the
// project's legacy `client` text keeps working everywhere it's already used.
//
// If contacts can't be loaded (migration not applied yet, network error) it
// degrades to the original plain text field, so project creation still works.

const C = { ink: "#14191c", inkSoft: "#1c2327", paper: "#EDEAE3", teal: "#2FBFA6", border: "#2a3338", muted: "#8b9a98", red: "#FF4D4D", amber: "#F2A65A" };
const field = { width: "100%", boxSizing: "border-box", background: C.ink, color: C.paper, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", fontSize: 13.5, fontFamily: "inherit" };
const small = (color, disabled) => ({ padding: "7px 12px", borderRadius: 8, border: `1px solid ${disabled ? C.border : color}`, background: disabled ? "transparent" : `${color}22`, color: disabled ? C.muted : color, fontSize: 12.5, cursor: disabled ? "not-allowed" : "pointer" });

export default function ContactPicker({ value, onChange, disabled = false, label = "Client", inputId = "contact-picker" }) {
  const [contacts, setContacts] = useState(null); // null = not loaded
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState("search"); // 'search' | 'create'
  const [form, setForm] = useState({ name: "", email: "", company: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [matches, setMatches] = useState(null); // duplicate look-alikes awaiting a decision
  const [busy, setBusy] = useState(false);
  const requestKeyRef = useRef(newRequestKey());
  const busyRef = useRef(false);
  const wrapRef = useRef(null);

  const selectedId = value?.contactId || null;
  const selected = useMemo(() => (contacts || []).find((c) => c.id === selectedId) || null, [contacts, selectedId]);

  const load = async () => {
    try {
      setContacts(await contactsApi.list());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  };

  // Load on mount (so a linked project shows the contact's details) and again each
  // time the list opens, so a contact created moments ago in another form shows up.
  useEffect(() => { load(); }, []);
  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Fallback: contacts unavailable -> original free-text client field.
  if (loadError && contacts === null) {
    return (
      <div>
        <label htmlFor={inputId} style={{ display: "block", fontSize: 12, color: C.muted, marginBottom: 4 }}>{label}</label>
        <input id={inputId} style={field} value={value?.name || ""} disabled={disabled}
          onChange={(e) => onChange({ contactId: null, name: e.target.value })} placeholder="e.g. Vicente Carro" />
        <p style={{ fontSize: 11.5, color: C.muted, margin: "4px 0 0" }}>Saved contacts are unavailable right now, so this is stored as plain text.</p>
      </div>
    );
  }

  const results = filterContacts(contacts || [], query).slice(0, 8);
  const rowCount = results.length + 1; // + "Add new contact"

  const choose = (c) => {
    onChange({ contactId: c.id, name: c.name });
    setOpen(false);
    setQuery("");
    setMode("search");
    setMatches(null);
  };

  const startCreate = () => {
    setForm({ name: query.trim(), email: "", company: "" });
    setErrors({});
    setFormError("");
    setMatches(null);
    setMode("create");
  };

  const submitCreate = async (confirmedCreateAnyway = false) => {
    if (busyRef.current) return; // blocks double-clicks and repeated Enter presses
    const v = validateContactInput(form);
    if (!v.ok) { setErrors(v.errors); return; }
    setErrors({});
    setFormError("");
    busyRef.current = true;
    setBusy(true);
    try {
      const found = await contactsApi.findMatches(v.value);
      const plan = planInlineCreate({ matches: found, confirmedCreateAnyway });
      if (plan.action === "use_existing") {
        const existing = (await contactsApi.get(plan.existing.id)) || { id: plan.existing.id, name: plan.existing.name };
        await load();
        choose(existing);
      } else if (plan.action === "confirm") {
        setMatches(plan.matches);
      } else {
        // The same key is reused for retries of THIS form, so a repeated submit returns the first row.
        const { contact } = await contactsApi.create(v.value, { relationship: "client", requestKey: requestKeyRef.current });
        await load();
        requestKeyRef.current = newRequestKey();
        choose(contact);
      }
    } catch (e) {
      setFormError(e.message);
    }
    busyRef.current = false;
    setBusy(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rowCount - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Escape") { setOpen(false); }
    else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (active < results.length) choose(results[active]);
      else startCreate();
    }
  };

  const legacyOnly = !selectedId && value?.name;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <label htmlFor={inputId} style={{ display: "block", fontSize: 12, color: C.muted, marginBottom: 4 }}>{label}</label>

      {selectedId && mode === "search" && !open ? (
        <div style={{ ...field, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span>
            {value.name}
            {selected && <span style={{ color: C.muted, fontSize: 12 }}> · {contactSubtitle(selected) || RELATIONSHIP_LABELS[selected.relationship]}</span>}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={disabled} style={small(C.teal, disabled)} onClick={() => setOpen(true)}>Change</button>
            <button type="button" disabled={disabled} style={small(C.muted, disabled)} aria-label="Clear client" onClick={() => onChange({ contactId: null, name: "" })}>✕</button>
          </span>
        </div>
      ) : (
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${inputId}-list`}
          aria-autocomplete="list"
          autoComplete="off"
          style={field}
          disabled={disabled}
          value={query}
          placeholder={legacyOnly ? `Current: ${value.name} (not linked to a saved contact)` : "Search contacts by name, company or email"}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
        />
      )}

      {legacyOnly && !open && (
        <p style={{ fontSize: 11.5, color: C.amber, margin: "4px 0 0" }}>
          “{value.name}” is saved as plain text. Pick or add a contact above to link this project properly.
        </p>
      )}

      {open && mode === "search" && (
        <ul id={`${inputId}-list`} role="listbox" style={{ listStyle: "none", margin: "4px 0 0", padding: 4, position: "absolute", zIndex: 20, left: 0, right: 0, background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 10, maxHeight: 280, overflowY: "auto" }}>
          {contacts === null && <li style={{ padding: 10, fontSize: 13, color: C.muted }}>Loading contacts…</li>}
          {contacts !== null && results.length === 0 && (
            <li style={{ padding: 10, fontSize: 13, color: C.muted }}>{query ? "No saved contacts match." : "No saved contacts yet."}</li>
          )}
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(c); }}
              style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: i === active ? "rgba(47,191,166,0.12)" : "transparent" }}>
              <div style={{ fontSize: 13.5 }}>
                {c.name} <span style={{ fontSize: 11, color: c.relationship === "client" ? C.teal : C.muted }}>[{RELATIONSHIP_LABELS[c.relationship]}]</span>
              </div>
              {contactSubtitle(c) && <div style={{ fontSize: 12, color: C.muted }}>{contactSubtitle(c)}</div>}
            </li>
          ))}
          <li role="option" aria-selected={active === results.length} onMouseEnter={() => setActive(results.length)}
            onMouseDown={(e) => { e.preventDefault(); startCreate(); }}
            style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", color: C.teal, fontSize: 13.5, background: active === results.length ? "rgba(47,191,166,0.12)" : "transparent" }}>
            + Add new contact{query.trim() ? ` “${query.trim()}”` : ""}
          </li>
        </ul>
      )}

      {mode === "create" && (
        <div role="group" aria-label="New contact" style={{ marginTop: 6, padding: 12, background: C.inkSoft, border: `1px solid ${C.teal}`, borderRadius: 10 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}><strong>New contact</strong> <span style={{ color: C.muted }}>(saved to Contacts for future projects)</span></p>
          {[["name", "Name *"], ["email", "Email"], ["company", "Company / studio"]].map(([k, l]) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <label htmlFor={`${inputId}-${k}`} style={{ fontSize: 12, color: C.muted }}>{l}</label>
              <input id={`${inputId}-${k}`} style={{ ...field, borderColor: errors[k] ? C.red : C.border }} value={form[k]} autoFocus={k === "name"}
                onChange={(e) => { setForm({ ...form, [k]: e.target.value }); setMatches(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitCreate(false); } }} />
              {errors[k] && <p role="alert" style={{ color: C.red, fontSize: 12, margin: "2px 0 0" }}>{errors[k]}</p>}
            </div>
          ))}

          {matches && (
            <div role="alert" style={{ margin: "8px 0", padding: 8, border: `1px solid ${C.amber}`, borderRadius: 8 }}>
              <p style={{ margin: "0 0 6px", fontSize: 12.5, color: C.amber }}>Possible duplicates. Use an existing contact, or confirm this is someone new.</p>
              {matches.map((m) => (
                <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 0" }}>
                  <span>{m.name}{m.company ? ` · ${m.company}` : ""}{m.email ? ` · ${m.email}` : ""} <span style={{ color: C.muted }}>({MATCH_REASON_TEXT[m.reason]})</span></span>
                  <button type="button" style={small(C.teal, false)} onClick={() => choose({ id: m.id, name: m.name })}>Use this one</button>
                </div>
              ))}
            </div>
          )}

          {formError && <p role="alert" style={{ color: C.red, fontSize: 12.5, margin: "4px 0" }}>{formError}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            {matches ? (
              <button type="button" disabled={busy} style={small(C.amber, busy)} onClick={() => submitCreate(true)}>{busy ? "Saving…" : "Create anyway"}</button>
            ) : (
              <button type="button" disabled={busy} style={small(C.teal, busy)} onClick={() => submitCreate(false)}>{busy ? "Saving…" : "Save & select"}</button>
            )}
            <button type="button" disabled={busy} style={small(C.muted, busy)} onClick={() => { setMode("search"); setMatches(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
