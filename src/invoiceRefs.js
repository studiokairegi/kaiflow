import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "./supabaseClient";
import { fetchAllPages } from "./pagedFetch.js";

// Display-only lookup: invoice id -> the Paystack transaction code (e.g. KRL-L-DFBB9B9C-F2FC3497BA) of its
// latest posted Paystack payment. Invoice numbers stay in the database; the UI shows this code instead.
// Read-only, owner-scoped by RLS. An invoice with no Paystack payment has no code.
let refs = new Map();
let version = 0;
let inflight = null;
let rerun = false;   // a refresh was requested while one was running: run once more so it sees the newest payments
const subs = new Set();
const emit = () => { version += 1; subs.forEach((f) => f()); };

export function refreshInvoiceRefs() {
  if (inflight) { rerun = true; return inflight; }
  inflight = (async () => {
    try {
      // Every page, in a stable order, so the newest payments are never cut off by the API row cap.
      const { data, error } = await fetchAllPages(() => supabase.from("invoice_payments").select("invoice_id,reference,paid_date,status,method").eq("method", "Paystack").eq("status", "posted").order("paid_date", { ascending: true }).order("id", { ascending: true }));
      if (error || !Array.isArray(data)) return;
      const next = new Map();
      for (const r of data) if (r.invoice_id && r.reference) next.set(r.invoice_id, r.reference); // later rows win
      refs = next;
      emit();
    } catch { /* display-only: fall back to no code */ } finally {
      inflight = null;
      if (rerun) { rerun = false; refreshInvoiceRefs(); }
    }
  })();
  return inflight;
}

export const invoiceRefFor = (invoice) => (invoice && refs.get(invoice.id)) || "";

// `dep` changes when the caller's invoices change (e.g. one was just paid), which triggers a refresh.
export function useInvoiceRefs(dep = "") {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  useEffect(() => { refreshInvoiceRefs(); }, [dep]);
  return invoiceRefFor;
}
