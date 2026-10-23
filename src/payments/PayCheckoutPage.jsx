import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "../finance/currency.js";
import { getPublicCheckout, startPublicCheckout, confirmPublicCheckout, getCheckoutQuote, startWiseTransfer, submitWiseTransfer } from "./api.js";
import { isCheckoutToken } from "./providers.js";
import { describeRate, quoteSecondsLeft, quoteIsLive, needsRequote } from "./quote.js";
import { orderMethods, wiseInstructions } from "./wise.js";

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

function SecurityNote({ expiresAt, wise }) {
  return (
    <p style={{ margin: "18px 0 0", paddingTop: 14, borderTop: `1px solid ${BRAND.line}`, color: BRAND.muted, fontSize: 12, lineHeight: 1.5 }}>
      {wise ? "Studio Kairegi never receives your Wise login or card details." : "Card and bank details are entered on Paystack’s secure page; Studio Kairegi never receives them."}
      {expiresAt ? ` Link expires ${formatExpiry(expiresAt)}.` : ""}
    </p>
  );
}

// Official provider artwork is not bundled with the app. Drop the provider's own SVG at /public/brand/<id>.svg and it is used;
// until then the provider name is shown as plain text (never a look-alike logo).
function ProviderMark({ id, name }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span style={{ fontWeight: 800, letterSpacing: ".01em" }}>{name}</span>;
  return <img src={`/brand/${id}.svg`} alt={name} onError={() => setBroken(true)} style={{ height: 18, width: "auto", display: "block" }} />;
}

const ICONS = {
  card: <><rect x="2.5" y="5.5" width="19" height="13" rx="2.5" /><path d="M2.5 10h19M6.5 15h4" /></>,
  bank_transfer: <><path d="M3 9.5 12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18" /></>,
  apple_pay: <><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
  wise: <><path d="M3 12h13M12 7l5 5-5 5M21 5v14" /></>,
};
function MethodIcon({ kind, color }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[kind] || ICONS.card}</svg>;
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

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const row = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 14, fontSize: 13.5, padding: "7px 0" };
const primaryBtn = (disabled) => ({ width: "100%", minHeight: 52, padding: "13px 16px", borderRadius: 14, border: "none", background: disabled ? "#9ba3a5" : BRAND.ink, color: BRAND.white, fontSize: 15, fontWeight: 800, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer" });
const ghostBtn = { background: "none", border: "none", padding: 0, color: BRAND.muted, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline" };

function QuoteSummary({ quote, data }) {
  const inv = quote.invoice_currency;
  if (!quote.converted) {
    return (
      <div>
        <div style={row}><span style={muted}>Amount due now</span><strong>{formatMoney(inv, quote.invoice_amount)}</strong></div>
        <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6, paddingTop: 12 }}><strong>You will be charged</strong><strong style={{ fontSize: 20 }}>{formatMoney(quote.charge_currency, quote.charge_amount)}</strong></div>
      </div>
    );
  }
  return (
    <div>
      <p style={{ ...muted, fontSize: 13.5, marginBottom: 10 }}>This invoice is in <strong style={{ color: BRAND.ink }}>{inv}</strong>. Paystack takes payment in <strong style={{ color: BRAND.ink }}>{quote.charge_currency}</strong>, so your payment is converted before you pay.</p>
      <div style={row}><span style={muted}>Invoice amount</span><strong>{formatMoney(inv, data.original_amount)}</strong></div>
      <div style={row}><span style={muted}>Amount you’re paying now</span><strong>{formatMoney(inv, quote.invoice_amount)}</strong></div>
      <div style={row}><span style={muted}>Exchange rate</span><strong>{describeRate(quote.fx_base, quote.fx_quote, quote.fx_rate)}</strong></div>
      <div style={row}><span style={muted}>Rate as of</span><span>{fmtTime(quote.fx_rate_fetched_at)}</span></div>
      <div style={row}><span style={muted}>Converted amount</span><strong>{formatMoney(quote.charge_currency, quote.converted_amount)}</strong></div>
      <div style={row}><span style={muted}>Conversion fee or markup</span><span>{Number(quote.fee_amount) > 0 || Number(quote.markup_pct) > 0 ? `${formatMoney(quote.charge_currency, quote.fee_amount)} (${quote.markup_pct}%)` : "None"}</span></div>
      <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6, paddingTop: 12 }}><strong>Paystack will charge</strong><strong style={{ fontSize: 20 }}>{formatMoney(quote.charge_currency, quote.charge_amount)}</strong></div>
    </div>
  );
}

