// The only place the Finance V3 screens touch the app: Supabase wiring (RPCs, document download, payment-link address).
// App.jsx loads this lazily and only when VITE_FINANCE_V3_UI is "true" (off by default), so V2 Finance is untouched.
import React, { useCallback, useMemo } from "react";
import { supabase, functionUrl } from "../../supabaseClient";
import { createFinanceApi } from "../api/phase6.js";
import FinanceV3Module from "./FinanceV3Module.jsx";

const DOC_KIND = { invoice: "invoice_pdf", receipt: "receipt_pdf" };

export default function FinanceV3Entry({ organizationId = undefined }) {
  const api = useMemo(() => createFinanceApi((name, args) => supabase.rpc(name, args)), []);
  const downloadDocument = useCallback(async (kind, id) => {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token; if (!token) throw Object.assign(new Error("Please sign in again."), { code: "V3005" });
    const res = await fetch(functionUrl("finance-document"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ organization_id: organizationId, id, kind: DOC_KIND[kind] }) });
    if (!res.ok) throw Object.assign(new Error(res.status === 403 || res.status === 404 ? "That document is not available to you." : "The document could not be prepared."), { code: res.status === 403 ? "V3005" : "V3010" });
    const blob = await res.blob(); const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : `${kind}.pdf`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, [organizationId]);
  const payUrl = useCallback((token) => `${functionUrl("finance-public")}?t=${encodeURIComponent(token)}`, []);
  if (!organizationId) return <div className="fv3"><p style={{ padding: 16 }}>Finance needs a studio. Open or create a studio first.</p></div>;
  return <FinanceV3Module api={api} organizationId={organizationId} downloadDocument={downloadDocument} payUrl={payUrl} />;
}
