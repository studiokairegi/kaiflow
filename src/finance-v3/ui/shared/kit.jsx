// Shared building blocks for the Finance V3 screens: accessible, responsive, with loading / error / empty states built in.
import React, { useCallback, useEffect, useId, useRef, useState, createContext, useContext } from "react";
import { FINANCE_CSS } from "./styles.js";
import { friendlyError } from "./errors.js";

export function FinanceStyles() { return <style data-finance-v3="">{FINANCE_CSS}</style>; }

// ---- data loading ---------------------------------------------------------------------------------------------------
// useResource(loader, deps): { data, error, loading, reload }. A stale response (older request) never overwrites a newer one.
export function useResource(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve().then(loader).then(
      (data) => { if (my === seq.current) setState({ data, error: null, loading: false }); },
      (error) => { if (my === seq.current) setState((s) => ({ data: s.data, error, loading: false })); });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); return () => { seq.current++; }; }, [run]);
  return { ...state, reload: run };
}
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const wrap = useCallback(async (fn) => { setBusy(true); try { return await fn(); } finally { setBusy(false); } }, []);
  return /** @type {[boolean, (fn: () => any) => Promise<any>]} */ ([busy, wrap]);
}

// ---- context --------------------------------------------------------------------------------------------------------
export const FinanceContext = createContext(null);
export const useFinance = () => { const c = useContext(FinanceContext); if (!c) throw new Error("useFinance must be used inside FinanceV3Module"); return c; };

// ---- primitives -----------------------------------------------------------------------------------------------------
export const cx = (...a) => a.filter(Boolean).join(" ");
export function Card({ title = undefined, sub = undefined, actions = undefined, children = undefined, className = undefined }) {
  return (<section className={cx("card", className)} aria-label={typeof title === "string" ? title : undefined}>
    {(title || actions) && <div className="row" style={{ justifyContent: "space-between" }}><div>{title && <h3>{title}</h3>}{sub && <p className="sub">{sub}</p>}</div>{actions && <div className="row">{actions}</div>}</div>}
    {children}</section>);
}
export function Stat({ label = undefined, value = undefined, sub = undefined, tone = undefined, hero = undefined, onClick = undefined, hint = undefined }) {
  const body = (<><span className="l">{label}</span><span className="v">{value}</span>{(sub || hint) && <span className="sub">{sub}{sub && hint ? " · " : ""}{hint}</span>}</>);
  const c = cx("stat", hero && "hero", tone);
  return onClick ? <button type="button" className={c} onClick={onClick} style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer" }}>{body}</button> : <div className={c}>{body}</div>;
}
export function Pill({ tone = undefined, children = undefined, title = undefined }) { return <span className={cx("pill", tone)} title={title}>{children}</span>; }
export function Button({ kind = undefined, small = undefined, busy = undefined, children = undefined, ...rest }) {
  return <button type="button" className={cx("btn", kind, small && "small")} disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}>{busy ? "Working…" : children}</button>;
}
export function Banner({ tone = "info", title = undefined, children = undefined, role = undefined }) {
  return <div className={cx("banner", tone)} role={role || (tone === "critical" || tone === "bad" ? "alert" : "status")}>{title && <b>{title}</b>}{children && <span>{children}</span>}</div>;
}
export function Skeleton({ lines = 3, height = 18 }) {
  return <div className="stack" aria-busy="true" aria-live="polite"><span className="sr">Loading</span>{Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ height, width: `${100 - (i % 3) * 14}%` }} />)}</div>;
}
export function EmptyState({ title = undefined, children = undefined, action = undefined }) { return <div className="empty"><b style={{ color: "var(--text)" }}>{title}</b>{children && <span>{children}</span>}{action}</div>; }
export function ErrorState({ error = undefined, onRetry = undefined, title = "This could not be loaded" }) {
  return <div className="errorbox" role="alert"><b>{title}</b><span>{friendlyError(error)}</span>{onRetry && <Button onClick={onRetry}>Try again</Button>}</div>;
}
// Shows the right one of loading / error / empty / content for a useResource result.
export function Async({ res = undefined, empty = undefined, children = undefined, lines = 4 }) {
  if (res.loading && res.data == null) return <Skeleton lines={lines} />;
  if (res.error && res.data == null) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (empty && empty(res.data)) return empty.node ?? null;
  return <>{res.error && <Banner tone="warning" title="Showing the last data we have.">{friendlyError(res.error)}</Banner>}{children(res.data)}</>;
}

