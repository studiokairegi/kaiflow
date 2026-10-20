import React, { useEffect, useState } from "react";
import { formatMoney } from "../finance/currency.js";
import { getPublicCheckout } from "./api.js";
import { isCheckoutToken } from "./providers.js";

// PUBLIC checkout page: /pay/{secure-token}. No login. Provider-agnostic: it renders whatever
// methods the server says are available and contains no provider-specific logic.
// DESIGN SHELL ONLY: selecting a method does not start a payment yet (no provider is implemented).
const page = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f5f6f8", color: "#14181f", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: 16 };
const card = { background: "#fff", borderRadius: 16, boxShadow: "0 8px 30px rgba(0,0,0,0.08)", padding: 28, width: "100%", maxWidth: 440 };

const MESSAGES = {
  notfound: ["This payment link isn’t valid", "Check the link you were sent, or contact StudioKairegi for a new one."],
  expired: ["This payment link has expired", "Please contact StudioKairegi and we’ll send you a new one."],
  cancelled: ["This payment link is no longer active", "Please contact StudioKairegi if you think this is a mistake."],
  paid: ["This invoice has been paid", "Thank you. Nothing more is due."],
  failed: ["This payment couldn’t be completed", "Please contact StudioKairegi."],
  error: ["We couldn’t load this page", "Please try again in a moment."],
};

export default function PayCheckoutPage({ token }) {
  const [state, setState] = useState({ phase: "loading", data: null });
  const [chosen, setChosen] = useState(null);

  useEffect(() => {
    // The token is a credential: keep it out of search engines and out of Referer headers.
    const meta = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    document.title = "Pay invoice · StudioKairegi";
    return () => meta.forEach((m) => m.remove());
  }, []);

  useEffect(() => {
    if (!isCheckoutToken(token)) { setState({ phase: "notfound", data: null }); return; }
    let live = true;
    getPublicCheckout(token)
      .then((d) => { if (live) setState({ phase: d?.found ? (d.status === "open" ? "open" : d.status) : "notfound", data: d }); })
      .catch(() => { if (live) setState({ phase: "error", data: null }); });
    return () => { live = false; };
  }, [token]);

  const { phase, data } = state;
  const msg = MESSAGES[phase];
  return (
    <main style={page}>
      <div style={card}>
        <div style={{ fontWeight: 700, letterSpacing: "0.04em", fontSize: 13, color: "#5b6472", marginBottom: 18 }}>STUDIOKAIREGI</div>
        {phase === "loading" && <p>Loading…</p>}
        {msg && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{msg[0]}</h1><p style={{ color: "#5b6472", margin: 0 }}>{msg[1]}</p></>}
        {phase === "open" && data && (
          <>
            <p style={{ margin: 0, color: "#5b6472", fontSize: 14 }}>Invoice {data.invoice_number}{data.client_name ? ` · ${data.client_name}` : ""}</p>
            <div style={{ fontSize: 34, fontWeight: 700, margin: "6px 0 18px" }}>{formatMoney(data.currency, data.amount)}</div>
            {data.methods?.length ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Choose how to pay</div>
                {data.methods.map((m) => (
                  <button key={m.provider} type="button" onClick={() => setChosen(m)}
                    style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", marginBottom: 8, borderRadius: 12, border: `2px solid ${m.primary ? "#14181f" : "#d7dbe2"}`, background: "#fff", cursor: "pointer", fontSize: 15, fontFamily: "inherit" }}>
                    <span>{m.name}</span>{m.primary && <span style={{ fontSize: 12, color: "#5b6472" }}>Recommended</span>}
                  </button>
                ))}
                {chosen && <p role="status" style={{ color: "#5b6472", fontSize: 13 }}>{chosen.name} checkout isn’t enabled yet.</p>}
              </>
            ) : (
              <p style={{ color: "#5b6472", margin: 0 }}>Online payment isn’t available for this invoice yet. Please contact StudioKairegi to arrange payment.</p>
            )}
            <p style={{ color: "#8a93a1", fontSize: 12, marginTop: 20 }}>Link valid until {new Date(data.expires_at).toLocaleDateString()}.</p>
          </>
        )}
      </div>
    </main>
  );
}
