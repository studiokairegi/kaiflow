import { useCallback, useEffect, useState } from "react";
import { loadPaymentsData } from "./api.js";

// Loads Payments data once and exposes reload(). Used by the Payments tab and the Dashboard.
export function usePayments(userId) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await loadPaymentsData();
      setState({ loading: false, error: "", data });
    } catch (e) {
      console.error("Payments load failed:", e);
      setState((s) => ({ ...s, loading: false, error: e?.message || "Couldn't load Payments." }));
    }
  }, [userId]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}
