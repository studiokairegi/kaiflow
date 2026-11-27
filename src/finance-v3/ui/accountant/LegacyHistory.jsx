import React, { useState } from "react";
import { Banner, Button, Card, Stat, useFinance, useResource } from "../shared/kit.jsx";

export default function LegacyHistory() {
  const { api, org, can } = useFinance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const report = useResource(() => can("finance.admin") ? api.legacyHistoryReport(org) : Promise.resolve(null), [api, org, can]);

  const run = async () => {
    setBusy(true); setError(null); setOutcome(null);
    try {
      const result = await api.importLegacyHistory(org);
      setOutcome(result);
      await report.reload();
    } catch (e) {
      setError(e?.message || "Legacy history could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  if (!can("finance.admin")) {
    return <Banner tone="info" title="Finance admin access required.">Legacy history migration is restricted to Finance administrators.</Banner>;
  }

  const d = report.data || {};
  return (<div className="stack">
    <Card title="Legacy transaction history" sub="Preserves posted V2 payment and expense records with their original journal evidence. This archive does not create V3 ledger entries.">
      <Banner tone="info">Paid-to-date amounts are already carried by the invoice migration. Reposting historical payment or expense entries would double-count the V2 ledger activity, so these records are archived separately.</Banner>
      <div className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        <Stat label="Archived payments" value={String(d.payments ?? "—")} />
        <Stat label="Archived expenses" value={String(d.expenses ?? "—")} />
        <Stat label="Total archived records" value={String(d.total ?? "—")} />
      </div>
      {Array.isArray(d.by_currency) && d.by_currency.length > 0 && <div className="stack">
        <h4>Archived amounts by currency</h4>
        {d.by_currency.map((x, i) => <div key={i} className="row" style={{ justifyContent: "space-between" }}>
          <span>{x.kind} · {x.currency}</span><strong>{x.count} records · {x.amount}</strong>
        </div>)}
      </div>}
      <div className="row">
        <Button kind="primary" busy={busy} disabled={!can("finance.admin") || report.loading} onClick={run}>Import / refresh legacy history</Button>
        <Button disabled={busy} onClick={report.reload}>Refresh counts</Button>
      </div>
      {outcome && <Banner tone="ok" title="Legacy history archive complete.">{outcome.inserted} new records saved: {outcome.payments_inserted} payments and {outcome.expenses_inserted} expenses. No V3 ledger entries were posted.</Banner>}
      {error && <Banner tone="critical" title="Import failed.">{error}</Banner>}
      {report.error && <Banner tone="warning">{report.error.message || "Could not load archive counts."}</Banner>}
      <p className="sub">This action is safe to rerun. Existing source records are not duplicated.</p>
    </Card>
  </div>);
}
