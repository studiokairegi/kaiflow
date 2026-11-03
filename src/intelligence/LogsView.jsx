import React, { useState } from "react";
import { S, T, Pill, Banner, Table } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { fmtWhen } from "./logic.js";
import { Muted, Section, Select, useLoad } from "./kit.jsx";

export default function LogsView({ supabase, tick }) {
  const acts = useLoad(() => intelApi.actions(supabase), [supabase, tick]);
  const jobs = useLoad(() => intelApi.jobs(supabase), [supabase, tick]);
  const [who, setWho] = useState("");
  const rows = (acts.data || []).filter((a) => !who || a.actor === who);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(acts.error || jobs.error) && <Banner tone="bad">{acts.error || jobs.error}</Banner>}
      <Section title="Jobs" hint="Queued and running work, and anything that failed. Failed jobs retry automatically; dead ones need a look.">
        <Table rowKey={(r) => r.id} empty={jobs.loading ? "Loading…" : "No active or failed jobs."} rows={jobs.data || []}
          columns={[
            { key: "kind", label: "Job" },
            { key: "state", label: "State", render: (r) => <Pill tone={r.state === "dead" ? "bad" : r.state === "failed" ? "warn" : "info"}>{r.state}</Pill> },
            { key: "attempts", label: "Tries", num: true, render: (r) => `${r.attempts}/${r.max_attempts}` },
            { key: "last_error", label: "Last error", render: (r) => <span style={{ color: T.muted }}>{r.last_error || "-"}</span> },
            { key: "updated_at", label: "Updated", render: (r) => fmtWhen(r.updated_at) },
          ]} />
      </Section>
      <Section title="Agent activity" hint="Every action by the agent or by you, newest first. This log cannot be edited or deleted."
        action={<Select value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 160 }} options={[["", "Everyone"], ["agent", "Agent"], ["admin", "You"], ["system", "System"]]} />}>
        <Table rowKey={(r) => r.id} empty={acts.loading ? "Loading…" : "Nothing logged yet."} rows={rows}
          columns={[
            { key: "created_at", label: "When", render: (r) => fmtWhen(r.created_at) },
            { key: "actor", label: "Who", render: (r) => <Pill tone={r.actor === "agent" ? "info" : "muted"}>{r.actor}</Pill> },
            { key: "action", label: "Action" },
            { key: "entity_type", label: "On", render: (r) => <span style={{ color: T.muted }}>{r.entity_type}</span> },
          ]} />
        <Muted>{rows.length} entries shown (latest 300).</Muted>
      </Section>
    </div>
  );
}
