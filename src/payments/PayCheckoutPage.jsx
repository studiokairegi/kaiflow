import React, { useEffect, useRef, useState } from "react";
import { formatMoney } from "../finance/currency.js";
import { getPublicCheckout, startPublicCheckout, confirmPublicCheckout } from "./api.js";
import { isCheckoutToken, COMING_SOON_LABEL } from "./providers.js";

// PUBLIC hosted checkout: /pay/{secure-token} (and /pay/{token}/return after Paystack).
// No login. The page never sends an amount, currency, invoice id or environment: it sends the token,
// the chosen method and an email. Success is shown ONLY when the server reports it after verifying
// the transaction with Paystack; the browser redirect and its query string prove nothing.
const page = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f5f6f8", color: "#14181f", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: 16 };
const card = { background: "#fff", borderRadius: 16, boxShadow: "0 8px 30px rgba(0,0,0,0.08)", padding: 28, width: "100%", maxWidth: 440 };
const muted = { color: "#5b6472", margin: 0 };

const MESSAGES = {
  notfound: ["This payment link isn’t valid", "Check the link you were sent, or contact StudioKairegi for a new one."],
  expired: ["This payment link has expired", "Please contact StudioKairegi and we’ll send you a new one."],
  cancelled: ["This payment link is no longer active", "Please contact StudioKairegi if you think this is a mistake."],
  paid: ["This invoice has been paid", "Thank you. Nothing more is due."],
  failed: ["This payment couldn’t be completed", "Nothing was charged to you for this link. Please contact StudioKairegi."],
  error: ["We couldn’t load this page", "Please try again in a moment."],
};

