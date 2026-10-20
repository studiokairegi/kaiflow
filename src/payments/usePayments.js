import { useCallback, useEffect, useState } from "react";
import { loadPaymentsData } from "./api.js";

// Loads Payments data once and exposes reload(). Used by the Payments tab and the Dashboard.
// `enabled` is false for non-admins: no request is made at all (the server would refuse it anyway).
export function usePayments(userId, enabled = true) {
  const [state, setState] = useState({ loading: enabled, error: "", data: null });
  const reload = useCallback(async () => {
    if (!userId || !enabled) return;
    try {
      const data = await loadPaymentsData();
      setState({ loading: false, error: "", data });
    } catch (e) {
      console.error("Payments load failed:", e);
      setState((s) => ({ ...s, loading: false, error: e?.message || "Couldn't load Payments." }));
    }
  }, [userId, enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}
