import React, { useState } from "react";
import { Banner, Button, Card, Stat, useFinance, useResource } from "../shared/kit.jsx";

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function LegacyHistory() {
  const { api, org, can } = useFinance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [archiveOutcome, setArchiveOutcome] = useState(null);
  const [invoiceError, setInvoiceError] = useState(null);
  const [invoiceOutcome, setInvoiceOutcome] = useState(null);
  const [invoiceRunId, setInvoiceRunId] = useState(null);
  const [invoiceReport, setInvoiceReport] = useState(null);
  const [cutoffDate, setCutoffDate] = useState(localToday);
  const report = useResource(() => can("finance.admin") ? api.legacyHistoryReport(org) : Promise.resolve(null), [api, org, can]);

  if (!can("finance.admin")) {
    return <Banner tone="info" title="Finance admin access required.">Legacy migration is restricted to Finance administrators.</Banner>;
  }

  const prepareInvoices = async () => {
    setBusy(true); setInvoiceError(null); setInvoiceOutcome(null); setInvoiceReport(null); setInvoiceRunId(null);
    try {
      const started = await api.startLegacyInvoiceRun(org, cutoffDate, "Controlled Finance V2 to V3 migration");
      if (!started?.run_id) throw new Error("Finance did not return a migration run ID.");
      const records = await api.extractLegacyInvoices(org);
      if (!Array.isArray(records)) throw new Error("The legacy invoice extractor did not return a record list.");
      await api.stageLegacyInvoices(org, started.run_id, records);
      const validated = await api.validateLegacyInvoiceRun(org, started.run_id);
      setInvoiceRunId(started.run_id);
      setInvoiceReport(validated);
      setInvoiceOutcome({ extracted: records.length, runId: started.run_id });
    } catch (e) {
      setInvoiceError(e?.message || "Legacy invoices could not be prepared.");
    } finally {
      setBusy(false);
    }
  };

  const importInvoices = async () => {
    if (!invoiceRunId) return;
    setBusy(true); setInvoiceError(null); setInvoiceOutcome(null);
    try {
      const imported = await api.importLegacyInvoiceRun(org, invoiceRunId, false);
      setInvoiceReport(imported);
      setInvoiceOutcome({ runId: invoiceRunId, report: imported });
    } catch (e) {
      setInvoiceError(e?.message || "Validated legacy invoices could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  const refreshInvoiceReport = async () => {
    if (!invoiceRunId) return;
    setBusy(true); setInvoiceError(null);
    try {
      setInvoiceReport(await api.legacyInvoiceMigrationReport(org, invoiceRunId));
    } catch (e) {
      setInvoiceError(e?.message || "The invoice migration report could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const importHistory = async () => {
    setBusy(true); setError(null); setArchiveOutcome(null);
    try {
      const result = await api.importLegacyHistory(org);
      setArchiveOutcome(result);
      await report.reload();
    } catch (e) {
      setError(e?.message || "Legacy transaction history could not be archived.");
    } finally {
      setBusy(false);
    }
  };

  const d = report.data || {};
  const counts = invoiceReport?.counts || {};
  const validCount = Number(counts.valid || 0);
  const problemRows = Array.isArray(invoiceReport?.problems) ? invoiceReport.problems : [];
  const importedCount = Number(counts.imported || 0);

  return (<div className="stack">
    <Card title="Legacy invoice migration" sub="Stage, validate and import the V2 invoices through your signed-in Finance session. This creates the V3 receivable documents and opening balances for outstanding amounts only.">
      <Banner tone="info">Paid-to-date values are preserved as opening paid amounts. The process does not recreate historic revenue or cash entries. Invoice numbers may repeat; the legacy source ID is the unique identity.</Banner>
      <div className="field">
        <label htmlFor="fin3-legacy-cutoff">Opening balance date</label>
        <input id="fin3-legacy-cutoff" type="date" value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)} />
      </div>
      <div className="row">
        <Button kind="primary" busy={busy} disabled={!cutoffDate} onClick={prepareInvoices}>Prepare and validate V2 invoices</Button>
        <Button disabled={busy || !invoiceRunId} onClick={refreshInvoiceReport}>Refresh invoice report</Button>
      </div>
      {invoiceReport && <div className="stack">
        <h4>Invoice migration run · {invoiceReport.status || "validated"}</h4>
        <div className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
          <Stat label="Valid to import" value={String(validCount)} />
          <Stat label="Imported" value={String(importedCount)} />
          <Stat label="Problems / skipped" value={String(problemRows.length + Number(counts.invalid || 0) + Number(counts.duplicate || 0) + Number(counts.skipped || 0) + Number(counts.failed || 0))} />
        </div>
        {Array.isArray(invoiceReport.by_currency) && invoiceReport.by_currency.length > 0 && <div className="stack">
          <h4>Opening balance reconciliation by currency</h4>
          {invoiceReport.by_currency.map((x, i) => <div key={i} className="row" style={{ justifyContent: "space-between" }}>
            <span>{x.currency}</span>
            <span>V2 outstanding {x.legacy_open_total} · V3 imported {x.imported_open_total} · ledger {x.ledger_opening_total}</span>
          </div>)}
        </div>}
        {problemRows.length > 0 && <details>
          <summary>Review invoice records needing attention ({problemRows.length})</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(problemRows, null, 2)}</pre>
        </details>}
        <div className="row">
          <Button kind="primary" busy={busy} disabled={!invoiceRunId || validCount < 1 || invoiceReport.status === "imported"} onClick={importInvoices}>Import validated invoices</Button>
        </div>
      </div>}
      {invoiceOutcome && <Banner tone="ok" title={invoiceOutcome.report ? "Invoice import finished." : "Invoice validation finished."}>
        {invoiceOutcome.report
          ? `Run ${invoiceOutcome.runId}: ${importedCount} invoices imported. Review the currency reconciliation and any problem records before cutover.`
          : `${invoiceOutcome.extracted} V2 invoice records staged and validated. ${validCount} are ready to import.`}
      </Banner>}
      {invoiceError && <Banner tone="critical" title="Invoice migration failed.">{invoiceError}</Banner>}
    </Card>

    <Card title="Legacy transaction history" sub="Preserves posted V2 payment and expense records with their original journal evidence. This archive does not create V3 ledger entries.">
      <Banner tone="info">V2 contains 8 posted payments and 13 posted expenses. These records are archived separately because paid-to-date amounts are already carried by the invoice migration; reposting their historic ledger activity would double-count it.</Banner>
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
        <Button kind="primary" busy={busy} disabled={report.loading} onClick={importHistory}>Import / refresh transaction history</Button>
        <Button disabled={busy} onClick={report.reload}>Refresh counts</Button>
      </div>
      {archiveOutcome && <Banner tone="ok" title="Legacy history archive complete.">{archiveOutcome.inserted} new records saved: {archiveOutcome.payments_inserted} payments and {archiveOutcome.expenses_inserted} expenses. No V3 ledger entries were posted.</Banner>}
      {error && <Banner tone="critical" title="Archive failed.">{error}</Banner>}
      {report.error && <Banner tone="warning">{report.error.message || "Could not load archive counts."}</Banner>}
      <p className="sub">The transaction archive is safe to rerun. Existing source records are not duplicated.</p>
    </Card>
  </div>);
}
