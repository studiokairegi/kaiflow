import React, { useCallback, useEffect, useRef, useState } from "react";
import { S, T, Btn, Pill, Banner, Modal, Field, useBusy } from "../finance/ui.jsx";
import * as api from "./api.js";
import { validateFile, formatBytes, moveItem, portfolioUrl, linkStatus, MAX_ITEMS } from "./logic.js";

// Leads > Portfolio. Curate videos/images, then create a separate secure link per recipient.
function ItemCard({ item, url, index, count, onMove, onReplace, onDelete, onSave }) {
  const [title, setTitle] = useState(item.title);
  const [caption, setCaption] = useState(item.caption);
  const replaceRef = useRef(null);
  return (
    <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: "#000", borderRadius: 8, overflow: "hidden", aspectRatio: "16 / 9", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {!url ? <span style={S.sub}>Preview unavailable</span>
          : item.kind === "video" ? <video src={url} controls preload="metadata" playsInline style={{ width: "100%", height: "100%" }} />
          : <img src={url} alt={item.title || "Portfolio image"} style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
      </div>
      <input style={S.input} value={title} maxLength={120} placeholder="Title" aria-label="Title" onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== item.title && onSave(item.id, { title })} />
      <textarea style={{ ...S.input, minHeight: 56 }} value={caption} maxLength={500} placeholder="Caption (optional)" aria-label="Caption" onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== item.caption && onSave(item.id, { caption })} />
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <span style={S.sub}>{item.kind === "video" ? "Video" : "Image"} · {formatBytes(item.size_bytes)}</span>
        <span style={S.row}>
          <Btn small disabled={index === 0} onClick={() => onMove(item.id, "up")} aria-label="Move earlier">↑</Btn>
          <Btn small disabled={index === count - 1} onClick={() => onMove(item.id, "down")} aria-label="Move later">↓</Btn>
          <Btn small onClick={() => replaceRef.current?.click()}>Replace</Btn>
          <Btn small onClick={() => onDelete(item)}>Delete</Btn>
        </span>
      </div>
      <input ref={replaceRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onReplace(item, f); }} />
    </div>
  );
}

function NewLinkDialog({ onClose, onCreated }) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("30");
  const [made, setMade] = useState(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useBusy();
  const d = Number(days);
  const daysOk = days === "" || (Number.isInteger(d) && d >= 1 && d <= 365);
  const create = () => run(async () => {
    const r = await api.createLink(label.trim(), days === "" ? null : d);
    setMade({ url: portfolioUrl(r.token, window.location.origin), expires: r.expires_at });
    onCreated();
  });
  const copy = async () => { try { await navigator.clipboard.writeText(made.url); setCopied(true); } catch { setCopied(false); } };
  return (
    <Modal title="Share portfolio" onClose={onClose} width={520} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {!made ? (
        <>
          <p style={S.sub}>Creates a private link for one recipient. They watch in the browser, no login or download. You can see when it's opened and revoke it any time.</p>
          <Field label="Who is this for?" hint="Only you see this, e.g. “Acme Studio, Jane”."><input style={S.input} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Link valid for (days)" hint={daysOk ? "Leave empty for no expiry." : "Between 1 and 365."}><input style={S.input} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <div><Btn kind="primary" disabled={busy || !daysOk} onClick={create}>{busy ? "Creating…" : "Create link"}</Btn></div>
        </>
      ) : (
        <>
          <Banner tone="warn">Copy this link now. For security it's shown only once and can't be retrieved later (you can always create another).</Banner>
          <input readOnly style={S.input} value={made.url} onFocus={(e) => e.target.select()} aria-label="Portfolio link" />
          <div style={S.row}><Btn kind="primary" onClick={copy}>{copied ? "Copied" : "Copy link"}</Btn><span style={S.sub}>{made.expires ? `Expires ${new Date(made.expires).toLocaleDateString()}` : "No expiry"}</span></div>
        </>
      )}
    </Modal>
  );
}

