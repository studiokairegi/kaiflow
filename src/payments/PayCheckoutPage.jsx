import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "../finance/currency.js";
import { getPublicCheckout, startPublicCheckout, confirmPublicCheckout } from "./api.js";
import { isCheckoutToken } from "./providers.js";

const BRAND = {
  ink: "#11161b",
  inkSoft: "#1a2228",
  paper: "#f4f3ee",
  white: "#ffffff",
  muted: "#68737a",
  line: "#dfe3df",
  accent: "#2fbfa6",
  accentSoft: "#e9f7f4",
  danger: "#a84848",
  warning: "#8a691e",
};

const page = {
  minHeight: "100vh",
  background: `radial-gradient(circle at 20% 0%, ${BRAND.accentSoft} 0, transparent 34%), ${BRAND.paper}`,
  color: BRAND.ink,
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  padding: "28px 18px",
  boxSizing: "border-box",
};

const shell = { width: "100%", maxWidth: 920, margin: "0 auto" };
const card = { background: BRAND.white, border: `1px solid ${BRAND.line}`, borderRadius: 24, boxShadow: "0 24px 70px rgba(17,22,27,.10)", overflow: "hidden" };
const muted = { color: BRAND.muted, margin: 0, lineHeight: 1.55 };
const label = { fontSize: 12, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: BRAND.muted };

const MESSAGES = {
  notfound: ["Payment link unavailable", "Check the link you were sent, or contact Studio Kairegi for a new one."],
  expired: ["Payment link expired", "Contact Studio Kairegi and we’ll send you a new link."],
  cancelled: ["Payment link inactive", "Contact Studio Kairegi if you think this is a mistake."],
  paid: ["Invoice already paid", "Thank you. Nothing more is due."],
  error: ["We couldn’t load this page", "Please try again in a moment."],
};

function formatExpiry(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(d);
}

function Shell({ children }) {
  useEffect(() => {
    const meta = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    document.title = "Secure payment · Studio Kairegi";
    return () => meta.forEach((m) => m.remove());
  }, []);
  return (
    <main style={page}>
      <div style={shell}>{children}</div>
    </main>
  );
}

function BrandHeader() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "22px 24px", borderBottom: `1px solid ${BRAND.line}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src="/logo.png" alt="Studio Kairegi" style={{ width: 42, height: 42, objectFit: "contain" }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: ".04em" }}>STUDIO KAIREGI</div>
          <div style={{ color: BRAND.muted, fontSize: 12, marginTop: 2 }}>Secure client checkout</div>
        </div>
      </div>
      <div style={{ ...label, color: BRAND.accent }}>Payment</div>
    </div>
  );
}

function SecurityNote({ expiresAt }) {
  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${BRAND.line}`, display: "flex", flexWrap: "wrap", gap: "8px 20px", color: BRAND.muted, fontSize: 12.5 }}>
      <span><strong style={{ color: BRAND.ink }}>Secure checkout by Paystack</strong></span>
      <span>Your payment is processed securely by Paystack. Studio Kairegi never receives your card details.</span>
      {expiresAt && <span>Link expires {formatExpiry(expiresAt)}.</span>}
    </div>
  );
}