function CopyRow({ label: l, value }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); } };
  return (
    <div style={{ ...row, alignItems: "center" }}>
      <span style={muted}>{l}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "right", wordBreak: "break-word" }}><strong>{value}</strong><button type="button" onClick={copy} style={ghostBtn} aria-label={`Copy ${l}`}>{done ? "Copied" : "Copy"}</button></span>
    </div>
  );
}

function WisePanel({ token, data, email, onBack }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ transferReference: "", payerName: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    let live = true;
    startWiseTransfer(token, email.trim()).then((r) => { if (live) { setT(r.transfer); setSubmitted(r.transfer?.status === "submitted"); } }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [token]);
  const submit = async () => {
    setBusy(true); setErr("");
    try { await submitWiseTransfer(token, { reference: t.reference, ...form }); setSubmitted(true); }
    catch (e) { setErr(e.message || "We couldn’t record that. Please try again."); }
    setBusy(false);
  };
  if (err && !t) return <div><p role="alert" style={{ color: BRAND.danger, fontSize: 13.5 }}>{err}</p><button type="button" style={ghostBtn} onClick={onBack}>Back to payment options</button></div>;
  if (!t) return <p style={muted}>Preparing your transfer details…</p>;
  const ins = wiseInstructions(t);
  if (submitted) {
    return (
      <div role="status">
        <div style={{ ...label, color: BRAND.warning }}>Transfer submitted</div>
        <h2 style={{ fontSize: 22, margin: "8px 0 10px" }}>We’ll confirm once the money arrives.</h2>
        <p style={muted}>Invoice <strong style={{ color: BRAND.ink }}>{t.invoice_number}</strong> stays open until Studio Kairegi confirms the funds. Keep reference <strong style={{ color: BRAND.ink }}>{t.reference}</strong> for any questions{t.support_contact ? ` — contact ${t.support_contact}` : ""}.</p>
        <p style={{ marginTop: 18 }}><button type="button" style={ghostBtn} onClick={onBack}>Back to payment options</button></p>
      </div>
    );
  }
  return (
    <div>
      <div style={label}>Wise · Manual transfer</div>
      <h2 style={{ fontSize: 22, margin: "8px 0 6px" }}>Send with Wise to M-PESA</h2>
      <div style={{ background: "#fff8e8", border: "1px solid #ecd9a7", color: BRAND.warning, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.5, margin: "10px 0 14px" }}>{ins.warnings[0]}</div>
      <CopyRow label="Recipient name" value={t.recipient_name} />
      <div style={row}><span style={muted}>Country</span><strong>{t.country}</strong></div>
      <div style={row}><span style={muted}>Mobile provider</span><strong>{t.mobile_provider}</strong></div>
      <CopyRow label="Mobile number" value={t.phone} />
      <CopyRow label="Our reference" value={t.reference} />
      <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6 }}><span style={muted}>Invoice amount</span><strong>{formatMoney(data.currency, t.original_amount)}</strong></div>
      <div style={row}><span style={muted}>Remaining due</span><strong>{formatMoney(data.currency, t.invoice_outstanding)}</strong></div>
      <div style={row}><span style={muted}>Amount expected</span><strong>{formatMoney(t.currency, t.amount)}</strong></div>
      <p style={{ ...muted, fontSize: 12.5 }}>Wise delivers Kenyan shillings (KES) to M-PESA. Wise shows the amount the recipient gets before you pay; make sure it matches {formatMoney(t.currency, t.amount)} at the exchange rate Wise shows you. If you’re unsure, contact us first.{t.instructions ? ` ${t.instructions}` : ""}</p>
      <ol style={{ paddingLeft: 18, margin: "10px 0 14px", fontSize: 13, lineHeight: 1.55 }}>{ins.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <p style={{ ...muted, fontSize: 12.5 }}>{ins.warnings[1]} {ins.warnings[2]}</p>
      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 700 }} htmlFor="wise-ref">Wise transfer reference</label>
        <input id="wise-ref" value={form.transferReference} onChange={(e) => setForm({ ...form, transferReference: e.target.value })} placeholder="From your Wise confirmation" style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${BRAND.line}`, fontSize: 15, fontFamily: "inherit" }} />
        <input aria-label="Your name (optional)" value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} placeholder="Your name (optional)" style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${BRAND.line}`, fontSize: 15, fontFamily: "inherit" }} />
        {err && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: 0 }}>{err}</p>}
        <button type="button" disabled={busy || form.transferReference.trim().length < 4} onClick={submit} style={primaryBtn(busy || form.transferReference.trim().length < 4)}>{busy ? "Submitting…" : "I’ve sent the transfer"}</button>
        <button type="button" style={ghostBtn} onClick={onBack}>Back to payment options</button>
      </div>
    </div>
  );
}

