import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "../finance/currency.js";
import { getPublicCheckout, startPublicCheckout, confirmPublicCheckout, getCheckoutQuote, startWiseTransfer, submitWiseTransfer } from "./api.js";
import { isCheckoutToken } from "./providers.js";
import { describeRate, quoteSecondsLeft, quoteIsLive, needsRequote } from "./quote.js";
import { orderMethods, wiseInstructions } from "./wise.js";
import { checkoutT, localizeError } from "../i18n/checkoutStrings.js";
import { normalizeLang, localeFor } from "../i18n/languages.js";
import { formatCountdownJa, formatDateTimeJa, currencyLabel } from "../i18n/checkoutFormat.js";

const BRAND = {
  ink: "#11161b",
  inkSoft: "#1a2228",
  paper: "#f4f3ee",
  white: "#ffffff",
  muted: "#68737a",
  line: "#dfe3df",
  accent: "#2fbfa6",
  primary: "#087db8",
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

// Renders a translated template that embeds React nodes: "{ref}" -> <strong>…</strong>, "{link}" -> <a>…</a>.
function rich(template, parts) {
  return String(template).split(/(\{\w+\})/).map((seg, i) => {
    const m = /^\{(\w+)\}$/.exec(seg);
    return m && parts[m[1]] !== undefined ? <React.Fragment key={i}>{parts[m[1]]}</React.Fragment> : seg;
  });
}

const JA_FONTS = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', Meiryo, ";

function formatExpiry(iso, locale) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(d);
}

