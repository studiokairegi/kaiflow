import React, { useCallback, useEffect, useRef, useState } from "react";
import { S, T, Btn, Pill, Banner, Modal, Field, useBusy } from "../finance/ui.jsx";
import * as api from "./api.js";
import { validateFile, formatBytes, moveItem, portfolioUrl, linkStatus, MAX_ITEMS } from "./logic.js";

// Leads > Portfolio. Curate videos/images, then create a separate secure link per recipient.
const fillStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" };

// `problem` is a visible reason this item can't be shown (from the Drive check or a failed preview load).
function ItemCard({ item, url, health, previewFailed, index, count, onMove, onReplace, onDelete, onSave, onPreviewError }) {
  const [title, setTitle] = useState(item.title);
  const [caption, setCaption] = useState(item.caption);
  const replaceRef = useRef(null);
  const bad = health && !["ok", "legacy"].includes(health.status);
  const problem = bad ? health.detail : previewFailed ? "The preview couldn't be loaded from Google Drive." : !url ? "No preview URL was issued for this item." : "";
  return (
    <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ position: "relative", background: "#000", borderRadius: 8, overflow: "hidden", aspectRatio: "16 / 9" }}>
        {url && !bad && (item.kind === "video"
          ? <video src={url} controls preload="metadata" playsInline style={fillStyle} onError={() => onPreviewError(item.id)} />
          : <img src={url} alt={item.title || "Portfolio image"} style={{ ...fillStyle, objectFit: "contain" }} onError={() => onPreviewError(item.id)} />)}
        {problem && (previewFailed || bad || !url) && (
          <div role="alert" style={{ ...fillStyle, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 12, color: T.bad, fontSize: 12.5 }}>⚠ {problem}</div>
        )}
      </div>
      {health?.status === "legacy" && <Pill tone="warn">Old storage: move to Google Drive</Pill>}
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

const EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export default function PortfolioTab({ driveEmail, onConnectDrive }) {
  const [items, setItems] = useState([]);
  const [links, setLinks] = useState([]);
  const [urls, setUrls] = useState({});
  const [health, setHealth] = useState({});          // itemId -> {status, detail} from the Drive check
  const [failedPreviews, setFailedPreviews] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");           // upload / migration failures, kept on screen until dismissed
  const [needsDrive, setNeedsDrive] = useState(false);
  const [mediaError, setMediaError] = useState("");   // previews / Drive check couldn't run
  const [showLink, setShowLink] = useState(false);
  const { busy, error, run } = useBusy();
  const fileRef = useRef(null);

  const load = useCallback(() => run(async () => {
    const [i, l] = await Promise.all([api.listItems(), api.listLinks()]);
    setItems(i); setLinks(l); setLoaded(true); setFailedPreviews({});
    if (!i.length) { setUrls({}); setHealth({}); setMediaError(""); return; }
    // Previews + Drive check run after the list is on screen; failures are SHOWN, never swallowed.
    const [p, h] = await Promise.allSettled([api.previewUrls(), api.verifyItems()]);
    const errs = [];
    if (p.status === "fulfilled") setUrls(p.value); else { setUrls({}); errs.push(`Previews: ${p.reason.message}`); if (p.reason.code === "not_connected") setNeedsDrive(true); }
    if (h.status === "fulfilled") setHealth(Object.fromEntries(h.value.map((x) => [x.id, x]))); else { setHealth({}); errs.push(`Google Drive check: ${h.reason.message}`); if (h.reason.code === "not_connected") setNeedsDrive(true); }
    setMediaError(errs.join("\n"));
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const describe = (e) => { if (e?.code === "not_connected") setNeedsDrive(true); return e?.message || "Unknown error"; };

  const upload = (files) => run(async () => {
    const problems = []; let count = items.length; const list = [...files];
    for (let n = 0; n < list.length; n++) {
      const f = list[n];
      const v = validateFile(f, count);
      if (!v.ok) { problems.push(v.error); continue; }
      const label = `Uploading ${n + 1} of ${list.length}: ${f.name}`;
      setProgress(label);
      try { await api.uploadMedia(f, { onProgress: (p) => setProgress(`${label} (${Math.round(p * 100)}%)`) }); count++; }
      catch (e) { problems.push(`${f.name}: ${describe(e)}`); }
    }
    setProgress(""); setNotice(problems.join("\n")); await load();
  });
  const replace = (item, f) => {
    const v = validateFile(f, 0);
    if (!v.ok) return setNotice(v.error);
    run(async () => {
      setProgress(`Replacing: ${f.name}`);
      try { await api.uploadMedia(f, { replaceItemId: item.id, onProgress: (p) => setProgress(`Replacing: ${f.name} (${Math.round(p * 100)}%)`) }); setNotice(""); }
      catch (e) { setNotice(`${f.name}: ${describe(e)}`); }
      setProgress(""); await load();
    });
  };
  const remove = (item) => { if (window.confirm(`Delete “${item.title || "this item"}” from your portfolio? The file moves to your Google Drive trash, and existing links stop showing it.`)) run(async () => { await api.deleteItem(item); await load(); }); };
  const move = (id, dir) => run(async () => { const next = moveItem(items, id, dir); setItems(next); await api.saveOrder(next); });
  const save = (id, patch) => run(async () => { await api.updateItem(id, patch); setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x))); });
  const revoke = (l) => { if (window.confirm(`Revoke the link for ${l.recipient_label || "this recipient"}? It will stop working immediately.`)) run(async () => { await api.revokeLink(l.id); await load(); }); };

  // Items uploaded before the Drive move: download each from the old storage (via its preview URL) and re-upload to Drive.
  const legacy = items.filter((i) => !i.drive_file_id);
  const migrate = () => run(async () => {
    const problems = [];
    for (let n = 0; n < legacy.length; n++) {
      const it = legacy[n];
      const label = `Moving ${n + 1} of ${legacy.length} to Google Drive: ${it.title || it.id}`;
      setProgress(label);
      try {
        if (!urls[it.id]) throw new Error("no preview URL to copy from");
        const res = await fetch(urls[it.id]);
        if (!res.ok) throw new Error(`couldn't read the old file (HTTP ${res.status})`);
        const blob = await res.blob();
        const file = new File([blob], `${(it.title || "portfolio").slice(0, 80)}.${EXT[it.mime_type] || "bin"}`, { type: it.mime_type });
        await api.uploadMedia(file, { replaceItemId: it.id, onProgress: (p) => setProgress(`${label} (${Math.round(p * 100)}%)`) });
      } catch (e) { problems.push(`${it.title || it.id}: ${describe(e)}`); }
    }
    setProgress(""); setNotice(problems.join("\n")); await load();
  });

  return (
    <div style={S.page}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Portfolio</h2><p style={S.sub}>Videos and images stored in your Google Drive (folder “StudioKairegi Portfolio”), shared with a private, no-login link. Videos play right on the page.</p></div>
        <span style={S.row}>
          <Btn disabled={busy || items.length >= MAX_ITEMS} onClick={() => fileRef.current?.click()}>Add videos / images</Btn>
          <Btn kind="primary" disabled={!items.length} onClick={() => setShowLink(true)}>Share portfolio</Btn>
        </span>
      </div>
      <input ref={fileRef} type="file" multiple hidden accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const f = e.target.files; e.target.value = ""; if (f?.length) upload(f); }} />

      {(needsDrive || (!driveEmail && loaded)) && onConnectDrive && !driveEmail && (
        <Banner tone="warn" action={<Btn small onClick={onConnectDrive}>Connect Google Drive</Btn>}>Connect Google Drive to upload and show portfolio media; it's stored in your Drive.</Banner>
      )}
      {needsDrive && driveEmail && <Banner tone="warn">Google Drive needs to be reconnected before portfolio media can be uploaded or shown.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}
      {mediaError && <Banner tone="bad"><span style={{ whiteSpace: "pre-line" }}>{mediaError}</span></Banner>}
      {notice && <Banner tone="bad" action={<Btn small onClick={() => setNotice("")}>Dismiss</Btn>}><span style={{ whiteSpace: "pre-line" }}>Some uploads failed:{"\n"}{notice}</span></Banner>}
      {progress && <Banner tone="info">{progress}</Banner>}
      {legacy.length > 0 && (
        <Banner tone="warn" action={<Btn small disabled={busy || !Object.keys(urls).length} onClick={migrate}>Move to Google Drive</Btn>}>
          {legacy.length} item{legacy.length === 1 ? " is" : "s are"} still in the old storage. Move {legacy.length === 1 ? "it" : "them"} to your Google Drive folder.
        </Banner>
      )}

      {loaded && !items.length && <div style={S.card}><p style={S.sub}>Nothing here yet. Add short reels (MP4/WebM/MOV, up to 500 MB each) and images, then share the portfolio with a client.</p></div>}
      <div style={S.grid(300)}>
        {items.map((it, i) => (
          <ItemCard key={it.id} item={it} url={urls[it.id]} health={health[it.id]} previewFailed={!!failedPreviews[it.id]} index={i} count={items.length}
            onMove={move} onReplace={replace} onDelete={remove} onSave={save} onPreviewError={(id) => setFailedPreviews((f) => ({ ...f, [id]: true }))} />
        ))}
      </div>

      {links.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Shared links</h3>
          {links.map((l) => {
            const st = linkStatus(l);
            return (
              <div key={l.id} style={{ ...S.row, justifyContent: "space-between", padding: "8px 0", borderTop: `1px solid ${T.border}` }}>
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