function CheckoutView({ token }) {
  const [state, setState] = useState({ phase: "loading", data: null });
  const [email, setEmail] = useState("");
  const [step, setStep] = useState({ name: "choose" });   // choose | review {channel, quote} | wise
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
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
    (async () => {
      try {
        const Session = window.ApplePaySession;
        if (!Session || typeof Session.canMakePayments !== "function") return;
        const ok = await Session.canMakePayments();
        if (mounted) setApplePaySupported(!!ok);
      } catch { if (mounted) setApplePaySupported(false); }
    })();
    return () => { mounted = false; };
  }, []);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const { phase, data } = state;
  const live = phase === "open" || phase === "pending";
  const methods = useMemo(() => orderMethods((data?.methods || []).filter((m) => m.channel !== "apple_pay" || applePaySupported)), [data, applePaySupported]);
  const paystack = methods.filter((m) => m.provider === "paystack");
  const wise = methods.find((m) => m.provider === "wise");

  // A quote is the price the client confirms. Ask the server for a fresh one (expired, superseded, or first view).
  const requestQuote = async (channel, why = "") => {
    setBusy(channel); setError(""); setNotice("");
    try {
      const { quote } = await getCheckoutQuote(token, channel);
      setStep({ name: "review", channel, quote });
      if (why) setNotice(why);
      setNow(Date.now());
    } catch (e) {
      setError(e.code === "fx_unavailable" ? e.message : (e.message || "We couldn’t prepare your payment. Please try again."));
    }
    setBusy("");
  };

  const choose = (m) => {
    if (inflight.current || busy) return;
    if (!emailOk) { setError("Enter your email address so Paystack can send your receipt."); return; }
    requestQuote(m.channel);
  };

  // Countdown; when the quote lapses the price is refreshed and the client must confirm again.
  const quote = step.name === "review" ? step.quote : null;
  const secs = quote ? quoteSecondsLeft(quote, now) : 0;
  useEffect(() => {
    if (!quote) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quote]);
  useEffect(() => {
    if (quote && secs === 0 && !busy && !inflight.current) requestQuote(step.channel, "The price expired, so we refreshed it. Please review and confirm again.");
  }, [secs, quote]);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    if (inflight.current || !quote || !quoteIsLive(quote)) return;
    inflight.current = true; setBusy(step.channel); setError(""); setNotice("");
    try {
      const r = await startPublicCheckout(token, email.trim(), step.channel, quote.quote_id);
      if (r.status === "redirect" && r.authorization_url) { window.location.assign(r.authorization_url); return; }
      if (r.status === "paid") { window.location.assign(`/pay/${token}/return?reference=${encodeURIComponent(r.reference || "")}`); return; }
      setNotice(r.message || "A payment for this invoice is already in progress.");
    } catch (e) {
      inflight.current = false; setBusy("");
      if (needsRequote(e.code)) { await requestQuote(step.channel, "The amount changed, so we refreshed it. Please review and confirm again."); return; }
      setError(e.message || "We couldn’t start the payment. Please try again.");
      return;
    }
    inflight.current = false; setBusy("");
  };

  const methodBtn = (m, primary) => {
    const loading = busy === m.channel;
    return (
      <button key={m.channel} type="button" disabled={!!busy} onClick={() => choose(m)}
        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: primary ? 60 : 54, padding: "13px 15px", borderRadius: 14, border: `1px solid ${primary ? BRAND.ink : BRAND.line}`, background: primary ? BRAND.ink : BRAND.white, color: primary ? BRAND.white : BRAND.ink, cursor: busy ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit", textAlign: "left" }}>
        <MethodIcon kind={m.channel} color={primary ? BRAND.accent : BRAND.muted} />
        <span style={{ flex: 1 }}>{m.name}{m.converted ? <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, opacity: .72 }}>Charged in {m.charge_currency}</span> : null}</span>
        <span style={{ fontSize: 12, fontWeight: 600, opacity: .75 }}>{loading ? "Preparing…" : "Select"}</span>
      </button>
    );
  };

  return (
    <Shell>
      <div style={card}>
        <BrandHeader />
        {phase === "loading" && <div style={{ padding: 36 }}><p style={muted}>Loading secure payment details…</p></div>}
        {MESSAGES[phase] && <div style={{ padding: "42px 34px" }}><div style={{ ...label, color: BRAND.danger }}>Unavailable</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>{MESSAGES[phase][0]}</h1><p style={muted}>{MESSAGES[phase][1]}</p></div>}
        {live && data && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
            <section style={{ padding: "36px 30px", background: BRAND.paper, borderRight: `1px solid ${BRAND.line}` }}>
              <div style={label}>Secure checkout</div>
              <h1 style={{ fontSize: "clamp(30px, 5vw, 46px)", lineHeight: 1, letterSpacing: "-.04em", margin: "12px 0 8px" }}>{formatMoney(data.currency, data.amount)}</h1>
              <p style={{ ...muted, fontSize: 14 }}>Due now · Invoice <strong style={{ color: BRAND.ink }}>{data.invoice_number}</strong>{data.client_name ? ` · ${data.client_name}` : ""}</p>
              <div style={{ marginTop: 22, borderTop: `1px solid ${BRAND.line}`, paddingTop: 10 }}>
                <div style={row}><span style={muted}>Invoice amount</span><strong>{formatMoney(data.currency, data.original_amount)}</strong></div>
                <div style={row}><span style={muted}>Remaining due</span><strong>{formatMoney(data.currency, data.outstanding)}</strong></div>
                <div style={row}><span style={muted}>Invoice currency</span><strong>{data.currency}</strong></div>
              </div>
              {phase === "pending" && <div role="status" style={{ background: "#fff8e8", border: "1px solid #ecd9a7", color: BRAND.warning, borderRadius: 14, padding: 14, marginTop: 20, fontSize: 13.5, lineHeight: 1.5 }}>A payment for this invoice is already in progress. <a href={`/pay/${token}/return`} style={{ color: BRAND.ink, fontWeight: 700 }}>Check its status</a> before paying again.</div>}
              <SecurityNote expiresAt={data.expires_at} wise={step.name === "wise"} />
            </section>

            <section style={{ padding: "32px 28px" }}>
              {step.name === "choose" && (
                <>
                  <h2 style={{ fontSize: 22, margin: "0 0 18px" }}>Choose how to pay</h2>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 7 }} htmlFor="payer-email">Email for your receipt</label>
                  <input id="payer-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
                    style={{ width: "100%", boxSizing: "border-box", padding: "13px 14px", borderRadius: 12, border: `1px solid ${error ? "#d58a8a" : BRAND.line}`, fontSize: 15, fontFamily: "inherit", outline: "none" }} />
                  {error && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: "7px 0 0" }}>{error}</p>}
                  {paystack.length > 0 && (
                    <div style={{ marginTop: 18 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}><span style={label}>Recommended</span><ProviderMark id="paystack" name="Paystack" /></div>
                      <div style={{ display: "grid", gap: 10 }}>{paystack.map((m) => methodBtn(m, true))}</div>
                      {data.methods?.some((m) => m.channel === "apple_pay") && !applePaySupported && <p style={{ ...muted, fontSize: 12, marginTop: 10 }}>Apple Pay is available on supported Apple devices and Safari.</p>}
                    </div>
                  )}
                  {wise && (
                    <div style={{ marginTop: 22 }}>
                      <div style={{ ...label, marginBottom: 8 }}>Other way to pay</div>
                      <button type="button" disabled={!!busy} onClick={() => { setError(""); setStep({ name: "wise" }); }}
                        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 14px", borderRadius: 14, border: `1px solid ${BRAND.line}`, background: "#fafaf8", color: BRAND.ink, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        <MethodIcon kind="wise" color={BRAND.muted} />
                        <span style={{ flex: 1 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700 }}><ProviderMark id="wise" name="Wise" /><span>International transfer to M-PESA</span></span>
                          <span style={{ display: "block", fontSize: 12, color: BRAND.muted, marginTop: 3, lineHeight: 1.45 }}>Use Wise to send your payment to our M-PESA wallet. Transfer instructions are provided after you select this option.</span>
                        </span>
                      </button>
                      <p style={{ ...muted, fontSize: 11.5, marginTop: 6 }}>Manual transfer: we confirm it by hand, so it can take longer than card payment.</p>
                    </div>
                  )}
                  {methods.length === 0 && <p style={{ ...muted, marginTop: 14, fontSize: 13 }}>Online payment is not available for this invoice right now. Please contact Studio Kairegi.</p>}
                </>
              )}

              {step.name === "review" && quote && (
                <>
                  <h2 style={{ fontSize: 22, margin: "0 0 14px" }}>Review your payment</h2>
                  {notice && <p role="status" style={{ background: BRAND.accentSoft, border: `1px solid ${BRAND.accent}55`, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.45, margin: "0 0 14px" }}>{notice}</p>}
                  <QuoteSummary quote={quote} data={data} />
                  <p style={{ ...muted, fontSize: 12, margin: "12px 0" }}>{quote.converted ? "This price is held for " : "Confirm within "}<strong style={{ color: BRAND.ink }}>{mmss(secs)}</strong>{quote.converted ? ". After that we refresh the rate and ask you to confirm again." : "."}</p>
                  {error && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: "0 0 10px" }}>{error}</p>}
                  <button type="button" onClick={confirm} disabled={!!busy || secs === 0} style={primaryBtn(!!busy || secs === 0)}>{busy ? "Opening Paystack…" : "Confirm amount and continue to Paystack"}</button>
                  <p style={{ margin: "12px 0 0" }}><button type="button" style={ghostBtn} disabled={!!busy} onClick={() => { setStep({ name: "choose" }); setNotice(""); setError(""); }}>Back to payment options</button></p>
                </>
              )}

              {step.name === "wise" && <WisePanel token={token} data={data} email={email} onBack={() => setStep({ name: "choose" })} />}
              {notice && step.name !== "review" && <p role="status" style={{ background: BRAND.accentSoft, border: `1px solid ${BRAND.accent}55`, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.45, marginTop: 14 }}>{notice}</p>}
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
