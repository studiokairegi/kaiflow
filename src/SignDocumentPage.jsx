import React, { useEffect, useRef, useState } from "react";
import { normalizeLang, localeFor } from "./i18n/languages.js";
import { contractT, localizeSignError } from "./i18n/contractStrings.js";
import { isSafeSignatureSrc } from "./contracts.js";

// Shared public signing page used by the freelancer NDA (NdaSignPage.jsx) and client
// contracts (ContractSignPage.jsx). No account needed: it only calls the token-based public
// RPCs it is given in `api`.
//   docLabel      "NDA" | "contract"   (used in buttons and messages)
//   api           { get(token), sign({token,typedName,signaturePng,method}), decline(token,reason) }
//   downloadPdf   (doc) => void
//   consentText   checkbox wording: a string, or (lang) => string for documents that can be sent in Japanese
//   renderSummary optional (doc, lang) => node, shown above the document (e.g. key contract terms)
//   hintLang      language to use until the document has loaded (from the link's ?lang=); once loaded the
//                 document's own `language` decides. A document without one (the freelancer NDA) is English.

const ink = "#14191c", panel = "#1c2327", line = "#2a3338", muted = "#8b9a98";
const teal = "#2FBFA6", tealLight = "#7FE0D0", sheet = "#FBFAF7", sheetInk = "#1d2326";
const sans = "'Inter', system-ui, sans-serif";
const serif = "'Source Serif 4', Georgia, 'Times New Roman', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif";
// Latin names use the handwriting fonts; kanji/kana fall through to the Japanese fonts listed before `cursive`.
const script = "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', cursive";

