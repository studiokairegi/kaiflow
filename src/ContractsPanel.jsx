import React, { useEffect, useMemo, useState } from "react";
import {
  CONTRACT_STATUS, DEFAULT_CONTRACT_BODY, DEFAULT_REVISION_ROUNDS, DEFAULT_MILESTONE_PERCENTS, MILESTONE_LABELS,
  buildContractTerms, renderContractBody, compareTerms, validateMilestonePercents,
  formatContractMoney, formatContractDate, contractSignLink,
} from "./contracts.js";
import {
  loadContractTemplate, saveContractTemplate, listContracts, createContract, voidContract, downloadContractPdf,
} from "./contractsApi.js";

// "Contracts" section of a CLIENT in CRM > Contacts. Each contract belongs to one project:
// its scope, deliverables, fee, deadline, production stages and payment schedule are read
// from that project when the link is created and frozen on the contract. Later project
// changes show up here as a "project changed since sent" note.
//
// Props
//   contact   the client (contacts.js shape)
//   projects  App.jsx projects (id, name, contactId, budget, deadline, notes, ...)
//   cards     App.jsx shots, used for deliverables and auto-budget
//   studio    { name, legalName, paymentTermsDays, milestoneDefaults, currency }
//   ui        { C, card, field, btn } style helpers from ContactsPage

