import React, { useMemo, useState } from "react";
import { S, T, Btn, Banner, Field, Pill, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { Input, Select, TextArea, Muted } from "./kit.jsx";

const EVIDENCE_TYPES = [
  ["developer_identity", "Developer / studio identity"], ["project_identity", "Exact game title"], ["contact_email", "Exact contact email"],
  ["anime_style_description", "Official anime/manga style description"], ["anime_visual_screenshot", "Anime-style screenshot (inspect media)"],
  ["anime_visual_artwork", "Anime-style artwork (inspect media)"], ["anime_visual_trailer", "Anime-style trailer (inspect media)"], ["anime_character_art", "Anime character art (inspect media)"],
  ["development_update", "Dated development update"], ["devlog", "Dated devlog"], ["project_announcement", "Dated project announcement"], ["marketing_opportunity", "Dated marketing milestone"],
];

export default function IndieAdminPanel({ prospect, evidence, supabase, onChanged }) {
  const [type, setType] = useState("developer_identity");
  const [url, setUrl] = useState(prospect.website || prospect.project_source_url || "");
  const [snippet, setSnippet] = useState("");
  const [date, setDate] = useState("");
  const [media, setMedia] = useState("");
  const [developer, setDeveloper] = useState(prospect.facts?.verified?.developer_name || prospect.name || "");
  const [developerEvidence, setDeveloperEvidence] = useState("");
  const [projectEvidence, setProjectEvidence] = useState("");
  const [email, setEmail] = useState(prospect.contact_email || "");
  const [contactEvidence, setContactEvidence] = useState("");
  const [role, setRole] = useState("unknown");
  const { busy, error, run } = useBusy();
  const reviewed = useMemo(() => (evidence || []).filter((e) => e.verified && e.source === "admin_review"), [evidence]);
  const idOptions = [["", "Select reviewed evidence"], ...reviewed.map((e) => [e.id, `${e.fact_type} · ${e.id.slice(0, 8)}`])];
  const dated = ["development_update", "devlog", "project_announcement", "marketing_opportunity"].includes(type);
  const visual = type.startsWith("anime_visual_") || type === "anime_character_art";
  const saveEvidence = () => run(async () => {
    if (type === "contact_email") {
      await intelApi.addIndieContactEvidence(supabase, { prospectId: prospect.id, sourceUrl: url.trim(), snippet: snippet.trim() });
    } else {
      await intelApi.addIndieEvidence(supabase, { prospectId: prospect.id, factType: type, sourceUrl: url.trim(), snippet: snippet.trim(), eventDate: dated ? date : null, mediaUrl: visual ? media.trim() : "" });
    }
    setSnippet(""); setDate(""); setMedia(""); await onChanged();
  });
  const verifyIdentity = () => run(async () => {
    await intelApi.verifyIndieIdentity(supabase, { prospectId: prospect.id, developerName: developer.trim(), developerEvidenceId: developerEvidence, projectEvidenceId: projectEvidence, creatorRole: role });
    await onChanged();
  });
  const verifyContact = () => run(async () => {
    await intelApi.verifyIndieContact(supabase, { prospectId: prospect.id, email: email.trim(), evidenceId: contactEvidence });
    await onChanged();
  });
  return <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 10 }}>
    <h3 style={S.h3}>Indie identity, evidence and contact review</h3>
    <Muted>Record facts you personally checked. Identity, project, visual-style and activity evidence must come from the official developer website or approved non-Kickstarter project source. Contact-email evidence may also come from a public professional profile when it explicitly links the exact email to the named developer or authorized team member. Kickstarter pages are not accepted as evidence sources.</Muted>
    {error && <Banner tone="bad">{error}</Banner>}
    <Field label="Evidence type"><Select value={type} onChange={(e) => setType(e.target.value)} options={EVIDENCE_TYPES} /></Field>
    <Field label="Reviewed source URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://official-developer-site/..." /></Field>
    <Field label={type === "contact_email" ? "Exact email, named developer/contact and their role (20–1,800 characters)" : "What the source explicitly says (20–1,800 characters)"}><TextArea value={snippet} onChange={(e) => setSnippet(e.target.value)} rows={3} /></Field>
    {dated && <Field label="Explicit event date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
    {visual && <Field label="Direct media URL (inspect before saving)"><Input value={media} onChange={(e) => setMedia(e.target.value)} placeholder="https://.../screenshot.png" /></Field>}
    <div><Btn disabled={busy || !url.trim() || snippet.trim().length < 20 || (dated && !date) || (visual && !media.trim())} onClick={saveEvidence}>Save reviewed evidence</Btn></div>
    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
      <b>Verify developer and game identity</b>
      <Muted>Requires two separate reviewed rows from the official developer website: one exact developer name and one exact project title.</Muted>
      <Field label="Verified developer / studio name"><Input value={developer} onChange={(e) => setDeveloper(e.target.value)} /></Field>
      <Field label="Developer identity evidence"><Select value={developerEvidence} onChange={(e) => setDeveloperEvidence(e.target.value)} options={idOptions.filter(([id]) => !id || reviewed.find((r) => r.id === id)?.fact_type === "developer_identity")} /></Field>
      <Field label="Exact game title evidence"><Select value={projectEvidence} onChange={(e) => setProjectEvidence(e.target.value)} options={idOptions.filter(([id]) => !id || reviewed.find((r) => r.id === id)?.fact_type === "project_identity")} /></Field>
      {prospect.facts?.verified?.source_key === "kickstarter_manual" && <Field label="Kickstarter creator role (only if independently evidenced)"><Select value={role} onChange={(e) => setRole(e.target.value)} options={[["unknown", "Not established"], ["developer", "Developer"], ["studio_representative", "Studio representative"], ["publisher", "Publisher"], ["organizer", "Organizer"]]} /></Field>}
      <Btn disabled={busy || !developer.trim() || !developerEvidence || !projectEvidence} onClick={verifyIdentity}>Verify identity</Btn>
    </div>
    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
      <b>Verify exact contact email</b>
      <Muted>Requires the exact address in a separate reviewed contact_email evidence row. For an external professional profile, the evidence must also name the developer or authorized team member and explicitly establish their role. Personal email addresses still require documented affiliation and deliverability evidence. Suppressed or opted-out contacts are rejected.</Muted>
      <Field label="Exact published email"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Contact email evidence"><Select value={contactEvidence} onChange={(e) => setContactEvidence(e.target.value)} options={idOptions.filter(([id]) => !id || reviewed.find((r) => r.id === id)?.fact_type === "contact_email")} /></Field>
      <Btn disabled={busy || !email.trim() || !contactEvidence} onClick={verifyContact}>Verify contact</Btn>
    </div>
    <div style={S.row}><Pill tone="info">{reviewed.length} reviewed evidence rows</Pill><Pill tone={prospect.facts?.verified?.developer_identity_status === "independently_verified" ? "ok" : "warn"}>{prospect.facts?.verified?.developer_identity_status === "independently_verified" ? "Identity verified" : "Identity not verified"}</Pill><Pill tone={prospect.facts?.verified?.contact_verification === "human_confirmed" ? "ok" : "warn"}>{prospect.facts?.verified?.contact_verification === "human_confirmed" ? "Contact verified" : "Contact not verified"}</Pill></div>
  </div>;
}
