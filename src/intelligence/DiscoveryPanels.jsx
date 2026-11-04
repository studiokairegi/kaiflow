import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { profileFromForm, profileToForm, proposedTerms } from "./logic.js";
import { Input, Kpi, Muted, Section, TextArea, useLoad } from "./kit.jsx";

/** Describe the customer you want; the agent proposes bilingual search phrases; you approve them. Only approved phrases are ever used. */
export function DiscoveryProfile({ campaign, supabase, onChanged }) {
  const saved = campaign.criteria?.profile;
  const [f, setF] = useState(() => profileToForm(saved));
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useBusy();
  const sug = proposedTerms(saved);
  useEffect(() => { if (!dirty) setF(profileToForm(saved)); }, [JSON.stringify(saved)]);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setDirty(true); };
  const save = () => run(async () => { await intelApi.setProfile(supabase, campaign.type, profileFromForm(f)); setDirty(false); await onChanged(); });
  return (
    <Section title="Who you want to find" hint="Describe the customer in your own words. The agent turns it into English and Japanese search phrases for news, feeds and archives, and uses them only after you approve."
      action={<Pill tone={saved?.approved && !dirty ? "ok" : "warn"}>{saved?.approved && !dirty ? "Approved" : "Not approved"}</Pill>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Field label="Description"><TextArea rows={3} value={f.description} onChange={set("description")} placeholder="e.g. Japanese 2D animation studios that outsource layout, key animation or in-betweens, and studios producing game cinematics" /></Field>
      <div style={S.grid(240)}>
        <Field label="English phrases (one per line)"><TextArea rows={6} value={f.termsEn} onChange={set("termsEn")} /></Field>
        <Field label="Japanese phrases (one per line)"><TextArea rows={6} value={f.termsJa} onChange={set("termsJa")} /></Field>
        <Field label="Skip results containing"><TextArea rows={6} value={f.exclude} onChange={set("exclude")} /></Field>
      </div>
      {sug && (
        <Banner tone="info" action={<Btn small onClick={() => { setF({ ...f, ...sug }); setDirty(true); }}>Use these</Btn>}>
          The agent suggested phrases. Review them, then save and approve.
        </Banner>
      )}
      <div style={S.row}>
        <Btn disabled={busy} onClick={() => run(async () => { await intelApi.setProfile(supabase, campaign.type, profileFromForm({ ...f, termsEn: f.termsEn || "animation studio" })); await intelApi.enqueue(supabase, "profile_terms", { type: campaign.type }); await onChanged(); })}>Suggest phrases</Btn>
        <Btn disabled={busy || !dirty} onClick={save}>Save</Btn>
        <Btn kind="primary" disabled={busy || dirty || !saved || saved.approved} onClick={() => run(async () => { await intelApi.approveProfile(supabase, campaign.type, true); await onChanged(); })}>Approve phrases</Btn>
      </div>
      <Muted>Saving a change un-approves the profile. Until it is approved, news and archive discovery stay idle; studio lists, site analysis and feeds still run.</Muted>
    </Section>
  );
}

/** Optional manual assist for X (nothing is fetched from X): paste a post you found and the agent investigates the studio it names. */
export function ManualPost({ type, supabase, onChanged }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [done, setDone] = useState("");
  const { busy, error, run } = useBusy();
  return (
    <Section title="Add from an X post" hint="Found a recruitment post on X? Paste the link and its text. The agent works out which studio it is, tells a studio from an individual, and investigates the studio's own website. Nothing is fetched from X.">
      {error && <Banner tone="bad">{error}</Banner>}
      {done && <Banner tone="ok">{done}</Banner>}
      <Field label="Post link (optional)"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://x.com/..." /></Field>
      <Field label="Post text"><TextArea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the post, for example 原画募集 ..." /></Field>
      <div><Btn disabled={busy || (!url.trim() && !text.trim())} onClick={() => run(async () => { await intelApi.addManualPost(supabase, type, url.trim(), text.trim()); setUrl(""); setText(""); setDone("Queued. The result appears under Prospects within a few minutes."); await onChanged(); })}>Investigate</Btn></div>
    </Section>
  );
}

export function DiscoveryStats({ supabase, tick }) {
  const st = useLoad(() => intelApi.discoveryStats(supabase), [supabase, tick]);
  const d = st.data;
  if (!d) return st.error ? <Banner tone="bad">{st.error}</Banner> : null;
  const pct = (n) => (d.prospects ? `${Math.round((100 * n) / d.prospects)}% of found` : "");
  return (
    <Section title="Discovery so far" hint="How far autonomous discovery has got, and how much of it is usable.">
      <div style={S.grid(170)}>
        <Kpi label="Studios found" value={d.prospects} sub={`${d.new_last_7_days} in the last 7 days`} />
        <Kpi label="With a website" value={d.with_website} sub={pct(d.with_website)} />
        <Kpi label="With a contact email" value={d.with_contact} sub={pct(d.with_contact)} tone={d.with_contact ? "ok" : "warn"} />
        <Kpi label="With recruitment evidence" value={d.with_recruit_evidence} sub={pct(d.with_recruit_evidence)} />
        <Kpi label="Qualified or further" value={d.qualified_or_beyond} />
      </div>
      <Muted>Items found per source: {Object.entries(d.items_by_source || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}.</Muted>
    </Section>
  );
}
