import React, { useState } from "react";
import { Async, Banner, Button, Card, DataTable, Dialog, EmptyState, Stat, useFinance, useResource } from "../shared/kit.jsx";
import { Money } from "../shared/parts.jsx";

// One project's finance records, grouped by shot/stage where records have been linked. Links are the only thing written here.
function ProjectDetail({ project = undefined, onClose = undefined }) {
  const { api, org } = useFinance(); const res = useResource(() => api.projectFinanceDetail(org, project.project_id), [api, org, project.project_id]);
  const t = (title, rows, cols) => <Card title={title}><DataTable caption={title} rows={rows} rowKey={(r, i) => r.id ?? i} columns={cols} empty={<EmptyState title={`No ${title.toLowerCase()} yet`} />} /></Card>;
  return (<Dialog title={project.project_name || "Project"} onClose={onClose} wide footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
    <Async res={res}>{(d) => (<div className="stack">
      {t("Expenses", d.expenses, [{ key: "expense_no", header: "No." }, { key: "description", header: "What" }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={project.currency} /> }, { key: "date", header: "Date" }])}
      {t("Animator work", d.animator_work, [{ key: "work_ref", header: "Work" }, { key: "status", header: "Status" }, { key: "approved", header: "Approved", num: true, render: (r) => <Money value={r.approved} /> }, { key: "outstanding", header: "Still owed", num: true, render: (r) => <Money value={r.outstanding} /> }])}
      {t("Shots and stages", d.by_shot, [{ key: "shot_id", header: "Shot", render: (r) => r.shot_id || "—" }, { key: "stage", header: "Stage", render: (r) => r.stage || "—" }, { key: "records", header: "Records", num: true }])}</div>)}</Async></Dialog>);
}
export default function Projects() {
  const [open, setOpen] = useState(null);
  const { api, org } = useFinance(); const [offset, setOffset] = useState(0);
  const res = useResource(() => api.listProjectFinancials(org, { limit: 20, offset }), [api, org, offset]);
  return (<div className="stack"><h2>Project profit</h2><p className="sub">Is each project making money? Figures come from invoices, approved animator work and expenses tagged to the project.</p>
    <Async res={res} empty={Object.assign((d) => !d || d.length === 0, { node: <EmptyState title="No projects set up for finance yet">Add a contract value and budget to a project to see its profit here.</EmptyState> })}>{(rows) => (<>
      <div className="grid2">{rows.map((p) => { const c = p.currency; return (<Card key={p.project_id} title={p.project_name || `Project ${String(p.project_id).slice(0, 8)}`}>
        <div className="row"><Button small kind="ghost" onClick={() => setOpen(p)}>See details</Button></div>
        {(p.warnings || []).map((w, i) => <Banner key={i} tone="warning">{w}</Banner>)}
        <div className="grid"><Stat label="Profit so far" value={<Money value={p.accounting?.profit} currency={c} />} sub={p.accounting?.margin_percent ? `${p.accounting.margin_percent}% margin` : undefined} tone={String(p.accounting?.profit).startsWith("-") ? "bad" : undefined} />
          <Stat label="Invoiced" value={<Money value={p.contract?.invoiced} currency={c} />} sub={`Contract ${p.contract?.contract_value}`} />
          <Stat label="Client has paid" value={<Money value={p.contract?.client_payments_received} currency={c} />} />
          <Stat label="Costs so far" value={<Money value={p.costs?.actual_costs} currency={c} />} sub={`Committed ${p.costs?.committed_costs}`} />
          <Stat label="Still owed to animators" value={<Money value={p.animators?.outstanding_obligations} currency={c} />} />
          <Stat label="Budget left" value={p.budget?.remaining == null ? "No budget set" : <Money value={p.budget.remaining} currency={c} />} /></div></Card>); })}</div>
{open && <ProjectDetail project={open} onClose={() => setOpen(null)} />}<div className="row" style={{ justifyContent: "space-between" }}><Button small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><Button small disabled={rows.length < 20} onClick={() => setOffset(offset + 20)}>Next</Button></div></>)}</Async></div>);
}
