import React, { useEffect, useRef, useState } from "react";
import { publicGetNda, publicSignNda, publicDeclineNda, downloadNdaPdf, NDA_CONSENT_TEXT } from "./ndaApi";

// Public signing page, rendered when the URL is ?share=nda&token=...
// No account needed: it talks to the nda_public_* RPCs only.

const ink = "#14191c", panel = "#1c2327", line = "#2a3338", muted = "#8b9a98";
const teal = "#2FBFA6", tealLight = "#7FE0D0", sheet = "#FBFAF7", sheetInk = "#1d2326";
const sans = "'Inter', system-ui, sans-serif";
const serif = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const script = "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive";

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

function SignaturePad({ onChange }) {
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
          aria-label="Signature drawing area"
          style={{ width: "100%", height: 150, display: "block", touchAction: "none", cursor: "crosshair" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        />
        <div style={{ position: "absolute", left: 16, right: 16, bottom: 34, borderBottom: "1px solid #c9c5ba", pointerEvents: "none" }} />
      </div>
      <button type="button" onClick={clear} style={linkBtn}>Clear</button>
    </div>
  );
}

const linkBtn = { background: "none", border: "none", color: tealLight, fontSize: 13, cursor: "pointer", padding: "6px 0", fontFamily: sans };
const pill = (active) => ({
  background: active ? "rgba(47,191,166,0.14)" : "transparent", border: `1px solid ${active ? teal : line}`,
  color: active ? tealLight : muted, borderRadius: 999, padding: "7px 16px", fontSize: 13, cursor: "pointer", fontFamily: sans,
});

export default function NdaSignPage({ token }) {
  const [nda, setNda] = useState(undefined); // undefined = loading, null = invalid link
  const [error, setError] = useState("");
  const [method, setMethod] = useState("draw");
  const [name, setName] = useState("");
  const [drawn, setDrawn] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let off = false;
    publicGetNda(token)
      .then((d) => { if (!off) { setNda(d); if (d) setName(d.signer_name || ""); } })
      .catch(() => { if (!off) setNda(null); });
    return () => { off = true; };
  }, [token]);

  const canSign = agree && name.trim().length >= 2 && (method === "type" || drawn) && !busy;

  const sign = async () => {
    setBusy(true); setError("");
    try {
      const png = method === "type" ? typedSignaturePng(name.trim()) : drawn;
      setNda(await publicSignNda({ token, typedName: name.trim(), signaturePng: png, method }));
    } catch (e) { setError(e.message || "Signing failed. Please try again."); }
    setBusy(false);
  };
  const decline = async () => {
    setBusy(true); setError("");
    try { setNda(await publicDeclineNda(token, reason)); }
    catch (e) { setError(e.message || "Couldn't decline. Please try again."); }
    setBusy(false);
  };

  const shell = (children) => (
    <div style={{ minHeight: "100vh", background: ink, color: "#EDEAE3", fontFamily: sans, padding: "28px 16px 64px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>{children}</div>
    </div>
  );

  if (nda === undefined) return shell(<p style={{ color: muted }}>Loading document...</p>);
  if (nda === null) return shell(
    <div style={{ textAlign: "center", paddingTop: 80 }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>This signing link isn't valid</h1>
      <p style={{ color: muted }}>Ask the studio to send you a new one.</p>
    </div>
  );

  const open = nda.status === "sent" || nda.status === "viewed";
  const closedMsg = {
    expired: "This link has expired. Ask the studio for a new one.",
    voided: "The studio replaced or cancelled this request. Ask them for the latest link.",
    declined: "You declined this NDA. The studio has been notified.",
  }[nda.status];

  return shell(
    <>
      <header style={{ marginBottom: 20 }}>
        <div style={{ color: muted, fontSize: 13 }}>{nda.studio_name || "Studio"} has asked you to sign</div>
        <h1 style={{ fontSize: 24, margin: "4px 0 0", fontWeight: 600 }}>{nda.title}</h1>
      </header>

      {nda.status === "signed" && (
        <div style={{ background: "rgba(61,220,132,0.1)", border: "1px solid #3DDC84", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <strong style={{ color: "#3DDC84" }}>Signed</strong>
          <span style={{ color: muted, fontSize: 13 }}> on {new Date(nda.signed_at).toLocaleString()}. {nda.studio_name} can now see your signed copy.</span>
          <div style={{ marginTop: 12 }}>
            <button style={{ ...pill(true), fontWeight: 600 }} onClick={() => downloadNdaPdf(nda)}>Download signed copy (PDF)</button>
          </div>
        </div>
      )}
      {closedMsg && (
        <div style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 16, marginBottom: 20, color: muted }}>{closedMsg}</div>
      )}

      <article
        style={{ background: sheet, color: sheetInk, borderRadius: 6, padding: "40px 44px", fontFamily: serif, fontSize: 16, lineHeight: 1.65, whiteSpace: "pre-wrap", boxShadow: "0 12px 32px rgba(0,0,0,0.4)" }}
      >
        {nda.body}
        {nda.status === "signed" && nda.signature_png && (
          <div style={{ marginTop: 28 }}>
            <img src={nda.signature_png} alt="Your signature" style={{ height: 70, display: "block" }} />
            <div style={{ fontWeight: 600 }}>{nda.typed_name}</div>
          </div>
        )}
      </article>

      {open && !declining && (
        <section style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 14px" }}>Sign</h2>
          <label style={{ fontSize: 13, color: muted }} htmlFor="nda-name">Full legal name</label>
          <input
            id="nda-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name"
            style={{ display: "block", width: "100%", boxSizing: "border-box", margin: "6px 0 16px", background: ink, border: `1px solid ${line}`, borderRadius: 8, color: "#EDEAE3", padding: "10px 12px", fontSize: 15, fontFamily: sans }}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button type="button" style={pill(method === "draw")} onClick={() => setMethod("draw")}>Draw</button>
            <button type="button" style={pill(method === "type")} onClick={() => setMethod("type")}>Type</button>
          </div>
          {method === "draw" ? (
            <SignaturePad onChange={setDrawn} />
          ) : (
            <div style={{ background: sheet, color: sheetInk, borderRadius: 8, padding: "26px 20px", fontFamily: script, fontSize: 38, minHeight: 50, overflow: "hidden", whiteSpace: "nowrap" }}>
              {name.trim() || <span style={{ color: "#b9b5aa" }}>Your name</span>}
            </div>
          )}
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "18px 0", fontSize: 13.5, color: "#cfd6d4", cursor: "pointer" }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
            <span>{NDA_CONSENT_TEXT}</span>
          </label>
          {error && <p role="alert" style={{ color: "#E5646B", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button" disabled={!canSign} onClick={sign}
              style={{ background: canSign ? teal : line, color: canSign ? ink : muted, border: "none", borderRadius: 999, padding: "11px 24px", fontWeight: 600, fontSize: 14, cursor: canSign ? "pointer" : "not-allowed", fontFamily: sans }}
            >
              {busy ? "Signing..." : "Sign NDA"}
            </button>
            <button type="button" style={linkBtn} onClick={() => setDeclining(true)}>Decline</button>
          </div>
          <p style={{ color: muted, fontSize: 12, margin: "14px 0 0" }}>
            We record the time, your IP address and browser with your signature as proof of signing.
          </p>
        </section>
      )}

      {open && declining && (
        <section style={{ background: panel, border: `1px solid ${line}`, borderRadius: 10, padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Decline this NDA</h2>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Reason (optional)"
            style={{ width: "100%", boxSizing: "border-box", background: ink, border: `1px solid ${line}`, borderRadius: 8, color: "#EDEAE3", padding: 10, fontFamily: sans, fontSize: 14 }}
          />
          {error && <p role="alert" style={{ color: "#E5646B", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={decline} style={{ ...pill(false), color: "#E5646B", borderColor: "#E5646B" }}>Decline NDA</button>
            <button type="button" style={linkBtn} onClick={() => setDeclining(false)}>Back</button>
          </div>
        </section>
      )}
    </>
  );
}
