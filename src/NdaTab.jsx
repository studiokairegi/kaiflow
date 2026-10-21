import React, { useEffect, useState } from "react";
import {
  NDA_STATUS, DEFAULT_NDA_BODY, renderNdaBody, ndaSignLink, loadNdaTemplate, saveNdaTemplate,
  listNdaRequests, createNdaRequest, voidNdaRequest,
} from "./ndaApi";
import { downloadNdaPdf } from "./ndaPdf.js";

// "NDA" tab inside TeamMemberEditor. `styles` is App.jsx's styles object.
export default function NdaTab({ member, studioName, styles, onStatusChange }) {
  const [requests, setRequests] = useState([]);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(member.email || "");
  const [days, setDays] = useState(30);
  const [link, setLink] = useState(""); // shown once, right after creation
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftLaw, setDraftLaw] = useState("");
  const [note, setNote] = useState("");

  const refresh = async () => {
    const rows = await listNdaRequests(member.id);
    setRequests(rows);
    onStatusChange?.(rows);
  };

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const [rows, tpl] = await Promise.all([listNdaRequests(member.id), loadNdaTemplate()]);
        if (off) return;
        setRequests(rows); setTemplate(tpl);
        setDraftBody(tpl.body); setDraftLaw(tpl.governingLaw);
      } catch (e) {
        if (!off) setLoadError(e.message || "Couldn't load NDA data. Has the NDA migration been run?");
      }
    })();
    return () => { off = true; };
  }, [member.id]);

  const active = requests.find((r) => r.status === "sent" || r.status === "viewed");
  const signed = requests.find((r) => r.status === "signed");
  const latest = signed || active || requests[0];

  const send = async () => {
    setBusy(true); setNote(""); setLink("");
    try {
      const body = renderNdaBody(template.body, {
        studioName, freelancerName: member.name, governingLaw: template.governingLaw,
      });
      const res = await createNdaRequest({
        teamMemberId: member.id, title: "Non-Disclosure Agreement", body, signerName: member.name,
        signerEmail: email.trim(), studioName, expiresDays: Number(days),
      });
      setLink(ndaSignLink(res.token));
      await refresh();
    } catch (e) { setNote(e.message || "Couldn't create the signing link."); }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch (e) { setNote("Copy failed. Select the link and copy it manually."); }
  };

  const mailto = link
    ? `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(`${studioName}: please sign your NDA`)}&body=${encodeURIComponent(
        `Hi ${member.name.split(" ")[0] || ""},\n\nBefore we start, please review and sign the NDA here:\n${link}\n\nThe link expires in ${days} days.\n\nThanks,\n${studioName}`)}`
    : "";

  const voidIt = async (id) => {
    try { await voidNdaRequest(id); setLink(""); await refresh(); } catch (e) { setNote(e.message); }
  };

  const saveTpl = async () => {
    try {
      await saveNdaTemplate({ body: draftBody, governingLaw: draftLaw });
      setTemplate({ ...template, body: draftBody, governingLaw: draftLaw });
      setEditing(false); setNote("Template saved. It applies to NDAs you send from now on.");
    } catch (e) { setNote(e.message || "Couldn't save the template."); }
  };

  const pill = (status) => {
    const s = NDA_STATUS[status];
    return <span style={{ ...styles.invoiceStatusTag, color: s.color, borderColor: s.color }}>{s.label}</span>;
  };

  if (member.memberType !== "freelancer") {
    return <p style={styles.fieldHint}>NDAs are for freelancers. Change the member type on the Freelancer tab to send one.</p>;
  }
  if (loadError) return <p style={{ ...styles.fieldHint, color: "#E5646B" }}>{loadError}</p>;
  if (!template) return <p style={styles.fieldHint}>Loading...</p>;

  return (
    <>
      <div style={styles.fieldDivider}>NDA</div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        {latest ? pill(latest.status) : <span style={styles.fieldHint}>Not requested yet</span>}
        {signed && <span style={styles.fieldHint}>Signed {new Date(signed.signed_at).toLocaleDateString()}</span>}
      </div>

      {signed && (
        <button type="button" style={styles.tabButton} onClick={() => downloadNdaPdf(signed)}>
          Download signed PDF
        </button>
      )}

      {!signed && !active && (
        <>
          <div style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>Send to</label>
              <input style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="freelancer@example.com" />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Link valid for</label>
              <select style={styles.input} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value={7}>7 days</option><option value={14}>14 days</option>
                <option value={30}>30 days</option><option value={90}>90 days</option>
              </select>
            </div>
          </div>
          <button type="button" style={styles.saveButton} disabled={busy} onClick={send}>
            {busy ? "Creating..." : "Create signing link"}
          </button>
        </>
      )}

      {active && !link && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={styles.fieldHint}>Sent {new Date(active.created_at).toLocaleDateString()}, expires {new Date(active.expires_at).toLocaleDateString()}.</span>
          <button type="button" style={styles.tabButton} disabled={busy} onClick={send}>Send a new link</button>
          <button type="button" style={styles.tabButton} onClick={() => voidIt(active.id)}>Void</button>
        </div>
      )}

      {link && (
        <div style={{ marginTop: 12 }}>
          <label style={styles.label}>Signing link</label>
          <input style={styles.input} readOnly value={link} onFocus={(e) => e.target.select()} />
          <p style={styles.fieldHint}>
            Shown once. If you lose it, send a new link (the old one is voided).
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={styles.saveButton} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            {email.trim() && <a href={mailto} style={{ ...styles.tabButton, textDecoration: "none" }}>Open in email</a>}
          </div>
        </div>
      )}

      {note && <p style={styles.fieldHint}>{note}</p>}

      {requests.length > 0 && (
        <>
          <div style={styles.fieldDivider}>History</div>
          {requests.map((r) => (
            <div key={r.id} style={{ ...styles.invoiceAmountsRow, marginBottom: 4 }}>
              <span style={styles.fieldHint}>
                {new Date(r.created_at).toLocaleDateString()} &middot; {NDA_STATUS[r.status]?.label}
                {r.signed_at ? ` ${new Date(r.signed_at).toLocaleString()}` : ""}
                {r.status === "declined" && r.decline_reason ? ` - "${r.decline_reason}"` : ""}
              </span>
              {r.status === "signed" && (
                <button type="button" style={styles.tabButton} onClick={() => downloadNdaPdf(r)}>PDF</button>
              )}
            </div>
          ))}
        </>
      )}

      <div style={styles.fieldDivider}>NDA template</div>
      {!editing ? (
        <button type="button" style={styles.tabButton} onClick={() => setEditing(true)}>Edit template</button>
      ) : (
        <>
          <div style={styles.field}>
            <label style={styles.label}>Governing law</label>
            <input style={styles.input} value={draftLaw} onChange={(e) => setDraftLaw(e.target.value)} placeholder="e.g. Kenya" />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Text</label>
            <textarea style={{ ...styles.textarea, minHeight: 260 }} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
            <p style={styles.fieldHint}>
              Fields filled in per freelancer: {"{{studio_name}}"}, {"{{freelancer_name}}"}, {"{{effective_date}}"}, {"{{governing_law}}"}.
              Have a lawyer review this text before you rely on it.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={styles.saveButton} onClick={saveTpl}>Save template</button>
            <button type="button" style={styles.tabButton} onClick={() => setDraftBody(DEFAULT_NDA_BODY)}>Reset to default</button>
            <button type="button" style={styles.cancelButton} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      )}
    </>
  );
}
