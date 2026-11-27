// Finance V3 entry point. Props: { api (createFinanceApi), organizationId, downloadDocument(kind, id) -> Promise<void> }.
// The mode switch only changes the screens shown (it is saved per user); it never writes a financial record.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FinanceContext, FinanceStyles, ErrorState, Skeleton, useToasts, useResource } from "./shared/kit.jsx";
import { DEFAULT_UI_MODE } from "../contracts/index.js";
import SimpleMode from "./simple/SimpleMode.jsx";
import AccountantMode from "./accountant/AccountantMode.jsx";

export default function FinanceV3Module({ api = undefined, organizationId = undefined, downloadDocument = undefined, payUrl = undefined }) {
  const [pushToast, toastNode] = useToasts();
  const prefs = useResource(() => api.getUiPrefs(organizationId), [api, organizationId]);
  const perms = useResource(() => api.myPermissions(organizationId), [api, organizationId]);
  const [mode, setMode] = useState(null); const [saveErr, setSaveErr] = useState(null);
  useEffect(() => { if (prefs.data && mode === null) setMode(prefs.data.mode || DEFAULT_UI_MODE); }, [prefs.data, mode]);
  const changeMode = useCallback(async (m) => {
    const before = mode; setMode(m); setSaveErr(null);
    try { await api.setUiMode(organizationId, m); } catch (e) { setMode(before); setSaveErr(e); }
  }, [api, organizationId, mode]);
  const ctx = useMemo(() => ({ api, org: organizationId, perms: perms.data || [], can: (p) => (perms.data || []).includes(p), toast: pushToast, downloadDocument, payUrl, mode, setMode: changeMode, saveErr }),
    [api, organizationId, perms.data, pushToast, downloadDocument, payUrl, mode, changeMode, saveErr]);
  return (<div className="fv3" data-testid="finance-v3"><FinanceStyles />
    {(prefs.loading && !prefs.data) || (perms.loading && !perms.data) ? <div style={{ padding: 16 }}><Skeleton lines={5} /></div>
      : prefs.error && !prefs.data ? <ErrorState error={prefs.error} onRetry={prefs.reload} title="Finance could not be opened" />
      : perms.error && !perms.data ? <ErrorState error={perms.error} onRetry={perms.reload} title="Finance could not be opened" />
      : <FinanceContext.Provider value={ctx}>{mode === "accountant" ? <AccountantMode /> : <SimpleMode />}</FinanceContext.Provider>}
    {toastNode}</div>);
}