function Shell({ children }) {
  useEffect(() => {
    // The token is a credential: keep it out of search engines and out of Referer headers.
    const meta = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    document.title = "Pay invoice · StudioKairegi";
    return () => meta.forEach((m) => m.remove());
  }, []);
  return (
    <main style={page}>
      <div style={card}>
        <div style={{ fontWeight: 700, letterSpacing: "0.04em", fontSize: 13, color: "#5b6472", marginBottom: 18 }}>STUDIOKAIREGI</div>
        {children}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ return page (after Paystack)
function ReturnView({ token }) {
  const [res, setRes] = useState({ status: "checking" });
  const tries = useRef(0);
  const reference = useRef(new URLSearchParams(window.location.search).get("reference") || "");   // only a lookup hint, never proof
  useEffect(() => {
    let live = true; let timer;
    const check = async () => {
      try {
        const r = await confirmPublicCheckout(token, reference.current);
        if (!live) return;
        setRes(r);
        // Keep asking while the server says it is still waiting (bank transfers can take a few minutes).
        if (r.status === "pending" && tries.current++ < 30) timer = setTimeout(check, 4000);
      } catch (e) {
        if (live) setRes({ status: "error", message: e.message });
      }
    };
    check();
    return () => { live = false; clearTimeout(timer); };
  }, [token]);

  const back = <p style={{ marginTop: 16 }}><a href={`/pay/${token}`} style={{ color: "#14181f" }}>Back to the payment page</a></p>;
  const s = res.status;
  return (
    <Shell>
      {s === "checking" && <p role="status">Confirming your payment with Paystack…</p>}
      {s === "paid" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Payment received</h1><p style={muted}>Thank you. Invoice {res.invoice_number} — {formatMoney(res.currency, res.amount)} — has been confirmed and marked paid.</p>{res.reference && <p style={{ ...muted, fontSize: 12, marginTop: 12 }}>Reference: {res.reference}</p>}</>}
      {s === "paid_elsewhere" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>This invoice is settled</h1><p style={muted}>Nothing more is due on invoice {res.invoice_number}.</p></>}
      {s === "pending" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>We’re waiting for confirmation</h1><p role="status" style={muted}>Your payment hasn’t been confirmed yet. This can take a few minutes for bank transfers. You don’t need to pay again; this page updates automatically, and the payment is recorded as soon as Paystack confirms it, even if you close this window.</p></>}
      {s === "incomplete" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Payment not completed</h1><p style={muted}>No payment was taken. You can go back and try again.</p>{back}</>}
      {s === "failed" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>The payment didn’t go through</h1><p style={muted}>Your payment was declined or cancelled and the invoice has not been marked paid. You can try again.</p>{back}</>}
      {s === "review" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>We’re checking your payment</h1><p style={muted}>{res.message}</p></>}
      {s === "notfound" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{MESSAGES.notfound[0]}</h1><p style={muted}>{MESSAGES.notfound[1]}</p></>}
      {s === "error" && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>We couldn’t check your payment</h1><p style={muted}>Please refresh this page in a moment. If you already paid, it will be recorded automatically.</p></>}
    </Shell>
  );
}

// ------------------------------------------------------------------ checkout page
function CheckoutView({ token }) {
  const [state, setState] = useState({ phase: "loading", data: null });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");          // channel being started
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inflight = useRef(false);                 // blocks double-clicks within this tab; the server blocks the rest

  useEffect(() => {
    if (!isCheckoutToken(token)) { setState({ phase: "notfound", data: null }); return; }
    let live = true;
    getPublicCheckout(token)
      .then((d) => { if (live) setState({ phase: d?.found ? d.status : "notfound", data: d }); })
      .catch(() => { if (live) setState({ phase: "error", data: null }); });
    return () => { live = false; };
  }, [token]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const pay = async (m) => {
    if (inflight.current || !m.enabled) return;
    if (!emailOk) { setError("Enter your email address so Paystack can send your receipt."); return; }
    inflight.current = true; setBusy(m.channel); setError(""); setNotice("");
    try {
      const r = await startPublicCheckout(token, email.trim(), m.channel);
      if (r.status === "redirect" && r.authorization_url) { window.location.assign(r.authorization_url); return; }   // keep the button locked while leaving
      if (r.status === "paid") { window.location.assign(`/pay/${token}/return?reference=${encodeURIComponent(r.reference || "")}`); return; }
      setNotice(r.message || "A payment for this invoice is already in progress.");
    } catch (e) {
      setError(e.message || "We couldn’t start the payment. Please try again.");
    }
    inflight.current = false; setBusy("");
  };

  const { phase, data } = state;
  const msg = MESSAGES[phase];
  const live = phase === "open" || phase === "pending";
  return (
    <Shell>
      {phase === "loading" && <p>Loading…</p>}
      {msg && <><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{msg[0]}</h1><p style={muted}>{msg[1]}</p></>}
      {live && data && (
        <>
          <p style={{ margin: 0, color: "#5b6472", fontSize: 14 }}>Invoice {data.invoice_number}{data.client_name ? ` · ${data.client_name}` : ""}</p>
          <div style={{ fontSize: 34, fontWeight: 700, margin: "6px 0 18px" }}>{formatMoney(data.currency, data.amount)}</div>
          {phase === "pending" && <p role="status" style={{ background: "#fff7e6", border: "1px solid #f0d9a8", borderRadius: 10, padding: "10px 12px", fontSize: 14, margin: "0 0 14px" }}>A payment for this invoice is in progress. <a href={`/pay/${token}/return`} style={{ color: "#14181f" }}>Check its status</a> before paying again.</p>}
          <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }} htmlFor="payer-email">Email for your receipt</label>
          <input id="payer-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
            style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "1px solid #d7dbe2", fontSize: 15, marginBottom: 16, fontFamily: "inherit" }} />
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Choose how to pay</div>
          {data.methods?.map((m) => {
            const loading = busy === m.channel;
            return (
              <button key={m.channel} type="button" disabled={!m.enabled || !!busy} aria-disabled={!m.enabled} onClick={() => pay(m)}
                style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", marginBottom: 8, borderRadius: 12, border: `2px solid ${m.enabled ? "#14181f" : "#e3e6ea"}`, background: m.enabled ? "#fff" : "#f1f2f4", color: m.enabled ? "#14181f" : "#9aa1ad", cursor: m.enabled && !busy ? "pointer" : "not-allowed", fontSize: 15, fontFamily: "inherit", textAlign: "left" }}>
                <span>{m.name}{!m.enabled && <span style={{ display: "block", fontSize: 12, marginTop: 2 }}>{m.note || COMING_SOON_LABEL}</span>}</span>
                {m.enabled && <span style={{ fontSize: 12, color: "#5b6472" }}>{loading ? "Opening Paystack…" : "via Paystack"}</span>}
              </button>
            );
          })}
          {!data.methods?.some((m) => m.enabled) && <p style={{ color: "#5b6472", margin: "8px 0 0", fontSize: 14 }}>Online payment isn’t available for this invoice right now. Please contact StudioKairegi to arrange payment.</p>}
          {error && <p role="alert" style={{ color: "#b3261e", fontSize: 14, margin: "8px 0 0" }}>{error}</p>}
          {notice && <p role="status" style={{ color: "#5b6472", fontSize: 14, margin: "8px 0 0" }}>{notice}</p>}
          <p style={{ color: "#8a93a1", fontSize: 12, marginTop: 20 }}>Payments are processed by Paystack on its own secure page; card details never reach StudioKairegi. Link valid until {new Date(data.expires_at).toLocaleDateString()}.</p>
        </>
      )}
    </Shell>
  );
}

export default function PayCheckoutPage({ token, view = "checkout" }) {
  if (!isCheckoutToken(token)) return <Shell><h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{MESSAGES.notfound[0]}</h1><p style={muted}>{MESSAGES.notfound[1]}</p></Shell>;
  return view === "return" ? <ReturnView token={token} /> : <CheckoutView token={token} />;
}
