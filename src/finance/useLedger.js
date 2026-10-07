import { todayLocal } from "./currency.js";
import { useState, useEffect, useCallback, useMemo } from "react";
import { loadLedger, savePrivacy } from "./api.js";
import { buildPostings, dashboardSummary } from "./reports.js";

// Loads the ledger once and exposes it with derived postings. Reload after any write.
export function useLedger(userId) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await loadLedger();
      setState({ loading: false, error: "", data });
    } catch (e) {
      console.error("Finance load failed:", e);
      setState((s) => ({ ...s, loading: false, error: e?.message || "Couldn't load Finance." }));
    }
  }, [userId]);
  useEffect(() => { reload(); }, [reload]);
  const postings = useMemo(() => (state.data ? buildPostings(state.data) : []), [state.data]);
  const privacy = !!state.data?.settings?.privacy_mode;
  const setPrivacy = useCallback(async (on) => {
    setState((s) => (s.data ? { ...s, data: { ...s.data, settings: { ...s.data.settings, privacy_mode: on } } } : s));
    try { await savePrivacy(userId, on); } catch (e) { console.error("Saving privacy preference failed:", e); }
  }, [userId]);
  return { ...state, postings, privacy, setPrivacy, reload };
}

// Dashboard-facing summary. invoices/projects come from the app; amounts come from the ledger.
export function useFinanceSummary(userId, invoices, projects) {
  const ledger = useLedger(userId);
  const summary = useMemo(() => {
    if (!ledger.data) return null;
    const projectById = new Map((projects || []).map((p) => [p.id, p]));
    const docsAR = (invoices || []).map((i) => ({ id: i.id, number: i.invoiceNumber, dueDate: i.dueDate, party: projectById.get(i.projectId)?.client || "", projectId: i.projectId }));
    const docsAP = (ledger.data.bills || []).map((b) => ({ id: b.id, number: b.bill_number, dueDate: b.due_date || b.issue_date, party: b.vendor_name, projectId: b.project_id }));
    return dashboardSummary(ledger.data, { today: todayLocal(), docsAR, docsAP });
  }, [ledger.data, invoices, projects]);
  return { ...ledger, summary };
}
