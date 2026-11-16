// Content signature for the invoice/expense lists App passes to Finance. App builds fresh filtered arrays on
// every render, so array identity changes constantly; keying the ledger reload on identity restarted the load
// on every unrelated re-render and left Finance stuck on the loader. This signature only changes when the
// content does.
export function sourcesKey(invoices, expenses) {
  const sig = (list) => (list || []).map((o) => Object.keys(o).filter((k) => o[k] == null || typeof o[k] !== "object").map((k) => o[k]).join("~")).join("|");
  return `${sig(invoices)}#${sig(expenses)}`;
}