function ReturnView({ token }) {
  const [res, setRes] = useState({ status: "checking" });
  const tries = useRef(0);
  const reference = useRef(new URLSearchParams(window.location.search).get("reference") || "");
  useEffect(() => {
    let live = true; let timer;
    const check = async () => {
      try {
        const r = await confirmPublicCheckout(token, reference.current);
        if (!live) return;
        setRes(r);
        if (r.status === "pending" && tries.current++ < 30) timer = setTimeout(check, 4000);
      } catch (e) {
        if (live) setRes({ status: "error", message: e.message });
      }
    };
    check();
    return () => { live = false; clearTimeout(timer); };
  }, [token]);

  const back = <a href={`/pay/${token}`} style={{ color: BRAND.ink, fontWeight: 700 }}>Return to payment</a>;
  return (
    <Shell>
      <div style={card}>
        <BrandHeader />
        <div style={{ padding: "42px 34px 36px", maxWidth: 660 }}>
          {res.status === "checking" && <><div style={label}>Checking payment</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>Confirming your payment</h1><p role="status" style={muted}>We’re verifying the transaction with Paystack. Please don’t make another payment while this is checking.</p></>}
          {res.status === "paid" && <><div style={{ ...label, color: BRAND.accent }}>Payment received</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>Thank you.</h1><p style={muted}>Invoice <strong>{res.invoice_number}</strong> for <strong>{formatMoney(res.currency, res.amount)}</strong> has been confirmed and marked paid.</p>{res.reference && <p style={{ ...muted, fontSize: 12, marginTop: 16 }}>Reference: {res.reference}</p>}</>}
          {res.status === "paid_elsewhere" && <><div style={{ ...label, color: BRAND.accent }}>Invoice settled</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>Nothing more is due.</h1><p style={muted}>Invoice <strong>{res.invoice_number}</strong> has already been settled.</p></>}
          {res.status === "pending" && <><div style={{ ...label, color: BRAND.warning }}>Payment pending</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>We’re waiting for confirmation.</h1><p role="status" style={muted}>Your payment hasn’t been confirmed yet. Bank transfers can take a few minutes. This page will keep checking automatically; you do not need to pay again.</p></>}
          {res.status === "incomplete" && <><div style={label}>Payment not completed</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>No payment was taken.</h1><p style={muted}>You can return to the payment page and try again.</p><p style={{ marginTop: 20 }}>{back}</p></>}
          {res.status === "failed" && <><div style={{ ...label, color: BRAND.danger }}>Payment unsuccessful</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>The payment didn’t go through.</h1><p style={muted}>The invoice has not been marked paid. You can return and try again.</p><p style={{ marginTop: 20 }}>{back}</p></>}
          {res.status === "review" && <><div style={{ ...label, color: BRAND.warning }}>Payment under review</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>We’re checking your payment.</h1><p style={muted}>{res.message || "Please do not pay again while we verify the transaction."}</p></>}
          {res.status === "notfound" && <><div style={{ ...label, color: BRAND.danger }}>Link unavailable</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>{MESSAGES.notfound[0]}</h1><p style={muted}>{MESSAGES.notfound[1]}</p></>}
          {res.status === "error" && <><div style={{ ...label, color: BRAND.danger }}>Couldn’t confirm</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>Please try again.</h1><p style={muted}>If you already paid, the transaction will be recorded automatically once Paystack confirms it.</p></>}
        </div>
      </div>
    </Shell>
  );
}