export function Field({ label = undefined, hint = undefined, error = undefined, children = undefined }) {
  const id = useId();
  const cid = React.isValidElement(children) ? children.props.id || id : id;
  const child = React.isValidElement(children) ? React.cloneElement(children, { id: cid, "aria-invalid": error ? true : undefined, "aria-describedby": [hint && id + "-h", error && id + "-e"].filter(Boolean).join(" ") || undefined }) : children;
  // The label is a sibling of the control (not a wrapper), so the control's accessible name is just the label text.
  return (<div className="field"><label htmlFor={cid}>{label}</label>{child}{hint && <span className="hint" id={id + "-h"}>{hint}</span>}{error && <span className="err" id={id + "-e"} role="alert">{error}</span>}</div>);
}

// ---- tabs and tables ------------------------------------------------------------------------------------------------
export function Tabs({ tabs = undefined, value = undefined, onChange = undefined, label = "Sections" }) {
  const onKey = (e) => {
    const i = tabs.findIndex((t) => t.id === value); let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length; else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length; else if (e.key === "Home") n = 0; else if (e.key === "End") n = tabs.length - 1; else return;
    e.preventDefault(); onChange(tabs[n].id); requestAnimationFrame(() => document.getElementById(`tab-${tabs[n].id}`)?.focus());
  };
  return (<div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>{tabs.map((t) => (
    <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" className="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} aria-controls={`panel-${t.id}`} onClick={() => onChange(t.id)}>{t.label}</button>))}</div>);
}
// columns: [{ key, header, render?(row), num?, label? }]. On phones every row becomes a labelled card.
export function DataTable({ columns = undefined, rows = undefined, rowKey = (r, _i = 0) => r.id, onRowClick = undefined, caption = undefined, totals = undefined, empty = undefined }) {
  if (!rows || rows.length === 0) return empty ?? null;
  return (<div className="scroll"><table className="fv3-table cards">
    {caption && <caption className="sr">{caption}</caption>}
    <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={c.num ? "num" : undefined}>{c.header}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => (<tr key={rowKey(r, i)} className={onRowClick ? "click" : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}
      onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r); } } : undefined} tabIndex={onRowClick ? 0 : undefined}>
      {columns.map((c) => <td key={c.key} data-label={typeof c.header === "string" ? c.header : c.label} className={c.num ? "num" : undefined}>{c.render ? c.render(r) : r[c.key] ?? "—"}</td>)}</tr>))}
      {totals && <tr className="totals">{totals.map((t, i) => <td key={i} className={columns[i]?.num ? "num" : undefined} data-label={columns[i]?.header}>{t}</td>)}</tr>}</tbody></table></div>);
}
export function Pager({ total = undefined, limit = undefined, offset = undefined, onChange = undefined }) {
  if (!total || total <= limit) return total ? <p className="sub" aria-live="polite">{total} item{total === 1 ? "" : "s"}</p> : null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (<nav className="row" aria-label="Pagination" style={{ justifyContent: "space-between" }}>
    <span className="sub" aria-live="polite">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
    <span className="row"><Button small disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
      <span className="sub">Page {page} of {pages}</span>
      <Button small disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button></span></nav>);
}

// ---- dialog ---------------------------------------------------------------------------------------------------------
let lastOpener = null; // the element that opened the current chain of dialogs (a dialog that swaps for another keeps the original opener)
export function Dialog({ title = undefined, onClose = undefined, children = undefined, footer = undefined, wide = undefined, labelledBy = undefined }) {
  const ref = useRef(null); const titleId = useId();
  const opener = useRef(null);
  if (opener.current === null && typeof document !== "undefined") { const a = document.activeElement; if (a && a !== document.body && !a.closest('[role="dialog"]')) lastOpener = a; opener.current = lastOpener || false; }
  useEffect(() => {
    const el = ref.current; const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    (el.querySelector("[data-autofocus]") || el.querySelector(sel) || el).focus();
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    const key = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll(sel)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; opener.current?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div className={cx("dialog", wide && "wide")} role="dialog" aria-modal="true" aria-labelledby={labelledBy || titleId} ref={ref} tabIndex={-1}>
      <div className="row" style={{ justifyContent: "space-between" }}><h2 id={titleId}>{title}</h2><Button small kind="ghost" onClick={onClose} aria-label="Close">Close</Button></div>
      {children}{footer && <div className="foot">{footer}</div>}</div></div>);
}

// ---- toasts ---------------------------------------------------------------------------------------------------------
export function useToasts() {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone) => { const id = Math.random().toString(36).slice(2); setItems((l) => [...l, { id, message, tone }]); setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), tone === "bad" ? 9000 : 5000); }, []);
  const node = <div className="toasts" aria-live="polite" role="status">{items.map((t) => <div key={t.id} className={cx("toast", t.tone)}>{t.message}</div>)}</div>;
  return /** @type {[(message: any, tone?: any) => void, any]} */ ([push, node]);
}
