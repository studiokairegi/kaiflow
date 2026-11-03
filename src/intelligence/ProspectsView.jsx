import React, { useMemo, useState } from "react";
import { S, T, Pill, Banner, Table } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_STATUS, PROSPECT_TYPES, fmtWhen, statusInfo } from "./logic.js";
import { Input, Muted, Section, Select, useLoad } from "./kit.jsx";
import ProspectModal from "./ProspectModal.jsx";
import AiGeneratedBadge from "./AiGeneratedBadge.jsx";

const LEAD_STATUSES = ["lead_linked", "contacted", "replied", "closed"];

export default function ProspectsView({ mode, supabase, tick, onChanged, onOpenLead }) {
  const pros = useLoad(() => intelApi.prospects(supabase), [supabase, tick]);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(null);
  const ids = useMemo(() => (pros.data || []).filter((p) => p.lead_id).map((p) => p.lead_id), [pros.data]);
  const leads = useLoad(() => intelApi.leadsFor(supabase, ids), [supabase, ids.join(",")]);
  const leadById = useMemo(() => new Map((leads.data || []).map((l) => [l.id, l])), [leads.data]);

  const rows = (pros.data || []).filter((p) => {
    if (mode === "qualified" && !(p.status === "qualified" || p.lead_id || LEAD_STATUSES.includes(p.status))) return false;
    if (type && p.type !== type) return false;
    if (status && p.status !== status) return false;
    if (q && !`${p.name} ${p.domain} ${p.contact_email}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const statusOptions = [["", "All statuses"], ...Object.entries(PROSPECT_STATUS).map(([k, v]) => [k, v.label])];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {pros.error && <Banner tone="bad">{pros.error}</Banner>}
      <Section title={mode === "qualified" ? "Qualified leads" : "Discovered prospects"}
        hint={mode === "qualified" ? "Prospects that passed qualification, and the CRM leads created or linked for them." : "Everything the agent has found, with its current status."}>
        <div style={S.row}>
          <Input placeholder="Search name, site or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
          <Select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 240 }} options={[["", "Both campaigns"], ...Object.entries(PROSPECT_TYPES)]} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }} options={statusOptions} />
          <Muted>{rows.length} shown</Muted>
        </div>
        <Table rowKey={(r) => r.id} onRow={setOpen} empty={pros.loading ? "Loading…" : "No prospects match."} rows={rows}
          columns={[
            { key: "name", label: "Name", render: (r) => <span><b>{r.name}</b>{leadById.get(r.lead_id)?.source_kind === "ai_intelligence" && <AiGeneratedBadge />}</span> },
            { key: "type", label: "Campaign", render: (r) => PROSPECT_TYPES[r.type] },
            { key: "status", label: "Status", render: (r) => <Pill tone={statusInfo(r.status).tone}>{statusInfo(r.status).label}</Pill> },
            { key: "score", label: "Score", num: true, render: (r) => r.score ?? "-" },
            ...(mode === "qualified" ? [{ key: "stage", label: "CRM stage", render: (r) => leadById.get(r.lead_id)?.stage || "-" }] : []),
            { key: "updated_at", label: "Updated", render: (r) => <span style={{ color: T.muted }}>{fmtWhen(r.updated_at)}</span> },
          ]} />
      </Section>
      {open && <ProspectModal prospect={open} supabase={supabase} onClose={() => setOpen(null)} onChanged={async () => { await pros.reload(); await onChanged(); }} onOpenLead={onOpenLead} />}
    </div>
  );
}
