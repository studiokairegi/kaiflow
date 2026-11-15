import React, { useCallback, useEffect, useRef, useState } from "react";
import { S, T, Banner } from "../finance/ui.jsx";
import { confirmAction, Muted } from "./kit.jsx";
import { EMMA_LAUNCH_URL, emmaSwitch } from "./logic.js";

const CONTROL_URL = "http://127.0.0.1:17843";
export const CONTROLLER_TOKEN_STORAGE_KEY = "kairflow.intelligence.controller-token.v1";
const POLL_MS = 5000;
const LAUNCH_POLL_MS = 2000;
const LAUNCH_GIVE_UP_MS = 60000;

const readToken = () => { try { return (window.localStorage.getItem(CONTROLLER_TOKEN_STORAGE_KEY) || "").trim(); } catch { return ""; } };

/** Ask the local controller. Resolves { reachable, authFailed, status }. A network failure means the controller is not running. */
async function probeController(method = "GET", path = "/api/status") {
  const token = readToken();
  if (!token) {
    // Cannot tell "off" from "unpaired" without a token: a reachable controller answers 401 to a tokenless request.
    try {
      const r = await fetch(`${CONTROL_URL}/api/status`, { mode: "cors", credentials: "omit", cache: "no-store" });
      return { reachable: true, authFailed: r.status === 401 || r.status === 403, status: null };
    } catch { return { reachable: false, authFailed: false, status: null }; }
  }
  try {
    const r = await fetch(`${CONTROL_URL}${path}`, {
      method, mode: "cors", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { reachable: true, authFailed: true, status: null, error: data.error };
    if (!r.ok || !data.ok) return { reachable: true, authFailed: false, status: null, error: data.error || `The controller answered ${r.status}.` };
    return { reachable: true, authFailed: false, status: data };
  } catch { return { reachable: false, authFailed: false, status: null }; }
}

/** One switch for Emma. Off = worker and controller both stop. On = start the controller if needed, then the worker. */
export default function EmmaSwitch({ compact = false }) {
  const [probe, setProbe] = useState({ reachable: false, authFailed: false, status: null });
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [launchTimedOut, setLaunchTimedOut] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  // set to true in the effect body too: React StrictMode (dev) runs mount, cleanup, mount, and the cleanup alone would leave this false forever
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    const p = await probeController();
    if (alive.current) setProbe(p);
    return p;
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(() => { if (!launching && !stopping) refresh(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh, launching, stopping]);

  const view = emmaSwitch({ ...probe, launching, stopping, launchTimedOut });

  const turnOff = async () => {
    if (!confirmAction("Turn Emma completely off? The worker and the background controller will stop. Nothing is lost: queued work simply waits until you switch Emma on again.")) return;
    setError(""); setStopping(true);
    const r = await probeController("POST", "/api/shutdown");
    if (!r.reachable && alive.current) { setStopping(false); setProbe(r); return; }       // the controller may close before its reply arrives: that is success
    if (r.error && alive.current) setError(r.error);
    // wait until it stops answering
    for (let i = 0; i < 10 && alive.current; i += 1) {
      await new Promise((res) => window.setTimeout(res, 800));
      const p = await probeController();
      if (!p.reachable) { setProbe(p); break; }
    }
    if (alive.current) { setStopping(false); await refresh(); }
  };

  const startWorker = async () => {
    if (!confirmAction("Start Emma on this computer? The worker will resume its configured queue. If email sending is enabled and the emergency stop is OFF, approved messages may be sent under your existing limits.")) return;
    setError("");
    const r = await probeController("POST", "/api/start");
    if (r.error) setError(r.error);
    await refresh();
  };

  const launch = async () => {
    if (!confirmAction("Turn Emma on? This starts the background controller and the worker on this computer. If email sending is enabled and the emergency stop is OFF, approved messages may be sent under your existing limits.")) return;
    setError(""); setLaunchTimedOut(false); setLaunching(true);
    try {
      // An anchor click hands the link to Windows without navigating this page away (assigning window.location can replace the app in some browsers).
      const a = document.createElement("a"); a.href = EMMA_LAUNCH_URL; a.style.display = "none"; document.body.appendChild(a); a.click();
      window.setTimeout(() => a.remove(), 1000);
    } catch { /* handled by the timeout message */ }
    const until = Date.now() + LAUNCH_GIVE_UP_MS;
    let p = null;
    while (alive.current && Date.now() < until) {
      await new Promise((res) => window.setTimeout(res, LAUNCH_POLL_MS));
      p = await probeController();
      if (p.reachable) break;
    }
    if (!alive.current) return;
    if (p?.reachable && !p.authFailed && p.status && !p.status.worker_running) { p = await probeController("POST", "/api/start"); }
    setLaunching(false);
    if (!p?.reachable) setLaunchTimedOut(true);
    if (p) setProbe(p);
  };

  const click = () => {
    if (view.busy) return;
    if (view.action === "shutdown") turnOff();
    else if (view.action === "start") startWorker();
    else if (view.action === "launch") launch();
  };

  const color = { ok: T.ok, warn: T.warn, info: T.info, muted: T.muted }[view.tone] || T.muted;
  const enabled = !view.busy && Boolean(view.action);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ ...S.row, gap: 14, alignItems: "center" }}>
        <button type="button" role="switch" aria-checked={view.on} aria-label="Emma on or off" disabled={!enabled} onClick={click}
          style={{ width: compact ? 52 : 64, height: compact ? 28 : 34, borderRadius: 999, border: "none", padding: 3, cursor: enabled ? "pointer" : "default", opacity: enabled || view.busy ? 1 : 0.5,
                   background: view.on ? T.ok : "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: view.on ? "flex-end" : "flex-start", transition: "background .2s" }}>
          <span style={{ width: compact ? 22 : 28, height: compact ? 22 : 28, borderRadius: "50%", background: "#fff", display: "block", boxShadow: "0 1px 3px rgba(0,0,0,.4)" }} />
        </button>
        <div>
          <div style={{ fontWeight: 600, fontSize: compact ? 14 : 16, color }}>{view.label}</div>
          {!compact && <div style={{ color: T.muted, fontSize: 12 }}>{view.detail}</div>}
        </div>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {compact && view.state === "off" && <Muted>{view.detail}</Muted>}
    </div>
  );
}
