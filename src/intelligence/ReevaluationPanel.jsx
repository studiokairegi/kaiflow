import React, { useEffect, useState } from "react";
import { intelApi } from "./api.js";

export default function ReevaluationPanel({ supabase, tick }) {
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [name, setName] = useState("Studio rejected-prospect reevaluation");
  const [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const result = await intelApi.reevalStatus(supabase);
      setStatus(result);
    } catch (e) { setError(e.message || "Could not load reevaluation status"); }
  };

  useEffect(() => { refresh(); }, [supabase, tick]);

  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(e.message || "Reevaluation request failed"); }
    finally { setBusy(false); }
  };

  const doPreview = () => run(async () => {
    const result = await intelApi.reevalStart(supabase, { name, dryRun: true });
    setPreview(result);
  });

  const startPilot = () => run(async () => {
    if (!name.trim()) throw new Error("Enter a run name first.");
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    const result = await intelApi.reevalStart(supabase, {
      name, limit: n, dryRun: false, all: false, expectCount: null,
    });
    setPreview(result);
  });

  const startFull = () => run(async () => {
    if (!name.trim()) throw new Error("Enter a run name first.");
    const fresh = await intelApi.reevalStart(supabase, { name, dryRun: true });
    setPreview(fresh);
    const count = Number(fresh?.eligible || 0);
    if (!count) throw new Error("There are no eligible prospects to reevaluate.");
    if (!window.confirm(`This will queue all ${count} eligible rejected studio prospects. Human-rejected, contacted, linked and suppressed prospects are excluded. Continue?`)) return;
    const result = await intelApi.reevalStart(supabase, {
      name, limit: null, dryRun: false, all: true, expectCount: count,
    });
    setPreview(result);
  });

  const cancel = () => {
    const runId = status?.run?.id;
    if (!runId) return;
    if (!window.confirm("Cancel this reevaluation run?")) return;
    run(async () => { await intelApi.reevalCancel(supabase, runId); });
  };

  const runInfo = status?.run;
  const counts = status?.by_state || {};
  const active = runInfo?.state === "running";

  return (
    <section style={{ border: "1px solid var(--border, #444)", borderRadius: 10, padding: 16, display: "grid", gap: 12 }}>
      <div>
        <h3 style={{ margin: 0 }}>Rejected studio prospect reevaluation</h3>
        <p style={{ margin: "6px 0 0", opacity: .75 }}>
          Rechecks previously rejected discovered animation studios. It does not send emails or create CRM leads.
        </p>
      </div>
      {error && <div role="alert" style={{ color: "#d66" }}>{error}</div>}
      <label style={{ display: "grid", gap: 5 }}>
        Run name
        <input value={name} maxLength={80} onChange={e => setName(e.target.value)} disabled={busy || active}
          style={{ padding: 9, borderRadius: 6, border: "1px solid var(--border, #777)", background: "transparent", color: "inherit" }} />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <button disabled={busy || active} onClick={doPreview}>Preview eligible prospects</button>
        <label style={{ display: "grid", gap: 4 }}>
          Pilot size
          <input type="number" min="1" max="50" value={limit} onChange={e => setLimit(e.target.value)}
            style={{ width: 85, padding: 7 }} disabled={busy || active} />
        </label>
        <button disabled={busy || active} onClick={startPilot}>Start pilot</button>
        <button disabled={busy || active} onClick={startFull}>Start full run</button>
        <button disabled={busy || !active} onClick={cancel}>Cancel active run</button>
        <button disabled={busy} onClick={() => run(refresh)}>Refresh status</button>
      </div>
      {preview && <div>
        <b>Latest preview / start result</b>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{JSON.stringify(preview, null, 2)}</pre>
      </div>}
      <div>
        <b>Latest run</b>
        {runInfo ? <>
          <p style={{ margin: "6px 0" }}>{runInfo.name} | <b>{runInfo.state}</b></p>
          <p style={{ margin: "6px 0", fontSize: 13 }}>
            Queued: {counts.queued || 0} | Scored: {counts.scored || 0} | Skipped: {counts.skipped || 0} |
            Manual review: {counts.needs_manual || 0} | Failed: {counts.failed || 0}
          </p>
          <p style={{ margin: "6px 0", fontSize: 12, opacity: .7 }}>Run ID: {runInfo.id}</p>
          {status?.queued_items_without_live_job > 0 &&
            <p style={{ color: "#d99b42" }}>Warning: {status.queued_items_without_live_job} queued items have no live worker job.</p>}
        </> : <p style={{ opacity: .7 }}>No reevaluation runs yet.</p>}
      </div>
    </section>
  );
}