const pillStyle = (color) => ({ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${color}`, color, whiteSpace: "nowrap" });
const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : "");

export default function ContractsPanel({ contact, projects = [], cards = [], studio = {}, ui }) {
  const { C, card, field, btn } = ui;
  const studioName = studio.legalName || studio.name || "Studio";
  const defaultPercents = (studio.milestoneDefaults && studio.milestoneDefaults.length === 3 ? studio.milestoneDefaults : DEFAULT_MILESTONE_PERCENTS).map(String);

  const [contracts, setContracts] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [signerName, setSignerName] = useState(contact.name || "");
  const [signerEmail, setSignerEmail] = useState(contact.email || "");
  const [days, setDays] = useState(30);
  const [percents, setPercents] = useState(defaultPercents);
  const [signatory, setSignatory] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [linkedEmail, setLinkedEmail] = useState("");
  const [linkedProject, setLinkedProject] = useState("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const [linkedIds, setLinkedIds] = useState([]); // projects the server linked to this client this session
  const [editingTpl, setEditingTpl] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftLaw, setDraftLaw] = useState("");
  const [draftRounds, setDraftRounds] = useState(DEFAULT_REVISION_ROUNDS);

  const refresh = async () => setContracts(await listContracts(contact.id));

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const [rows, tpl] = await Promise.all([listContracts(contact.id), loadContractTemplate()]);
        if (off) return;
        setContracts(rows); setTemplate(tpl);
        setDraftBody(tpl.body); setDraftLaw(tpl.governingLaw); setDraftRounds(tpl.revisionRounds);
      } catch (e) {
        if (!off) setLoadError(e.message || "Couldn't load contracts. Has the client contracts migration been run?");
      }
    })();
    return () => { off = true; };
  }, [contact.id]);

  // Projects that can take a contract: already this client's, or not linked to anyone yet.
  const mine = useMemo(() => projects.filter((p) => !p.archived && (p.contactId === contact.id || linkedIds.includes(p.id))), [projects, contact.id, linkedIds]);
  const loose = useMemo(() => projects.filter((p) => !p.archived && !p.contactId && !linkedIds.includes(p.id)), [projects, linkedIds]);
  const selected = [...mine, ...loose].find((p) => p.id === projectId) || null;

  const pctCheck = validateMilestonePercents(percents);
  const terms = useMemo(
    () => (selected && pctCheck.ok ? buildContractTerms({ project: selected, cards, contact, studio, milestonePercents: pctCheck.value }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, cards, contact, studio, percents]
  );
  const bodyPreview = terms && template
    ? renderContractBody(template.body, terms, { studioName, studioSignatory: signatory.trim(), governingLaw: template.governingLaw, revisionRounds: template.revisionRounds, signerName: signerName.trim() })
    : "";

  const problem = !selected ? "Choose the project this contract is for."
    : !pctCheck.ok ? pctCheck.error
    : terms && terms.budget_total <= 0 ? "This project has no budget yet. Set one on the project, then come back."
    : signerName.trim().length < 2 ? "Enter the name of the person who will sign."
    : "";
  const openForSelected = (contracts || []).find((c) => c.project_id === projectId && (c.status === "sent" || c.status === "viewed"));

  // What changed on each project since its contract was sent.
  const drift = useMemo(() => {
    const out = {};
    (contracts || []).forEach((c) => {
      if (!["sent", "viewed", "signed"].includes(c.status) || !c.project_id || !c.terms) return;
      const p = projects.find((x) => x.id === c.project_id);
      if (!p) return;
      const current = buildContractTerms({ project: p, cards, contact, studio, milestonePercents: (c.terms.milestones || []).map((m) => m.percent) });
      const diffs = compareTerms(c.terms, current);
      if (diffs.length) out[c.id] = diffs;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, projects, cards, contact, studio]);

  const startCreate = (forProjectId, fromContract) => {
    setCreating(true); setLink(""); setNote("");
    setProjectId(forProjectId || "");
    setPercents(fromContract?.terms?.milestones?.length === 3 ? fromContract.terms.milestones.map((m) => String(m.percent)) : defaultPercents);
    if (fromContract?.studio_signatory) setSignatory(fromContract.studio_signatory);
  };

  const send = async () => {
    if (problem || busy) return;
    setBusy(true); setNote(""); setLink("");
    try {
      const res = await createContract({
        contactId: contact.id, projectId: selected.id, title: `Services Agreement: ${selected.name}`,
        body: bodyPreview, terms, signerName: signerName.trim(), signerEmail: signerEmail.trim(),
        studioName, studioSignatory: signatory.trim(), expiresDays: Number(days),
      });
      if (!mine.some((p) => p.id === selected.id)) setLinkedIds((ids) => [...ids, selected.id]);
      setLink(contractSignLink(res.token));
      setLinkedEmail(signerEmail.trim()); setLinkedProject(selected.name);
      await refresh();
      setCreating(false);
    } catch (e) { setNote(e.message || "Couldn't create the signing link."); }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch (e) { setNote("Copy failed. Select the link and copy it manually."); }
  };

  const mailto = link
    ? `mailto:${encodeURIComponent(linkedEmail)}?subject=${encodeURIComponent(`${studioName}: please sign the agreement for ${linkedProject}`)}&body=${encodeURIComponent(
        `Hi ${(contact.name || "").split(" ")[0]},\n\nPlease review and sign the agreement for ${linkedProject} here:\n${link}\n\nThe link expires in ${days} days.\n\nThanks,\n${studioName}`)}`
    : "";

  const voidIt = async (id) => {
    try { await voidContract(id); setLink(""); await refresh(); } catch (e) { setNote(e.message); }
  };

  const saveTpl = async () => {
    try {
      await saveContractTemplate({ body: draftBody, governingLaw: draftLaw, revisionRounds: draftRounds });
      setTemplate({ ...template, body: draftBody, governingLaw: draftLaw, revisionRounds: Number(draftRounds) });
      setEditingTpl(false); setNote("Template saved. It applies to contracts you create from now on.");
    } catch (e) { setNote(e.message || "Couldn't save the template."); }
  };

  const heading = { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.muted, margin: 0 };
  const label = { fontSize: 12, color: C.muted, display: "block", marginBottom: 2 };
  const hint = { fontSize: 12.5, color: C.muted, margin: "4px 0 0" };

  if (loadError) return <p role="alert" style={{ ...hint, color: C.red }}>{loadError}</p>;
  if (!template || contracts === null) return <p style={hint}>Loading contracts…</p>;

  const projectName = (c) => (c.terms && c.terms.project_name) || "Deleted project";

  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <p style={heading}>Contracts</p>
        {!creating && <button type="button" style={btn(C.teal, false)} onClick={() => startCreate("")}>+ New contract</button>}
      </div>

      {contracts.length === 0 && !creating && !link && <p style={hint}>No contracts yet. Create one from a project to send this client a signing link.</p>}

      {contracts.map((c) => {
        const s = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.sent;
        const t = c.terms || {};
        const open = c.status === "sent" || c.status === "viewed";
        return (
          <div key={c.id} style={{ ...card, background: C.ink, padding: 10, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{projectName(c)}</strong>
              <span style={pillStyle(s.color)}>{s.label}</span>
            </div>
            <p style={hint}>
              {t.budget_total != null ? formatContractMoney(t.currency, t.budget_total) : ""}
              {t.deadline ? ` · due ${formatContractDate(t.deadline)}` : ""}
              {` · sent ${when(c.created_at)}`}
              {c.signed_at ? ` · signed ${when(c.signed_at)}${c.typed_name ? ` by ${c.typed_name}` : ""}` : ""}
              {open && c.expires_at ? ` · expires ${when(c.expires_at)}` : ""}
              {c.status === "declined" && c.decline_reason ? ` · "${c.decline_reason}"` : ""}
            </p>
            {drift[c.id] && (
              <p role="status" style={{ ...hint, color: C.amber }}>
                {c.status === "signed" ? "Project changed since signing: " : "Project changed since this was sent: "}
                {drift[c.id].join("; ")}.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {c.status === "signed" && <button type="button" style={btn(C.teal, false)} onClick={() => downloadContractPdf(c)}>Download signed PDF</button>}
              {open && <button type="button" style={btn(C.muted, false)} onClick={() => voidIt(c.id)}>Void</button>}
              {c.project_id && (drift[c.id] || open || c.status === "declined" || c.status === "expired") && (
                <button type="button" style={btn(C.amber, false)} onClick={() => startCreate(c.project_id, c)}>
                  {drift[c.id] ? "Send updated contract" : "Send a new link"}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {link && (
        <div style={{ ...card, marginTop: 10, borderColor: C.teal }}>
          <label style={label} htmlFor="contract-link">Signing link for {linkedProject}</label>
          <input id="contract-link" style={field} readOnly value={link} onFocus={(e) => e.target.select()} />
          <p style={hint}>Shown once. If you lose it, send a new link (the old one is voided).</p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" style={btn(C.teal, false)} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            {linkedEmail && <a href={mailto} style={{ ...btn(C.muted, false), textDecoration: "none", display: "inline-block" }}>Open in email</a>}
          </div>
        </div>
      )}

      {creating && (
        <div style={{ ...card, marginTop: 10 }} role="form" aria-label="New contract">
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>New contract</h4>

          <label style={label} htmlFor="ct-project">Project</label>
          <select id="ct-project" style={field} value={projectId} onChange={(e) => { setProjectId(e.target.value); setShowPreview(false); }}>
            <option value="">Choose a project…</option>
            {mine.length > 0 && <optgroup label="This client's projects">{mine.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
            {loose.length > 0 && <optgroup label="Not linked to a client yet (will be linked)">{loose.map((p) => <option key={p.id} value={p.id}>{p.name}{p.client ? ` · ${p.client}` : ""}</option>)}</optgroup>}
          </select>
          {mine.length === 0 && loose.length === 0 && <p style={hint}>No open projects to attach. Create the project first, then link it to this client.</p>}
          {openForSelected && <p style={{ ...hint, color: C.amber }}>This project already has an open contract. Creating a new link voids it.</p>}

          {selected && terms && (
            <div style={{ margin: "10px 0", padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13 }}>
              <p style={{ ...heading, marginBottom: 6 }}>Pulled from the project</p>
              <div><span style={{ color: C.muted }}>Fee: </span>{terms.budget_total > 0 ? formatContractMoney(terms.currency, terms.budget_total) : <span style={{ color: C.red }}>not set</span>}{terms.budget_mode === "auto" ? <span style={{ color: C.muted }}> (sum of shot rates)</span> : null}</div>
              <div><span style={{ color: C.muted }}>Deadline: </span>{formatContractDate(terms.deadline) || <span style={{ color: C.amber }}>not set (contract will say "to be agreed")</span>}</div>
              <div><span style={{ color: C.muted }}>Deliverables: </span>{terms.deliverables.length ? `${terms.deliverables.length} shot(s)` : <span style={{ color: C.amber }}>none yet</span>}</div>
              <div><span style={{ color: C.muted }}>Scope notes: </span>{terms.scope ? (terms.scope.length > 90 ? `${terms.scope.slice(0, 90)}…` : terms.scope) : <span style={{ color: C.amber }}>empty</span>}</div>
              <div><span style={{ color: C.muted }}>Stages: </span>{terms.stages.length ? terms.stages.join(" → ") : "to be agreed"}</div>
              <p style={hint}>Change these on the project itself. The contract uses what is there when you click Create.</p>
            </div>
          )}

          <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
            <legend style={label}>Payment schedule (% of fee)</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {MILESTONE_LABELS.map((l, i) => (
                <div key={l} style={{ flex: "1 1 90px" }}>
                  <label style={label} htmlFor={`ct-pct-${i}`}>{l}</label>
                  <input id={`ct-pct-${i}`} style={field} inputMode="decimal" value={percents[i]}
                    onChange={(e) => setPercents(percents.map((v, j) => (j === i ? e.target.value : v)))} />
                </div>
              ))}
            </div>
            {!pctCheck.ok && <p role="alert" style={{ ...hint, color: C.red }}>{pctCheck.error}</p>}
          </fieldset>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "2 1 180px" }}>
              <label style={label} htmlFor="ct-name">Signer's full name</label>
              <input id="ct-name" style={field} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
            </div>
            <div style={{ flex: "2 1 180px" }}>
              <label style={label} htmlFor="ct-email">Send to</label>
              <input id="ct-email" style={field} value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} placeholder="client@example.com" />
            </div>
            <div style={{ flex: "1 1 110px" }}>
              <label style={label} htmlFor="ct-days">Link valid for</label>
              <select id="ct-days" style={field} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={label} htmlFor="ct-signatory">Signed for the studio by (optional)</label>
            <input id="ct-signatory" style={field} value={signatory} onChange={(e) => setSignatory(e.target.value)} placeholder={studioName} />
          </div>

          {terms && (
            <div style={{ marginTop: 10 }}>
              <button type="button" style={btn(C.muted, false)} onClick={() => setShowPreview(!showPreview)}>{showPreview ? "Hide contract text" : "Preview contract text"}</button>
              {showPreview && (
                <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12.5, background: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, maxHeight: 320, overflow: "auto", marginTop: 8 }}>{bodyPreview}</pre>
              )}
            </div>
          )}

          {problem && selected && <p role="alert" style={{ ...hint, color: C.amber }}>{problem}</p>}
          {note && <p role="alert" style={{ ...hint, color: C.red }}>{note}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" style={btn(C.teal, !!problem || busy)} disabled={!!problem || busy} onClick={send}>{busy ? "Creating…" : "Create signing link"}</button>
            <button type="button" style={btn(C.muted, busy)} disabled={busy} onClick={() => { setCreating(false); setNote(""); }}>Cancel</button>
          </div>
        </div>
      )}

      {!creating && note && <p role="status" style={hint}>{note}</p>}

      <div style={{ marginTop: 12 }}>
        {!editingTpl ? (
          <button type="button" style={btn(C.muted, false)} onClick={() => setEditingTpl(true)}>Edit contract template</button>
        ) : (
          <div style={card}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "2 1 180px" }}>
                <label style={label} htmlFor="tpl-law">Governing law</label>
                <input id="tpl-law" style={field} value={draftLaw} onChange={(e) => setDraftLaw(e.target.value)} placeholder="e.g. Kenya" />
              </div>
              <div style={{ flex: "1 1 110px" }}>
                <label style={label} htmlFor="tpl-rounds">Revision rounds</label>
                <input id="tpl-rounds" type="number" min={0} max={20} style={field} value={draftRounds} onChange={(e) => setDraftRounds(e.target.value)} />
              </div>
            </div>
            <label style={{ ...label, marginTop: 8 }} htmlFor="tpl-body">Text</label>
            <textarea id="tpl-body" rows={14} style={field} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
            <p style={hint}>
              Filled in from the project and client: {["studio_name", "client_company", "client_name", "client_address", "project_name", "scope", "deliverables", "shot_count", "stages", "fee", "payment_schedule", "payment_terms", "deadline", "revision_rounds", "governing_law", "effective_date", "studio_signatory"].map((k) => `{{${k}}}`).join(", ")}.
              Have a lawyer review this text before you rely on it.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" style={btn(C.teal, false)} onClick={saveTpl}>Save template</button>
              <button type="button" style={btn(C.muted, false)} onClick={() => setDraftBody(DEFAULT_CONTRACT_BODY)}>Reset to default</button>
              <button type="button" style={btn(C.muted, false)} onClick={() => setEditingTpl(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