function CheckoutView({ token }) {
  const [state, setState] = useState({ phase: "loading", data: null });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [applePaySupported, setApplePaySupported] = useState(false);
  const inflight = useRef(false);

  useEffect(() => {
    if (!isCheckoutToken(token)) { setState({ phase: "notfound", data: null }); return; }
    let live = true;
    getPublicCheckout(token)
      .then((d) => { if (live) setState({ phase: d?.found ? d.status : "notfound", data: d }); })
      .catch(() => { if (live) setState({ phase: "error", data: null }); });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const Session = window.ApplePaySession;
        if (!Session || typeof Session.canMakePayments !== "function") return;
        const ok = await Session.canMakePayments();
        if (mounted) setApplePaySupported(!!ok);
      } catch { if (mounted) setApplePaySupported(false); }
    };
    check();
    return () => { mounted = false; };
  }, []);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const { phase, data } = state;
  const live = phase === "open" || phase === "pending";
  const methods = useMemo(() => (data?.methods || []).filter((m) => m.channel !== "apple_pay" || applePaySupported), [data, applePaySupported]);

  const pay = async (m) => {
    if (inflight.current || !m.enabled) return;
    if (!emailOk) { setError("Enter your email address so Paystack can send your receipt."); return; }
    inflight.current = true; setBusy(m.channel); setError(""); setNotice("");
    try {
      const r = await startPublicCheckout(token, email.trim(), m.channel);
      if (r.status === "redirect" && r.authorization_url) { window.location.assign(r.authorization_url); return; }
      if (r.status === "paid") { window.location.assign(`/pay/${token}/return?reference=${encodeURIComponent(r.reference || "")}`); return; }
      setNotice(r.message || "A payment for this invoice is already in progress.");
    } catch (e) {
      setError(e.message || "We couldn’t start the payment. Please try again.");
    }
    inflight.current = false; setBusy("");
  };

  return (
    <Shell>
      <div style={card}>
        <BrandHeader />
        {phase === "loading" && <div style={{ padding: 36 }}><p style={muted}>Loading secure payment details…</p></div>}
        {MESSAGES[phase] && <div style={{ padding: "42px 34px" }}><div style={{ ...label, color: BRAND.danger }}>Unavailable</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>{MESSAGES[phase][0]}</h1><p style={muted}>{MESSAGES[phase][1]}</p></div>}
        {live && data && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 380px)" }}>
            <section style={{ padding: "42px 34px", borderRight: `1px solid ${BRAND.line}` }}>
              <div style={label}>Payment request</div>
              <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", lineHeight: .98, letterSpacing: "-.04em", margin: "12px 0 16px" }}>{formatMoney(data.currency, data.amount)}</h1>
              <p style={{ ...muted, fontSize: 15 }}>Invoice <strong style={{ color: BRAND.ink }}>{data.invoice_number}</strong>{data.client_name ? ` · ${data.client_name}` : ""}</p>
              {phase === "pending" && <div role="status" style={{ background: "#fff8e8", border: "1px solid #ecd9a7", color: BRAND.warning, borderRadius: 14, padding: 14, marginTop: 24, fontSize: 13.5, lineHeight: 1.5 }}>A payment for this invoice is already in progress. <a href={`/pay/${token}/return`} style={{ color: BRAND.ink, fontWeight: 700 }}>Check its status</a> before paying again.</div>}
              <div style={{ marginTop: 28, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}><span style={muted}>Currency</span><strong>{data.currency}</strong></div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}><span style={muted}>Link expiry</span><strong>{formatExpiry(data.expires_at)}</strong></div>
              </div>
              <SecurityNote expiresAt={data.expires_at} />
            </section>
            <section style={{ padding: "34px 28px" }}>
              <div style={label}>Checkout</div>
              <h2 style={{ fontSize: 22, margin: "8px 0 20px" }}>Choose how to pay</h2>
              <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 7 }} htmlFor="payer-email">Email for your receipt</label>
              <input id="payer-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
                style={{ width: "100%", boxSizing: "border-box", padding: "13px 14px", borderRadius: 12, border: `1px solid ${error ? "#d58a8a" : BRAND.line}`, fontSize: 15, fontFamily: "inherit", outline: "none" }} />
              {error && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: "7px 0 0" }}>{error}</p>}
              <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
                {methods.map((m) => {
                  const loading = busy === m.channel;
                  const isApple = m.channel === "apple_pay";
                  return (
                    <button key={m.channel} type="button" disabled={!m.enabled || !!busy} onClick={() => pay(m)}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", minHeight: 54, padding: "13px 15px", borderRadius: 13, border: `1px solid ${m.enabled ? BRAND.ink : BRAND.line}`, background: m.enabled ? BRAND.ink : "#f4f5f3", color: m.enabled ? BRAND.white : "#9ba3a5", cursor: m.enabled && !busy ? "pointer" : "not-allowed", fontSize: 14.5, fontWeight: 700, fontFamily: "inherit", textAlign: "left" }}>
                      <span>{isApple ? "Apple Pay" : m.name}</span><span style={{ fontSize: 12, fontWeight: 600, opacity: .75 }}>{loading ? "Opening…" : "Pay securely"}</span>
                    </button>
                  );
                })}
              </div>
              {data.methods?.some((m) => m.channel === "apple_pay" && m.enabled) && !applePaySupported && <p style={{ ...muted, fontSize: 12, marginTop: 12 }}>Apple Pay is available on supported Apple devices and Safari.</p>}
              {notice && <p role="status" style={{ background: BRAND.accentSoft, border: `1px solid ${BRAND.accent}55`, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.45, marginTop: 14 }}>{notice}</p>}
              {methods.length === 0 && <p style={{ ...muted, marginTop: 14, fontSize: 13 }}>Online payment is not available for this invoice right now. Please contact Studio Kairegi.</p>}
            </section>
          </div>
        )}
      </div>
    </Shell>
  );
}

export default function PayCheckoutPage({ token, view = "checkout" }) {
  return view === "return" ? <ReturnView token={token} /> : <CheckoutView token={token} />;
}
