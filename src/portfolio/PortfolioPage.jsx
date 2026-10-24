import React, { useEffect, useState } from "react";
import { fetchPublicPortfolio } from "./api.js";
import { isPortfolioToken } from "./logic.js";

// PUBLIC portfolio viewer: /portfolio/{secure-token}. No login. Videos stream and play in the page
// (play/pause/seek/volume via the native controls); there is no download button. The first video
// autoplays MUTED (browsers block autoplay with sound) with a one-tap unmute.
const C = { bg: "#0d0f14", panel: "#171b24", text: "#eef1f6", muted: "#9aa3b2", line: "#262c38" };

export default function PortfolioPage({ token }) {
  const [state, setState] = useState({ phase: "loading", data: null });
  const [index, setIndex] = useState(0);
  const [interacted, setInteracted] = useState(false);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState({});     // itemId -> true when its media couldn't be loaded (shown, never hidden)
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const meta = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    document.title = "Portfolio";
    return () => meta.forEach((m) => m.remove());
  }, []);

  const load = React.useCallback(() => {
    if (!isPortfolioToken(token)) { setState({ phase: "invalid", data: null }); return () => {}; }
    let live = true;
    fetchPublicPortfolio(token)
      .then((d) => { if (live) setState(!d ? { phase: "invalid", data: null } : d.items.length ? { phase: "ready", data: d } : { phase: "empty", data: d }); })
      .catch((e) => { if (live) setState({ phase: "error", data: null, message: e.code === "not_configured" ? "This portfolio isn’t available right now. Please contact the studio." : "" }); })
      .finally(() => live && setReloading(false));
    return () => { live = false; };
  }, [token]);
  useEffect(() => load(), [load]);
  // Fresh media URLs (the old ones expire): refetch and clear the failure flags.
  const retry = () => { setReloading(true); setFailed({}); load(); };

  const { phase, data } = state;
  const items = data?.items || [];
  const cur = items[index];
  const select = (i) => { setInteracted(true); setIndex(i); setMuted(false); };
  const next = () => { if (index < items.length - 1) { setIndex(index + 1); } };

  return (
    <main className="kf-portfolio-page" style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: "20px 16px 40px" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ fontWeight: 700, letterSpacing: "0.06em", fontSize: 13, color: C.muted, marginBottom: 16 }}>{(data?.studioName || "PORTFOLIO").toUpperCase()}</div>
        {phase === "loading" && <p style={{ color: C.muted }}>Loading…</p>}
        {phase === "invalid" && <><h1 style={{ fontSize: 20 }}>This portfolio link isn’t available</h1><p style={{ color: C.muted }}>It may have expired or been withdrawn. Please contact the studio for a new link.</p></>}
        {phase === "error" && <><h1 style={{ fontSize: 20 }}>We couldn’t load this page</h1><p style={{ color: C.muted }}>{state.message || "Please refresh in a moment."}</p></>}
        {phase === "empty" && <><h1 style={{ fontSize: 20 }}>This portfolio is empty</h1><p style={{ color: C.muted }}>The studio hasn’t added any work yet.</p></>}
        {phase === "ready" && cur && (
          <>
            <div style={{ position: "relative", background: "#000", borderRadius: 14, overflow: "hidden", aspectRatio: "16 / 9" }}>
              {failed[cur.id] ? (
                <div role="alert" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", padding: 16 }}>
                  <div>This {cur.kind} couldn’t be loaded.</div>
                  <button type="button" onClick={retry} disabled={reloading} style={{ padding: "8px 14px", borderRadius: 999, border: 0, cursor: "pointer" }}>{reloading ? "Trying…" : "Try again"}</button>
                </div>
              ) : cur.kind === "video" ? (
                <>
                  <video key={cur.id} src={cur.url} autoPlay muted={muted} playsInline controls preload="auto" controlsList="nodownload noplaybackrate" disablePictureInPicture
                    onContextMenu={(e) => e.preventDefault()} onVolumeChange={(e) => setMuted(e.currentTarget.muted)} onEnded={next} onError={() => setFailed((f) => ({ ...f, [cur.id]: true }))}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000" }} />
                  {muted && (
                    <button type="button" onClick={(e) => { setMuted(false); setInteracted(true); const v = e.currentTarget.parentElement.querySelector("video"); if (v) { v.muted = false; v.play().catch(() => {}); } }}
                      style={{ position: "absolute", top: 12, left: 12, padding: "8px 12px", borderRadius: 999, border: 0, background: "rgba(0,0,0,0.65)", color: "#fff", cursor: "pointer", fontSize: 13 }}>
                      🔇 Tap to unmute
                    </button>
                  )}
                </>
              ) : (
                <img key={cur.id} src={cur.url} alt={cur.title || "Portfolio image"} onError={() => setFailed((f) => ({ ...f, [cur.id]: true }))} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
              )}
            </div>
            <h1 style={{ fontSize: 20, margin: "14px 0 4px" }}>{cur.title}</h1>
            {cur.caption && <p style={{ color: C.muted, margin: 0 }}>{cur.caption}</p>}
            {items.length > 1 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginTop: 20 }}>
                {items.map((it, i) => (
                  <button key={it.id} type="button" onClick={() => select(i)} aria-current={i === index}
                    style={{ background: C.panel, color: C.text, border: `2px solid ${i === index ? "#fff" : C.line}`, borderRadius: 10, padding: 0, cursor: "pointer", overflow: "hidden", textAlign: "left" }}>
                    <div style={{ aspectRatio: "16 / 9", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>
                      {failed[it.id] ? "⚠" : it.kind === "image" ? <img src={it.url} alt="" onError={() => setFailed((f) => ({ ...f, [it.id]: true }))} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "▶"}
                    </div>
                    <div style={{ padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title || (it.kind === "video" ? "Video" : "Image")}</div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