export default function PortfolioTab() {
  const [items, setItems] = useState([]);
  const [links, setLinks] = useState([]);
  const [urls, setUrls] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [showLink, setShowLink] = useState(false);
  const { busy, error, run } = useBusy();
  const fileRef = useRef(null);

  const load = useCallback(() => run(async () => {
    const [i, l] = await Promise.all([api.listItems(), api.listLinks()]);
    setItems(i); setLinks(l); setUrls(await api.previewUrls(i.map((x) => x.storage_path))); setLoaded(true);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const upload = (files) => run(async () => {
    const problems = []; let count = items.length; let done = 0;
    const list = [...files];
    for (const f of list) {
      const v = validateFile(f, count);
      if (!v.ok) { problems.push(v.error); continue; }
      setProgress(`Uploading ${done + 1} of ${list.length}: ${f.name}`);
      try { await api.addItem(f, items); count++; } catch (e) { problems.push(`${f.name}: ${e.message}`); }
      done++;
      setItems(await api.listItems());   // keep sort_order current for the next file
    }
    setProgress(""); setNotice(problems.join("\n")); await load();
  });
  const replace = (item, f) => { const v = validateFile(f, 0); if (!v.ok) return setNotice(v.error); run(async () => { setProgress(`Replacing: ${f.name}`); await api.replaceItemFile(item, f); setProgress(""); setNotice(""); await load(); }); };
  const remove = (item) => { if (window.confirm(`Delete “${item.title || "this item"}” from your portfolio? Existing links will stop showing it.`)) run(async () => { await api.deleteItem(item); await load(); }); };
  const move = (id, dir) => run(async () => { const next = moveItem(items, id, dir); setItems(next); await api.saveOrder(next); });
  const save = (id, patch) => run(async () => { await api.updateItem(id, patch); setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x))); });
  const revoke = (l) => { if (window.confirm(`Revoke the link for ${l.recipient_label || "this recipient"}? It will stop working immediately.`)) run(async () => { await api.revokeLink(l.id); await load(); }); };

  return (
    <div style={S.page}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Portfolio</h2><p style={S.sub}>Videos and images you can share with a private, no-login link. Videos play right on the page.</p></div>
        <span style={S.row}>
          <Btn disabled={busy || items.length >= MAX_ITEMS} onClick={() => fileRef.current?.click()}>Add videos / images</Btn>
          <Btn kind="primary" disabled={!items.length} onClick={() => setShowLink(true)}>Share portfolio</Btn>
        </span>
      </div>
      <input ref={fileRef} type="file" multiple hidden accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const f = e.target.files; e.target.value = ""; if (f?.length) upload(f); }} />
      {error && <Banner tone="bad">{error}</Banner>}
      {notice && <Banner tone="warn"><span style={{ whiteSpace: "pre-line" }}>{notice}</span></Banner>}
      {progress && <Banner tone="info">{progress}</Banner>}

      {loaded && !items.length && <div style={S.card}><p style={S.sub}>Nothing here yet. Add short reels (MP4/WebM/MOV, up to 500 MB each) and images, then share the portfolio with a client.</p></div>}
      <div style={S.grid(300)}>
        {items.map((it, i) => <ItemCard key={it.id} item={it} url={urls[it.storage_path]} index={i} count={items.length} onMove={move} onReplace={replace} onDelete={remove} onSave={save} />)}
      </div>

      {links.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Shared links</h3>
          {links.map((l) => {
            const st = linkStatus(l);
            return (
              <div key={l.id} style={{ ...S.row, justifyContent: "space-between", padding: "8px 0", borderTop: `1px solid ${T.border || "#2a3140"}` }}>
                <span>
                  <strong>{l.recipient_label || "Unnamed link"}</strong>{" "}
                  <Pill tone={st === "active" ? "ok" : "muted"}>{st}</Pill>
                  <div style={S.sub}>…{l.token_hint} · created {new Date(l.created_at).toLocaleDateString()} · {l.view_count} view{l.view_count === 1 ? "" : "s"}{l.last_viewed_at ? ` · last ${new Date(l.last_viewed_at).toLocaleString()}` : " · not opened yet"}</div>
                </span>
                {st === "active" && <Btn small onClick={() => revoke(l)}>Revoke</Btn>}
              </div>
            );
          })}
        </div>
      )}
      {showLink && <NewLinkDialog onClose={() => setShowLink(false)} onCreated={load} />}
    </div>
  );
}