function Shell({ children, lang = "en", tr }) {
  useEffect(() => {
    const meta = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    const prevLang = document.documentElement.lang;
    document.documentElement.lang = lang;
    document.title = tr("page.title");
    return () => { meta.forEach((m) => m.remove()); document.documentElement.lang = prevLang; };
  }, [lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="kf-payment-page" lang={lang} style={lang === "ja" ? { ...page, fontFamily: JA_FONTS + page.fontFamily } : page}>
      <div className="kf-payment-shell" style={shell}>{children}</div>
    </main>
  );
}

function BrandHeader({ tr }) {
  return (
    <div className="kf-payment-brand-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "22px 24px", borderBottom: `1px solid ${BRAND.line}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src="/logo.png" alt="Studio Kairegi" style={{ width: 42, height: 42, objectFit: "contain" }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: ".04em" }}>STUDIO KAIREGI</div>
          <div style={{ color: BRAND.muted, fontSize: 12, marginTop: 2 }}>{tr("brand.tagline")}</div>
        </div>
      </div>
      <div style={{ ...label, color: BRAND.accent }}>{tr("brand.badge")}</div>
    </div>
  );
}

function SecurityNote({ expiresAt, wise, tr, locale }) {
  return (
    <p style={{ margin: "18px 0 0", paddingTop: 14, borderTop: `1px solid ${BRAND.line}`, color: BRAND.muted, fontSize: 12, lineHeight: 1.5 }}>
      {wise ? tr("security.wise") : tr("security.paystack")}
      {expiresAt ? tr("security.expires", { date: formatExpiry(expiresAt, locale) }) : ""}
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
  const [lang, setLang] = useState(null);          // unknown until the link's language arrives, so the page never flashes English first
  const tries = useRef(0);
  const reference = useRef(new URLSearchParams(window.location.search).get("reference") || "");
  useEffect(() => {
    let live = true;
    getPublicCheckout(token).then((d) => { if (live) setLang(normalizeLang(d?.language)); }).catch(() => { if (live) setLang("en"); });
    return () => { live = false; };
  }, [token]);
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

  const tr = checkoutT(lang || "en");
  const locale = localeFor(lang || "en");
  if (!lang) {
    return <Shell lang="en" tr={tr}><div className="kf-payment-card" style={card}><BrandHeader tr={tr} /><div style={{ padding: "42px 34px 36px" }} aria-busy="true" /></div></Shell>;
  }
  const back = <a href={`/pay/${token}`} style={{ color: BRAND.ink, fontWeight: 700 }}>{tr("return.back")}</a>;
  const strong = (v) => <strong>{v}</strong>;
  const heading = { fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" };
  return (
    <Shell lang={lang} tr={tr}>
      <div className="kf-payment-card" style={card}>
        <BrandHeader tr={tr} />
        <div className="kf-payment-result-body" style={{ padding: "42px 34px 36px", maxWidth: 660 }}>
          {res.status === "checking" && <><div style={label}>{tr("return.checking.label")}</div><h1 style={heading}>{tr("return.checking.title")}</h1><p role="status" style={muted}>{tr("return.checking.body")}</p></>}
          {res.status === "paid" && <><div style={{ ...label, color: BRAND.accent }}>{tr("return.paid.label")}</div><h1 style={heading}>{tr("return.paid.title")}</h1><p style={muted}>{rich(tr.raw("return.paid.body"), { ref: strong(res.invoice_number), amount: strong(formatMoney(res.currency, res.amount)) })}</p>{res.reference && <p style={{ ...muted, fontSize: 12, marginTop: 16 }}>{tr("return.reference", { ref: res.reference })}</p>}</>}
          {res.status === "paid_elsewhere" && <><div style={{ ...label, color: BRAND.accent }}>{tr("return.elsewhere.label")}</div><h1 style={heading}>{tr("return.elsewhere.title")}</h1><p style={muted}>{rich(tr.raw("return.elsewhere.body"), { ref: strong(res.invoice_number) })}</p></>}
          {res.status === "pending" && <><div style={{ ...label, color: BRAND.warning }}>{tr("return.pending.label")}</div><h1 style={heading}>{tr("return.pending.title")}</h1><p role="status" style={muted}>{tr("return.pending.body")}</p></>}
          {res.status === "incomplete" && <><div style={label}>{tr("return.incomplete.label")}</div><h1 style={heading}>{tr("return.incomplete.title")}</h1><p style={muted}>{tr("return.incomplete.body")}</p><p style={{ marginTop: 20 }}>{back}</p></>}
          {res.status === "failed" && <><div style={{ ...label, color: BRAND.danger }}>{tr("return.failed.label")}</div><h1 style={heading}>{tr("return.failed.title")}</h1><p style={muted}>{tr("return.failed.body")}</p><p style={{ marginTop: 20 }}>{back}</p></>}
          {res.status === "review" && <><div style={{ ...label, color: BRAND.warning }}>{tr("return.review.label")}</div><h1 style={heading}>{tr("return.review.title")}</h1><p style={muted}>{lang === "en" ? (res.message || tr("return.review.body")) : tr("return.review.body")}</p></>}
          {res.status === "notfound" && <><div style={{ ...label, color: BRAND.danger }}>{tr("return.notfound.label")}</div><h1 style={heading}>{tr("msg.notfound.title")}</h1><p style={muted}>{tr("msg.notfound.body")}</p></>}
          {res.status === "error" && <><div style={{ ...label, color: BRAND.danger }}>{tr("return.error.label")}</div><h1 style={heading}>{tr("return.error.title")}</h1><p style={muted}>{tr("return.error.body")}</p></>}
        </div>
      </div>
    </Shell>
  );
}

const fmtTime = (iso, locale) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const row = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 14, fontSize: 13.5, padding: "7px 0" };
const primaryBtn = (disabled) => ({ width: "100%", minHeight: 52, padding: "13px 16px", borderRadius: 14, border: "none", background: disabled ? "#9ba3a5" : BRAND.primary, color: BRAND.white, fontSize: 15, fontWeight: 800, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", boxShadow: disabled ? "none" : "0 5px 16px rgba(8,125,184,.22)" });
const secondaryBtn = { width: "100%", minHeight: 48, padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND.line}`, background: BRAND.white, color: BRAND.ink, fontSize: 14, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" };
const ghostBtn = { background: "none", border: "none", padding: 0, color: BRAND.muted, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline" };

function QuoteSummary({ quote, data, tr, locale }) {
  const inv = quote.invoice_currency;
  if (!quote.converted) {
    return (
      <div>
        <div style={row}><span style={muted}>{tr("review.amountDue")}</span><strong>{formatMoney(inv, quote.invoice_amount)}</strong></div>
        <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6, paddingTop: 12 }}><strong>{tr("review.willCharge")}</strong><strong style={{ fontSize: 20 }}>{formatMoney(quote.charge_currency, quote.charge_amount)}</strong></div>
      </div>
    );
  }
  return (
    <div>
      <p style={{ ...muted, fontSize: 13.5, marginBottom: 10 }}>{rich(tr.raw("review.convIntro"), { inv: <strong style={{ color: BRAND.ink }}>{currencyLabel(inv, tr.lang)}</strong>, chg: <strong style={{ color: BRAND.ink }}>{currencyLabel(quote.charge_currency, tr.lang)}</strong> })}</p>
      <div style={row}><span style={muted}>{tr("review.invoiceAmount")}</span><strong>{formatMoney(inv, data.original_amount)}</strong></div>
      <div style={row}><span style={muted}>{tr("review.payingNow")}</span><strong>{formatMoney(inv, quote.invoice_amount)}</strong></div>
      <div style={row}><span style={muted}>{tr("review.rate")}</span><strong>{describeRate(quote.fx_base, quote.fx_quote, quote.fx_rate)}</strong></div>
      <div style={row}><span style={muted}>{tr("review.rateAsOf")}</span><span>{tr.lang === "ja" ? formatDateTimeJa(quote.fx_rate_fetched_at) : fmtTime(quote.fx_rate_fetched_at, locale)}</span></div>
      <div style={row}><span style={muted}>{tr("review.converted")}</span><strong>{formatMoney(quote.charge_currency, quote.converted_amount)}</strong></div>
      <div style={row}><span style={muted}>{tr("review.fee")}</span><span>{Number(quote.fee_amount) > 0 || Number(quote.markup_pct) > 0 ? `${formatMoney(quote.charge_currency, quote.fee_amount)} (${quote.markup_pct}%)` : tr("review.feeNone")}</span></div>
      <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6, paddingTop: 12 }}><strong>{tr("review.paystackCharges")}</strong><strong style={{ fontSize: 20 }}>{formatMoney(quote.charge_currency, quote.charge_amount)}</strong></div>
    </div>
  );
}

function CopyRow({ label: l, value, tr }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); } };
  return (
    <div style={{ ...row, alignItems: "center", flexWrap: "wrap" }}>
      <span style={muted}>{l}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "right", overflowWrap: "anywhere", minWidth: 0 }}><strong>{value}</strong><button type="button" onClick={copy} style={ghostBtn} aria-label={tr("wise.copyAria", { label: l })}>{done ? tr("wise.copied") : tr("wise.copy")}</button></span>
    </div>
  );
}

function WisePanel({ token, data, email, onBack, tr, lang }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ transferReference: "", payerName: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    let live = true;
    startWiseTransfer(token, email.trim()).then((r) => { if (live) { setT(r.transfer); setSubmitted(r.transfer?.status === "submitted"); } }).catch((e) => { if (live) setErr(localizeError(e, tr, "error.start")); });
    return () => { live = false; };
  }, [token]);
  const submit = async () => {
    setBusy(true); setErr("");
    try { await submitWiseTransfer(token, { reference: t.reference, ...form }); setSubmitted(true); }
    catch (e) { setErr(lang === "en" ? (e.message || tr("wise.submitError")) : tr("wise.submitError")); }
    setBusy(false);
  };
  if (err && !t) return <div><p role="alert" style={{ color: BRAND.danger, fontSize: 13.5 }}>{err}</p><button type="button" style={ghostBtn} onClick={onBack}>{tr("wise.back")}</button></div>;
  if (!t) return <p style={muted}>{tr("wise.preparing")}</p>;
  const ins = wiseInstructions(t, lang);
  if (submitted) {
    return (
      <div role="status">
        <div style={{ ...label, color: BRAND.warning }}>{tr("wise.submittedLabel")}</div>
        <h2 style={{ fontSize: 22, margin: "8px 0 10px" }}>{tr("wise.submittedTitle")}</h2>
        <p style={muted}>{rich(tr.raw("wise.submittedBody"), { ref: <strong style={{ color: BRAND.ink }}>{t.invoice_number}</strong>, tref: <strong style={{ color: BRAND.ink }}>{t.reference}</strong>, contact: t.support_contact ? tr("wise.submittedContact", { contact: t.support_contact }) : "" })}</p>
        <p style={{ marginTop: 18 }}><button type="button" style={ghostBtn} onClick={onBack}>{tr("wise.back")}</button></p>
      </div>
    );
  }
  return (
    <div>
      <div style={label}>{tr("wise.label")}</div>
      <h2 style={{ fontSize: 22, margin: "8px 0 6px" }}>{tr("wise.title")}</h2>
      <div style={{ background: "#fff8e8", border: "1px solid #ecd9a7", color: BRAND.warning, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.5, margin: "10px 0 14px" }}>{ins.warnings[0]}</div>
      <CopyRow tr={tr} label={tr("wise.recipient")} value={t.recipient_name} />
      <div style={row}><span style={muted}>{tr("wise.country")}</span><strong>{t.country}</strong></div>
      <div style={row}><span style={muted}>{tr("wise.provider")}</span><strong>{t.mobile_provider}</strong></div>
      <CopyRow tr={tr} label={tr("wise.number")} value={t.phone} />
      <CopyRow tr={tr} label={tr("wise.ourRef")} value={t.reference} />
      <div style={{ ...row, borderTop: `1px solid ${BRAND.line}`, marginTop: 6 }}><span style={muted}>{tr("wise.invoiceAmount")}</span><strong>{formatMoney(data.currency, t.original_amount)}</strong></div>
      <div style={row}><span style={muted}>{tr("wise.remaining")}</span><strong>{formatMoney(data.currency, t.invoice_outstanding)}</strong></div>
      <div style={row}><span style={muted}>{tr("wise.expected")}</span><strong>{formatMoney(t.currency, t.amount)}</strong></div>
      <p style={{ ...muted, fontSize: 12.5 }}>{tr("wise.kesNote", { amount: formatMoney(t.currency, t.amount) })}{t.instructions ? ` ${t.instructions}` : ""}</p>
      <ol style={{ paddingLeft: 20, margin: "10px 0 14px", fontSize: 13, lineHeight: 1.7 }}>{ins.steps.map((st) => <li key={st} style={{ whiteSpace: "pre-line", overflowWrap: "anywhere", marginBottom: 4 }}>{st}</li>)}</ol>
      <p style={{ ...muted, fontSize: 12.5 }}>{ins.warnings[1]} {ins.warnings[2]}</p>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${BRAND.line}`, display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 700 }} htmlFor="wise-ref">{tr("wise.refLabel")}</label>
          <input id="wise-ref" value={form.transferReference} onChange={(e) => setForm({ ...form, transferReference: e.target.value })} placeholder={tr("wise.refPlaceholder")} style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${BRAND.line}`, fontSize: 15, fontFamily: "inherit", width: "100%", boxSizing: "border-box" }} />
          <input aria-label={tr("wise.nameOptional")} value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} placeholder={tr("wise.nameOptional")} style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${BRAND.line}`, fontSize: 15, fontFamily: "inherit", width: "100%", boxSizing: "border-box" }} />
        </div>
        {err && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: 0 }}>{err}</p>}
        <div style={{ display: "grid", gap: 10 }}>
          <button type="button" disabled={busy || form.transferReference.trim().length < 4} onClick={submit} style={primaryBtn(busy || form.transferReference.trim().length < 4)}>{busy ? tr("wise.submitting") : tr("wise.submit")}</button>
          <button type="button" style={secondaryBtn} onClick={onBack}>{tr("wise.back")}</button>
        </div>
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

  // Coming back from Paystack with the browser's Back button restores this page frozen mid-"Opening Paystack…".
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) { inflight.current = false; setBusy(""); setNow(Date.now()); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

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
  // The link carries its own language (set when the link was made). Unknown / not-found links fall back to English.
  const lang = normalizeLang(data?.language);
  const tr = checkoutT(lang);
  const locale = localeFor(lang);
  const live = phase === "open" || phase === "pending";
  const methods = useMemo(() => orderMethods((data?.methods || []).filter((m) => m.channel !== "bank_transfer" && (m.channel !== "apple_pay" || applePaySupported))), [data, applePaySupported]);
  const paystack = methods.filter((m) => m.provider === "paystack");
  const wise = methods.find((m) => m.provider === "wise");
  const methodName = (m) => (lang !== "en" && ["card", "bank_transfer", "apple_pay"].includes(m.channel) ? tr(`method.${m.channel}`) : m.name);

  // A quote is the price the client confirms. Ask the server for a fresh one (expired, superseded, or first view).
  const requestQuote = async (channel, why = "") => {
    setBusy(channel); setError(""); setNotice("");
    try {
      const { quote } = await getCheckoutQuote(token, channel);
      setStep({ name: "review", channel, quote });
      if (why) setNotice(why);
      setNow(Date.now());
    } catch (e) {
      setError(localizeError(e, tr, "error.prepare"));
    }
    setBusy("");
  };

  const choose = (m) => {
    if (inflight.current || busy) return;
    if (!emailOk) { setError(tr("choose.emailError")); return; }
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
    if (quote && secs === 0 && !busy && !inflight.current) requestQuote(step.channel, tr("review.noticeExpired"));
  }, [secs, quote]);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    if (inflight.current || !quote || !quoteIsLive(quote)) return;
    inflight.current = true; setBusy(step.channel); setError(""); setNotice("");
    try {
      const r = await startPublicCheckout(token, email.trim(), step.channel, quote.quote_id);
      if (r.status === "redirect" && r.authorization_url) { window.location.assign(r.authorization_url); return; }
      if (r.status === "paid") { window.location.assign(`/pay/${token}/return?reference=${encodeURIComponent(r.reference || "")}`); return; }
      setNotice(lang === "en" ? (r.message || tr("review.noticeInProgress")) : tr("review.noticeInProgress"));
    } catch (e) {
      inflight.current = false; setBusy("");
      if (needsRequote(e.code)) { await requestQuote(step.channel, tr("review.noticeChanged")); return; }
      setError(localizeError(e, tr, "error.start"));
      return;
    }
    inflight.current = false; setBusy("");
  };

  const methodBtn = (m, primary) => {
    const loading = busy === m.channel;
    return (
      <button className="kf-payment-method" key={m.channel} type="button" disabled={!!busy} onClick={() => choose(m)}
        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: primary ? 60 : 54, padding: "13px 15px", borderRadius: 14, border: `1px solid ${primary ? BRAND.primary : BRAND.line}`, background: primary ? BRAND.primary : BRAND.white, color: primary ? BRAND.white : BRAND.ink, cursor: busy ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit", textAlign: "left", boxShadow: primary ? "0 5px 16px rgba(8,125,184,.16)" : "none" }}>
        <MethodIcon kind={m.channel} color={primary ? BRAND.white : BRAND.muted} />
        <span style={{ flex: 1 }}>{methodName(m)}{m.converted ? <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, opacity: .72 }}>{tr("method.chargedIn", { ccy: currencyLabel(m.charge_currency, lang) })}</span> : null}</span>
        <span style={{ fontSize: 12, fontWeight: 600, opacity: .75 }}>{loading ? tr("method.preparing") : tr("method.select")}</span>
      </button>
    );
  };

  const unavailable = ["notfound", "expired", "cancelled", "paid", "error"].includes(phase);
  return (
    <Shell lang={lang} tr={tr}>
      <div className="kf-payment-card" style={card}>
        <BrandHeader tr={tr} />
        {phase === "loading" && <div style={{ padding: 36 }}><p style={muted}>{checkoutT("en")("loading")}<br />{checkoutT("ja")("loading")}</p></div>}
        {unavailable && <div className="kf-payment-result-body" style={{ padding: "42px 34px" }}><div style={{ ...label, color: BRAND.danger }}>{tr("unavailable")}</div><h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 12px" }}>{tr(`msg.${phase}.title`)}</h1><p style={muted}>{tr(`msg.${phase}.body`)}</p></div>}
        {live && data && (
          <div className="kf-payment-columns" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
            <section className="kf-payment-summary" style={{ padding: "36px 30px", background: BRAND.paper, borderRight: `1px solid ${BRAND.line}` }}>
              <div style={label}>{tr("summary.label")}</div>
              <h1 style={{ fontSize: "clamp(30px, 5vw, 46px)", lineHeight: 1, letterSpacing: "-.04em", margin: "12px 0 8px" }}>{formatMoney(data.currency, data.amount)}</h1>
              <p style={{ ...muted, fontSize: 14 }}>{rich(tr.raw("summary.due"), { ref: <strong style={{ color: BRAND.ink }}>{data.invoice_number}</strong> })}{data.client_name ? tr("summary.client", { client: data.client_name }) : ""}</p>
              <div style={{ marginTop: 22, borderTop: `1px solid ${BRAND.line}`, paddingTop: 10 }}>
                <div style={row}><span style={muted}>{tr("row.invoiceAmount")}</span><strong>{formatMoney(data.currency, data.original_amount)}</strong></div>
                <div style={row}><span style={muted}>{tr("row.remaining")}</span><strong>{formatMoney(data.currency, data.outstanding)}</strong></div>
                <div style={row}><span style={muted}>{tr("row.invoiceCurrency")}</span><strong>{currencyLabel(data.currency, lang)}</strong></div>
              </div>
              {phase === "pending" && <div role="status" style={{ background: "#fff8e8", border: "1px solid #ecd9a7", color: BRAND.warning, borderRadius: 14, padding: 14, marginTop: 20, fontSize: 13.5, lineHeight: 1.5 }}>{rich(tr.raw("pending.banner"), { link: <a href={`/pay/${token}/return`} style={{ color: BRAND.ink, fontWeight: 700 }}>{tr("pending.link")}</a> })}</div>}
              <SecurityNote expiresAt={data.expires_at} wise={step.name === "wise"} tr={tr} locale={locale} />
            </section>

            <section className="kf-payment-actions" style={{ padding: "32px 28px" }}>
              {step.name === "choose" && (
                <>
                  <h2 style={{ fontSize: 22, margin: "0 0 18px" }}>{tr("choose.title")}</h2>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 7 }} htmlFor="payer-email">{tr("choose.emailLabel")}</label>
                  <input id="payer-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("choose.emailPlaceholder")}
                    style={{ width: "100%", boxSizing: "border-box", padding: "13px 14px", borderRadius: 12, border: `1px solid ${error ? "#d58a8a" : BRAND.line}`, fontSize: 15, fontFamily: "inherit", outline: "none" }} />
                  {error && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: "7px 0 0" }}>{error}</p>}
                  {paystack.length > 0 && (
                    <div style={{ marginTop: 18 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}><span style={label}>{tr("choose.recommended")}</span><ProviderMark id="paystack" name="Paystack" /></div>
                      <div style={{ display: "grid", gap: 10 }}>{paystack.map((m) => methodBtn(m, true))}</div>
                      {data.methods?.some((m) => m.channel === "apple_pay") && !applePaySupported && <p style={{ ...muted, fontSize: 12, marginTop: 10 }}>{tr("choose.applePayNote")}</p>}
                    </div>
                  )}
                  {wise && (
                    <div style={{ marginTop: 22 }}>
                      <div style={{ ...label, marginBottom: 8 }}>{tr("choose.other")}</div>
                      <button className="kf-payment-method" type="button" disabled={!!busy} onClick={() => { setError(""); setStep({ name: "wise" }); }}
                        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 14px", borderRadius: 14, border: `1px solid ${BRAND.line}`, background: "#fafaf8", color: BRAND.ink, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        <MethodIcon kind="wise" color={BRAND.muted} />
                        <span style={{ flex: 1 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700 }}><ProviderMark id="wise" name="Wise" /><span>{tr("choose.wiseTitle")}</span></span>
                          <span style={{ display: "block", fontSize: 12, color: BRAND.muted, marginTop: 3, lineHeight: 1.45 }}>{tr("choose.wiseDesc")}</span>
                        </span>
                      </button>
                      <p style={{ ...muted, fontSize: 11.5, marginTop: 6 }}>{tr("choose.wiseNote")}</p>
                    </div>
                  )}
                  {methods.length === 0 && <p style={{ ...muted, marginTop: 14, fontSize: 13 }}>{tr("choose.none")}</p>}
                </>
              )}

              {step.name === "review" && quote && (
                <>
                  <h2 style={{ fontSize: 22, margin: "0 0 14px" }}>{tr("review.title")}</h2>
                  {notice && <p role="status" style={{ background: BRAND.accentSoft, border: `1px solid ${BRAND.accent}55`, borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 1.45, margin: "0 0 14px" }}>{notice}</p>}
                  <QuoteSummary quote={quote} data={data} tr={tr} locale={locale} />
                  <p style={{ ...muted, fontSize: 12, margin: "12px 0" }}>{rich(tr.raw(quote.converted ? "review.heldConv" : "review.heldPlain"), { time: <strong style={{ color: BRAND.ink }}>{lang === "ja" ? formatCountdownJa(secs) : mmss(secs)}</strong> })}</p>
                  {error && <p role="alert" style={{ color: BRAND.danger, fontSize: 12.5, margin: "0 0 10px" }}>{error}</p>}
                  <button type="button" onClick={confirm} disabled={!!busy || secs === 0} style={primaryBtn(!!busy || secs === 0)}>{busy ? tr("review.opening") : tr("review.confirm")}</button>
                  <p style={{ margin: "12px 0 0" }}><button type="button" style={ghostBtn} disabled={!!busy} onClick={() => { setStep({ name: "choose" }); setNotice(""); setError(""); }}>{tr("review.back")}</button></p>
                </>
              )}

              {step.name === "wise" && <WisePanel token={token} data={data} email={email} onBack={() => setStep({ name: "choose" })} tr={tr} lang={lang} />}
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
