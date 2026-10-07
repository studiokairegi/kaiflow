// Supabase access for Finance. All writes that touch the ledger go through RPCs
// (atomic, server-validated). Direct table access here is read-only, apart from
// the user's own settings / FX snapshots / custom accounts / contacts.
import { supabase } from "../supabaseClient";

const PAGE = 1000;
async function fetchAll(table, { select = "*", order, ascending = true } = {}) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (order) q = q.order(order, { ascending });
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

export async function loadLedger() {
  const settings = await rpc("finance_init"); // creates settings + default chart of accounts on first use
  const [accounts, entries, lines, bankAccounts, invoicePayments, bills, billPayments, billShots, contacts, reconciliations, audit, fxRates] = await Promise.all([
    fetchAll("chart_accounts", { order: "code" }),
    fetchAll("journal_entries", { order: "entry_no" }),
    fetchAll("journal_lines", { order: "id" }),
    fetchAll("bank_accounts", { order: "created_at" }),
    fetchAll("invoice_payments", { order: "paid_date", ascending: false }),
    fetchAll("bills", { order: "issue_date", ascending: false }),
    fetchAll("bill_payments", { order: "paid_date", ascending: false }),
    fetchAll("bill_shots"),
    fetchAll("finance_contacts", { order: "name" }),
    fetchAll("bank_reconciliations", { order: "created_at", ascending: false }),
    supabase.from("finance_audit_log").select("*").order("at", { ascending: false }).limit(200).then((r) => r.data || []),
    supabase.from("fx_rates").select("*").order("rate_date", { ascending: false }).limit(200).then((r) => r.data || []),
  ]);
  return { settings, accounts, entries, lines, bankAccounts, invoicePayments, bills, billPayments, billShots, contacts, reconciliations, audit, fxRates };
}

export async function savePrivacy(userId, on) {
  const { error } = await supabase.from("finance_settings").update({ privacy_mode: !!on }).eq("user_id", userId);
  if (error) throw error;
}

export async function saveDefaultBank(userId, bankId) {
  const { error } = await supabase.from("finance_settings").update({ default_bank_account_id: bankId || null }).eq("user_id", userId);
  if (error) throw error;
}

// Stores today's live rates (units per 1 USD) so entries posted today can be stamped
// with a real transaction-date rate. Existing snapshots are never overwritten.
export async function saveFxSnapshot(userId, rates, updatedAt) {
  if (!userId || !rates || !Object.keys(rates).length) return;
  const date = (updatedAt ? new Date(updatedAt) : new Date()).toISOString().slice(0, 10);
  const rows = ["EUR", "GBP", "JPY", "KES"].filter((c) => rates[c] > 0).map((c) => ({ user_id: userId, rate_date: date, currency: c, per_usd: rates[c], source: "open.er-api.com" }));
  if (!rows.length) return;
  await supabase.from("fx_rates").upsert(rows, { onConflict: "user_id,currency,rate_date", ignoreDuplicates: true });
}

export async function saveManualFxRate(userId, { date, currency, perUsd }) {
  const { error } = await supabase.from("fx_rates").upsert([{ user_id: userId, rate_date: date, currency, per_usd: perUsd, source: "manual" }], { onConflict: "user_id,currency,rate_date" });
  if (error) throw error;
}

export async function addAccount(userId, { code, name, type, taxDeductible }) {
  const { error } = await supabase.from("chart_accounts").insert({ user_id: userId, code, name, type, subtype: "custom", tax_deductible: taxDeductible !== false });
  if (error) throw error;
}

export async function listBankAccounts() {
  const { data, error } = await supabase.from("bank_accounts").select("id,name,currency,archived,kind").order("created_at");
  if (error) throw error;
  return (data || []).filter((b) => !b.archived);
}

export function download(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