// The PDF certificate records UTC; show the signer's local time with its zone name next to the same UTC stamp so the
// two never look like different times.
function signedAtLabel(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const local = d.toLocaleString(lang === "ja" ? localeFor(lang) : undefined, { timeZoneName: "short" });
  return `${local} / ${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function typedSignaturePng(name) {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1d2326";
  ctx.font = `64px ${script}`;
  ctx.textBaseline = "middle";
  let size = 64;
  while (ctx.measureText(name).width > 590 && size > 24) { size -= 4; ctx.font = `${size}px ${script}`; }
  ctx.fillText(name, 24, 100);
  return c.toDataURL("image/png");
}

function SignaturePad({ onChange, t }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  useEffect(() => {
    const c = ref.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = sheetInk;
  }, []);

  const pos = (e) => { const r = ref.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e) => { ref.current.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); };
  const move = (e) => {
    if (!drawing.current) return;
    const p = pos(e), ctx = ref.current.getContext("2d");
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
  };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current.toDataURL("image/png")); };
  const clear = () => {
    const c = ref.current, ctx = c.getContext("2d");
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore();
    onChange(null);
  };

  return (
    <div>
      <div style={{ position: "relative", background: sheet, borderRadius: 8, border: `1px solid ${line}` }}>
        <canvas
          ref={ref}
          aria-label={t("sign.padLabel")}
          style={{ width: "100%", height: 150, display: "block", touchAction: "none", cursor: "crosshair" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        />
        <div style={{ position: "absolute", left: 16, right: 16, bottom: 34, borderBottom: "1px solid #c9c5ba", pointerEvents: "none" }} />
      </div>
      <button type="button" onClick={clear} style={linkBtn}>{t("sign.clear")}</button>
    </div>
  );
}

const linkBtn = { background: "none", border: "none", color: tealLight, fontSize: 13, cursor: "pointer", padding: "6px 0", fontFamily: sans };
const pill = (active) => ({
  background: active ? "rgba(47,191,166,0.14)" : "transparent", border: `1px solid ${active ? teal : line}`,
  color: active ? tealLight : muted, borderRadius: 999, padding: "7px 16px", fontSize: 13, cursor: "pointer", fontFamily: sans,
});

export default function SignDocumentPage({ token, docLabel = "document", api, downloadPdf, consentText, renderSummary, hintLang }) {
  const [doc, setDoc] = useState(undefined); // undefined = loading, null = invalid link
  const [error, setError] = useState("");
  const [method, setMethod] = useState("draw");
  const [name, setName] = useState("");
  const [drawn, setDrawn] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const submitting = useRef(false);

  // The signing link carries the token in its URL: don't hand it to other sites through the Referer header.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer"; meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  useEffect(() => {
    let off = false;
    api.get(token)
      .then((d) => { if (!off) { setDoc(d); if (d) setName(d.signer_name || ""); } })
      .catch(() => { if (!off) setDoc(null); });
    return () => { off = true; };
  }, [token]);

  // Language: the document's own once loaded, else the link's hint, else English.
  const lang = normalizeLang(doc && doc.language ? doc.language : hintLang);
  const t = contractT(lang);
  const noun = docLabel === "contract" || docLabel === "NDA" ? t(`doc.${docLabel}`) : docLabel;
  const consent = typeof consentText === "function" ? consentText(lang) : consentText;
  const [downloadError, setDownloadError] = useState("");

  const canSign = agree && name.trim().length >= 2 && (method === "type" || drawn) && !busy;

  const sign = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const png = method === "type" ? typedSignaturePng(name.trim()) : drawn;
      setDoc(await api.sign({ token, typedName: name.trim(), signaturePng: png, method, consentText: consent }));
    } catch (e) { setError(localizeSignError(e.message, lang, "sign.error")); }
    submitting.current = false;
    setBusy(false);
  };
  const decline = async () => {
    setBusy(true); setError("");
    try { setDoc(await api.decline(token, reason)); }
    catch (e) { setError(localizeSignError(e.message, lang, "decline.error")); }
    setBusy(false);
  };

  const download = async () => {
    setDownloadError("");
    try { await downloadPdf(doc); } catch (e) { setDownloadError(t("pdf.error")); }
  };

  const shell = (children) => (
    <div lang={lang} style={{ minHeight: "100vh", background: ink, color: "#EDEAE3", fontFamily: sans, padding: "28px 16px 64px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>{children}</div>
    </div>
  );

  if (doc === undefined) return shell(<p style={{ color: muted }}>{t("loading")}</p>);
  if (doc === null) return shell(
    <div style={{ textAlign: "center", paddingTop: 80 }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>{t("invalid.title")}</h1>
      <p style={{ color: muted }}>{t("invalid.body")}</p>
    </div>
  );

  const open = doc.status === "sent" || doc.status === "viewed";
  const closedMsg = {
    expired: t("closed.expired"),
    voided: t("closed.voided"),
    declined: t("closed.declined", { doc: noun }),
  }[doc.status];

  return shell(
    <>
      <header style={{ marginBottom: 20 }}>
        <div style={{ color: muted, fontSize: 13 }}>{t("asked", { studio: doc.studio_name || t("studioFallback") })}</div>
        <h1 style={{ fontSize: 24, margin: "4px 0 0", fontWeight: 600 }}>{doc.title}</h1>
      </header>

      {doc.status === "signed" && (
        <div style={{ background: "rgba(61,220,132,0.1)", border: "1px solid #3DDC84", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <strong style={{ color: "#3DDC84" }}>{t("signed.label")}</strong>
          <span style={{ color: muted, fontSize: 13 }}>{t("signed.on", { date: signedAtLabel(doc.signed_at, lang), studio: doc.studio_name })}</span>
          <div style={{ marginTop: 12 }}>
            <button style={{ ...pill(true), fontWeight: 600 }} onClick={download}>{t("signed.download")}</button>
          </div>
          {downloadError && <p role="alert" style={{ color: "#E5646B", fontSize: 13, margin: "10px 0 0" }}>{downloadError}</p>}
        </div>
      )}
      {closedMsg && (
        <div style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 16, marginBottom: 20, color: muted }}>{closedMsg}</div>
      )}

      {renderSummary && renderSummary(doc, lang)}

      <article
        lang={lang}
        style={{ background: sheet, color: sheetInk, borderRadius: 6, padding: "40px 44px", fontFamily: serif, fontSize: 16, lineHeight: 1.65, whiteSpace: "pre-wrap", lineBreak: lang === "ja" ? "strict" : "auto", boxShadow: "0 12px 32px rgba(0,0,0,0.4)" }}
      >
        {doc.body}
        {doc.status === "signed" && isSafeSignatureSrc(doc.signature_png) && (
          <div style={{ marginTop: 28 }}>
            <img src={doc.signature_png} alt={t("signature.alt")} style={{ height: 70, display: "block" }} />
            <div style={{ fontWeight: 600 }}>{doc.typed_name}</div>
          </div>
        )}
      </article>

      {open && !declining && (
        <section style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 14px" }}>{t("sign.heading")}</h2>
          <label style={{ fontSize: 13, color: muted }} htmlFor="sign-name">{t("sign.nameLabel")}</label>
          <input
            id="sign-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name"
            style={{ display: "block", width: "100%", boxSizing: "border-box", margin: "6px 0 16px", background: ink, border: `1px solid ${line}`, borderRadius: 8, color: "#EDEAE3", padding: "10px 12px", fontSize: 15, fontFamily: sans }}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button type="button" style={pill(method === "draw")} onClick={() => setMethod("draw")}>{t("sign.draw")}</button>
            <button type="button" style={pill(method === "type")} onClick={() => setMethod("type")}>{t("sign.type")}</button>
          </div>
          {method === "draw" ? (
            <SignaturePad onChange={setDrawn} t={t} />
          ) : (
            <div style={{ background: sheet, color: sheetInk, borderRadius: 8, padding: "26px 20px", fontFamily: script, fontSize: 38, minHeight: 50, overflow: "hidden", whiteSpace: "nowrap" }}>
              {name.trim() || <span style={{ color: "#b9b5aa" }}>{t("sign.namePlaceholder")}</span>}
            </div>
          )}
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "18px 0", fontSize: 13.5, color: "#cfd6d4", cursor: "pointer" }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
            <span>{consent}</span>
          </label>
          {error && <p role="alert" style={{ color: "#E5646B", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button" disabled={!canSign} onClick={sign}
              style={{ background: canSign ? teal : line, color: canSign ? ink : muted, border: "none", borderRadius: 999, padding: "11px 24px", fontWeight: 600, fontSize: 14, cursor: canSign ? "pointer" : "not-allowed", fontFamily: sans }}
            >
              {busy ? t("sign.busy") : t("sign.button", { doc: noun })}
            </button>
            <button type="button" style={linkBtn} onClick={() => setDeclining(true)}>{t("sign.decline")}</button>
          </div>
          <p style={{ color: muted, fontSize: 12, margin: "14px 0 0" }}>
            {t("sign.recorded")}
          </p>
        </section>
      )}

      {open && declining && (
        <section style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>{t("decline.heading", { doc: noun })}</h2>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={t("decline.placeholder")}
            style={{ width: "100%", boxSizing: "border-box", background: ink, border: `1px solid ${line}`, borderRadius: 8, color: "#EDEAE3", padding: 10, fontFamily: sans, fontSize: 14 }}
          />
          {error && <p role="alert" style={{ color: "#E5646B", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={decline} style={{ ...pill(false), color: "#E5646B", borderColor: "#E5646B" }}>{t("decline.button", { doc: noun })}</button>
            <button type="button" style={linkBtn} onClick={() => setDeclining(false)}>{t("decline.back")}</button>
          </div>
        </section>
      )}
    </>
  );
}
