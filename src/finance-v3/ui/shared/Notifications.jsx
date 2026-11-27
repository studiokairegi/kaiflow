// Notification bell + panel. Internal finance alerts only (client emails are separate and live under Email delivery).
import React, { useState } from "react";
import { Async, Banner, Button, Dialog, EmptyState, Pill, useBusy, useFinance, useResource } from "./kit.jsx";
import { fmtDateTime } from "./format.js";
import { friendlyError } from "./errors.js";
import ModeSwitch from "./ModeSwitch.jsx";

const TONE = { critical: "bad", warning: "warn", info: "info" };
export function NotificationPanel({ onClose = undefined, onChanged = undefined }) {
  const { api, org } = useFinance(); const [unreadOnly, setUnreadOnly] = useState(false); const [busy, wrap] = useBusy(); const [err, setErr] = useState(null);
  const res = useResource(() => api.notifications(org, { unreadOnly, limit: 50 }), [api, org, unreadOnly]);
  const mark = (ids) => wrap(async () => { setErr(null); try { await api.markNotificationsRead(org, ids); res.reload(); onChanged?.(); } catch (e) { setErr(e); } });
  return (<Dialog title="Finance notifications" onClose={onClose} wide footer={<><Button busy={busy} onClick={() => mark(null)}>Mark all as read</Button><Button kind="primary" onClick={onClose}>Done</Button></>}>
    <label className="row"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
    {err && <Banner tone="warning">{friendlyError(err)}</Banner>}
    <Async res={res} empty={Object.assign((d) => !d?.items?.length, { node: <EmptyState title="You are all caught up">New alerts appear here.</EmptyState> })}>{(d) => (
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>{d.items.map((n) => (<li key={n.id} className="card" style={{ opacity: n.read ? 0.7 : 1 }}>
        <div className="row" style={{ justifyContent: "space-between" }}><span className="row"><Pill tone={TONE[n.severity]}>{n.severity}</Pill><b>{n.title}</b></span><span className="sub">{fmtDateTime(n.created_at)}</span></div>
        {n.body && <p>{n.body}</p>}
        <div className="row"><span className="sub">{n.category}{n.resolved ? " · resolved" : ""}</span>{!n.read && <Button small kind="ghost" onClick={() => mark([n.id])}>Mark as read</Button>}</div></li>))}</ul>)}</Async></Dialog>);
}
export function NotificationBell() {
  const { api, org } = useFinance(); const [open, setOpen] = useState(false);
  const res = useResource(() => api.notificationCounts(org), [api, org]);
  const n = res.data?.unread ?? 0;
  return (<>
    <Button small onClick={() => setOpen(true)} aria-label={n ? `Notifications, ${n} unread` : "Notifications"}>Alerts{n > 0 && <Pill tone={res.data?.critical_unread ? "bad" : "warn"}>{n}</Pill>}</Button>
    {open && <NotificationPanel onClose={() => { setOpen(false); res.reload(); }} onChanged={res.reload} />}</>);
}
export default function HeaderTools() { return (<div className="stack" style={{ gap: 6, alignItems: "flex-end" }}><NotificationBell /><ModeSwitch /></div>); }
