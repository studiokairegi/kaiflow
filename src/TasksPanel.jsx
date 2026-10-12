import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tasksApi } from "./tasksInstance.js";
import { contactsApi } from "./contactsInstance.js";
import {
  PRIORITIES, STATUSES, CATEGORIES, LINK_TYPES, RECURRENCES, WEEKDAY_LABELS,
  validateTaskInput, validateSeriesInput, taskToForm, newRequestKey, addDays, weekDays, isOpen,
  selectToday, selectTomorrow, selectWeek, selectUpcoming, selectCompleted, selectRecurring,
  planSummary, carryForwardIds, reorderIds, filterSuggestions, resolveLink, formatMinutes, describeRecurrence,
} from "./tasks.js";

// Dashboard > Tasks. One self-contained panel: summary strip, six views
// (Today / Tomorrow / This week / Upcoming / Completed / Recurring), quick add,
// an editor that separates "this occurrence" from "the whole series", and
// source-record links. All dates are plain YYYY-MM-DD strings decided by
// `getToday()` (the app's configured zone); nothing here reads the browser zone.
// Completing a task only updates that task: it never sends email, moves a deal
// stage, approves work or touches finance.

const C = { ink: "#14191c", inkSoft: "#1c2327", paper: "#EDEAE3", teal: "#2FBFA6", tealLight: "#7FE0D0", border: "#2a3338", muted: "#8b9a98", red: "#FF4D4D", green: "#3DDC84", amber: "#F2A65A" };
const PRIORITY_COLOR = { low: C.muted, normal: C.teal, high: C.amber, urgent: C.red };
const field = { width: "100%", boxSizing: "border-box", background: C.ink, color: C.paper, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: "inherit" };
const small = { background: C.ink, color: C.paper, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 6px", fontSize: 11.5, fontFamily: "inherit" };
const btn = (color, disabled) => ({ padding: "6px 11px", borderRadius: 9, border: `1px solid ${disabled ? C.border : color}`, background: disabled ? "transparent" : `${color}22`, color: disabled ? C.muted : color, fontSize: 12.5, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1, fontFamily: "inherit" });
const iconBtn = (active, color = C.amber) => ({ background: "transparent", border: "none", cursor: "pointer", color: active ? color : C.muted, fontSize: 15, lineHeight: 1, padding: "2px 4px", fontFamily: "inherit" });
const VIEWS = [["today", "Today"], ["tomorrow", "Tomorrow"], ["week", "This week"], ["upcoming", "Upcoming"], ["completed", "Completed"], ["recurring", "Recurring"]];
const ESTIMATES = [15, 30, 45, 60, 90, 120, 180, 240];
const VIEW_KEY = "kaiflow.tasks.view";

function fmtDay(date, today) {
  if (!date) return "No date";
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function moveOptions(today) {
  const out = [["", "Move to..."], [today, "Today"], [addDays(today, 1), "Tomorrow"]];
  weekDays(today).filter((d) => d > addDays(today, 1)).forEach((d) => out.push([d, fmtDay(d, today)]));
  out.push([addDays(weekDays(today)[0], 7), "Next Monday"], ["none", "No date"]);
  return out;
}

export default function TasksPanel({ getToday, leads = [], projects = [], shots = [], suggestions = [], onOpenLead, onOpenProject, onOpenShot, onOpenContact }) {
  const [today, setToday] = useState(getToday);
  const [tasks, setTasks] = useState([]);
  const [series, setSeries] = useState([]);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState(() => {
    try { const v = window.localStorage.getItem(VIEW_KEY); return VIEWS.some(([id]) => id === v) ? v : "today"; } catch { return "today"; }
  });
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const [showCancelled, setShowCancelled] = useState(false);
  const loadSeq = useRef(0);
  const quickKeys = useRef({});

  // Day rollover while the dashboard stays open.
  useEffect(() => {
    const id = setInterval(() => setToday((prev) => { const t = getToday(); return t === prev ? prev : t; }), 60000);
    return () => clearInterval(id);
  }, [getToday]);

  const chooseView = (v) => {
    setView(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [t, s] = await Promise.all([tasksApi.list(today), tasksApi.listSeries()]);
      if (seq !== loadSeq.current) return;
      setTasks(t); setSeries(s); setPhase("ready"); setLoadError("");
      // Materialize recurring occurrences (idempotent), then re-read only if something was added.
      const { inserted, failed } = await tasksApi.ensureMaterialized(s, today);
      if (seq !== loadSeq.current) return;
      if (failed) setNotice("Some recurring tasks couldn't be scheduled. They'll be retried on the next refresh.");
      if (inserted > 0) {
        const [t2, s2] = await Promise.all([tasksApi.list(today), tasksApi.listSeries()]);
        if (seq !== loadSeq.current) return;
        setTasks(t2); setSeries(s2);
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e.message); setPhase("error");
    }
  }, [today]);

  useEffect(() => { load(); return () => { loadSeq.current += 1; }; }, [load]);

  const replaceTask = (t) => setTasks((prev) => (prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]));

  // One action at a time per task; failures show a notice and leave the list as it was.
  const act = async (ids, fn) => {
    const list = [].concat(ids);
    if (list.some((id) => busy.has(id))) return;
    setBusy((b) => new Set([...b, ...list]));
    setNotice("");
    try { await fn(); } catch (e) { setNotice(e.message); }
    setBusy((b) => { const n = new Set(b); list.forEach((id) => n.delete(id)); return n; });
  };

  const actions = {
    toggle: (t) => act(t.id, async () => replaceTask(await tasksApi.setStatus(t.id, t.status === "completed" ? "todo" : "completed", today))),
    reopen: (t) => act(t.id, async () => replaceTask(await tasksApi.setStatus(t.id, "todo", today))),
    star: (t) => act(t.id, async () => replaceTask(await tasksApi.setPriority(t.id, !t.isPriority))),
    estimate: (t, mins) => act(t.id, async () => replaceTask(await tasksApi.setEstimate(t.id, mins))),
    move: (t, date) => act(t.id, async () => replaceTask(await tasksApi.reschedule(t.id, date === "none" ? null : date))),
    carry: (fromDate, toDate) => {
      const ids = carryForwardIds(tasks, fromDate, toDate, today);
      if (!ids.length) return;
      act(ids, async () => { (await tasksApi.moveMany(ids, toDate)).forEach(replaceTask); });
    },
    reorder: (list, taskId, dir) => {
      const order = reorderIds(list, taskId, dir);
      if (!order) return;
      act(list.map((t) => t.id), async () => {
        await tasksApi.reorder(order);
        setTasks((prev) => prev.map((t) => (order.includes(t.id) ? { ...t, sortOrder: order.indexOf(t.id) + 1 } : t)));
      });
    },
    quickAdd: async (title, date) => {
      const k = `${date || "none"}`;
      if (!quickKeys.current[k]) quickKeys.current[k] = newRequestKey();
      let ok = false;
      await act("quick:" + k, async () => {
        const { task } = await tasksApi.create({ title, dueDate: date }, { requestKey: quickKeys.current[k] });
        replaceTask(task); delete quickKeys.current[k]; ok = true;
      });
      return ok;
    },
    addSuggestion: (s) => act("sg:" + s.key, async () => {
      const { task } = await tasksApi.create(
        { title: s.title, dueDate: s.dueDate || today, category: s.category || "outreach", linkType: s.linkType, linkId: s.linkId, linkLabel: s.linkLabel },
        { sourceKey: s.key },
      );
      replaceTask(task);
    }),
    seriesStatus: (s, status) => act("series:" + s.id, async () => { await tasksApi.setSeriesStatus(s.id, status, today); await load(); }),
  };

  const openLink = (link) => {
    if (!link?.exists) return;
    if (link.type === "lead") onOpenLead?.(link.record);
    else if (link.type === "project") onOpenProject?.(link.id);
    else if (link.type === "shot") onOpenShot?.(link.record);
    else if (link.type === "contact") onOpenContact?.(link.id);
  };
  const linkCtx = useMemo(() => ({ leads, projects, shots }), [leads, projects, shots]);

  const summary = useMemo(() => planSummary(tasks, today), [tasks, today]);
  const pendingSuggestions = useMemo(() => filterSuggestions(suggestions, tasks), [suggestions, tasks]);
  const ctx = { today, tasks, busy, actions, linkCtx, openLink, series, setEditor };

  const openNew = (dueDate) => setEditor({ mode: "new", dueDate: dueDate === undefined ? (view === "tomorrow" ? addDays(today, 1) : today) : dueDate });
  const openTask = (t) => {
    if (t.seriesId) setEditor({ mode: "occurrence", task: t, series: series.find((s) => s.id === t.seriesId) || null });
    else setEditor({ mode: "task", task: t });
  };
  ctx.openTask = openTask;

  const Chip = ({ label, tone, onClick }) => (
    <button type="button" onClick={onClick} style={{ ...btn(tone || C.muted), padding: "3px 9px", fontSize: 11.5 }}>{label}</button>
  );

  return (
    <div className="kf-card" style={{ background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 14, padding: "12px 14px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, color: C.paper }} aria-label="Tasks">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600 }}>Tasks</span>
        {phase === "ready" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
            {summary.overdue > 0 && <Chip tone={C.red} label={`${summary.overdue} overdue`} onClick={() => chooseView("today")} />}
            <Chip tone={C.teal} label={`Today: ${summary.today.remaining} left${summary.today.completed ? ` · ${summary.today.completed} done` : ""}${summary.today.hasEstimates ? ` · ${formatMinutes(summary.today.estimatedMinutes)}` : ""}`} onClick={() => chooseView("today")} />
            <Chip label={`Tomorrow: ${plural(summary.tomorrow.remaining, "task")}${summary.tomorrow.hasEstimates ? ` · ${formatMinutes(summary.tomorrow.estimatedMinutes)}` : ""}`} onClick={() => chooseView("tomorrow")} />
          </div>
        )}
        <button type="button" style={btn(C.teal)} onClick={() => openNew()}>+ New task</button>
      </div>

      <div role="tablist" aria-label="Task views" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => chooseView(id)}
            style={{ ...btn(view === id ? C.teal : C.muted), background: view === id ? "rgba(47,191,166,0.14)" : "transparent", padding: "4px 10px", fontSize: 12 }}>
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <div role="alert" style={{ color: C.red, fontSize: 12.5, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button type="button" style={iconBtn(false)} onClick={() => setNotice("")} aria-label="Dismiss">×</button>
        </div>
      )}

      <div style={{ maxHeight: "clamp(220px, 36vh, 400px)", overflowY: "auto", paddingRight: 2 }}>
        {phase === "loading" && <p style={{ color: C.muted, fontSize: 13, margin: "8px 0" }}>Loading tasks...</p>}
        {phase === "error" && (
          <div style={{ fontSize: 13 }}>
            <p style={{ color: C.red, margin: "6px 0" }}>{loadError}</p>
            <button type="button" style={btn(C.teal)} onClick={() => { setPhase("loading"); load(); }}>Retry</button>
          </div>
        )}
        {phase === "ready" && view === "today" && <TodayView ctx={ctx} suggestions={pendingSuggestions} />}
        {phase === "ready" && view === "tomorrow" && <TomorrowView ctx={ctx} />}
        {phase === "ready" && view === "week" && <WeekView ctx={ctx} />}
        {phase === "ready" && view === "upcoming" && <UpcomingView ctx={ctx} />}
        {phase === "ready" && view === "completed" && <CompletedView ctx={ctx} showCancelled={showCancelled} setShowCancelled={setShowCancelled} />}
        {phase === "ready" && view === "recurring" && <RecurringView ctx={ctx} onNew={() => setEditor({ mode: "new", dueDate: today, repeat: true })} />}
      </div>

      {editor && (
        <TaskEditor
          key={editor.mode + (editor.task?.id || editor.series?.id || "") + (editor.dueDate || "")}
          editor={editor} today={today} leads={leads} projects={projects} shots={shots}
          onClose={() => setEditor(null)}
          onSwitchToSeries={() => setEditor({ mode: "series", series: editor.series })}
          onSaved={async (reload) => { setEditor(null); if (reload) await load(); }}
          onTaskSaved={(t) => { replaceTask(t); setEditor(null); }}
          onRemoved={(t) => { setTasks((prev) => (t ? prev.map((x) => (x.id === t.id ? t : x)) : prev.filter((x) => x.id !== editor.task.id))); setEditor(null); }}
          onSeriesChanged={async () => { setEditor(null); await load(); }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- rows

function TaskRow({ t, ctx, reorderList, showDate, compact }) {
  const { today, busy, actions, linkCtx, openLink, openTask } = ctx;
  const link = resolveLink(t, linkCtx);
  const isBusy = busy.has(t.id);
  const done = t.status === "completed" || t.status === "cancelled";
  const overdue = isOpen(t) && t.dueDate && t.dueDate < today;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: compact ? "5px 0" : "6px 0", borderBottom: `1px solid ${C.border}`, opacity: isBusy ? 0.55 : 1 }}>
      <input type="checkbox" checked={t.status === "completed"} disabled={isBusy || t.status === "cancelled"} onChange={() => actions.toggle(t)} aria-label={`${t.status === "completed" ? "Reopen" : "Complete"} ${t.title}`} style={{ marginTop: 3, accentColor: C.teal }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
          <button type="button" onClick={() => openTask(t)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: done ? C.muted : C.paper, textDecoration: done ? "line-through" : "none", fontSize: 13.5, textAlign: "left", fontFamily: "inherit" }}>
            {t.title}
          </button>
          {t.seriesId && <span title="Recurring" style={{ color: C.muted, fontSize: 11 }}>↻</span>}
          {t.status === "in_progress" && <span style={{ color: C.amber, fontSize: 10.5 }}>in progress</span>}
          {t.priority !== "normal" && <span style={{ color: PRIORITY_COLOR[t.priority], fontSize: 10.5 }}>{t.priority}</span>}
          {overdue && <span style={{ color: C.red, fontSize: 10.5 }}>overdue</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, color: C.muted, marginTop: 1 }}>
          {showDate && <span>{fmtDay(t.dueDate, today)}</span>}
          {t.startTime && <span>{t.startTime}</span>}
          {t.estMinutes && <span>{formatMinutes(t.estMinutes)}</span>}
          {t.category !== "general" && <span>{CATEGORIES.find((c) => c.id === t.category)?.label}</span>}
          {link && (link.exists
            ? <button type="button" onClick={() => openLink(link)} title={`Open ${link.type}`} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C.tealLight, fontSize: 11, fontFamily: "inherit" }}>↗ {link.label}</button>
            : <span title="This record no longer exists">{link.label} (unavailable)</span>)}
        </div>
      </div>
      {isOpen(t) && (
        <div style={{ display: "flex", gap: 2, alignItems: "center", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 230 }}>
          <button type="button" style={iconBtn(t.isPriority)} title={t.isPriority ? "Remove from top priorities" : "Make a top priority"} aria-label={t.isPriority ? "Unstar" : "Star as priority"} aria-pressed={t.isPriority} disabled={isBusy} onClick={() => actions.star(t)}>{t.isPriority ? "★" : "☆"}</button>
          {reorderList && <>
            <button type="button" style={iconBtn(false)} aria-label="Move up" disabled={isBusy} onClick={() => actions.reorder(reorderList, t.id, "up")}>▲</button>
            <button type="button" style={iconBtn(false)} aria-label="Move down" disabled={isBusy} onClick={() => actions.reorder(reorderList, t.id, "down")}>▼</button>
          </>}
          <select aria-label={`Estimate for ${t.title}`} style={small} value={t.estMinutes || ""} disabled={isBusy} onChange={(e) => actions.estimate(t, e.target.value ? Number(e.target.value) : null)}>
            <option value="">Est.</option>
            {[...new Set([...ESTIMATES, t.estMinutes].filter(Boolean))].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{formatMinutes(m)}</option>)}
          </select>
          <select aria-label={`Move ${t.title}`} style={small} value="" disabled={isBusy} onChange={(e) => e.target.value && actions.move(t, e.target.value)}>
            {moveOptions(today).map(([v, l]) => <option key={v + l} value={v}>{l}</option>)}
          </select>
        </div>
      )}
      {t.status === "completed" && <button type="button" style={{ ...btn(C.muted), padding: "2px 8px", fontSize: 11 }} disabled={isBusy} onClick={() => actions.toggle(t)}>Reopen</button>}
      {t.status === "cancelled" && <button type="button" style={{ ...btn(C.muted), padding: "2px 8px", fontSize: 11 }} disabled={isBusy} onClick={() => actions.reopen(t)}>Reopen</button>}
    </div>
  );
}

function SectionTitle({ children, right, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 2px", fontSize: 11.5, color: tone || C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
      <span>{children}</span>{right}
    </div>
  );
}

function QuickAdd({ date, ctx, placeholder }) {
  const [title, setTitle] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || ctx.busy.has("quick:" + (date || "none"))) return;
    if (await ctx.actions.quickAdd(title.trim(), date)) setTitle("");
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 6, margin: "6px 0" }}>
      <input style={{ ...field, padding: "6px 9px" }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={200} />
      <button type="submit" style={btn(C.teal, !title.trim())} disabled={!title.trim()}>Add</button>
    </form>
  );
}

function Stats({ stats, label }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: C.muted, margin: "2px 0 4px" }}>
      <span><strong style={{ color: C.paper }}>{stats.remaining}</strong> remaining</span>
      <span><strong style={{ color: C.green }}>{stats.completed}</strong> of {stats.total} done</span>
      <span>{stats.hasEstimates ? <>~<strong style={{ color: stats.heavy ? C.amber : C.paper }}>{formatMinutes(stats.estimatedMinutes)}</strong> planned{stats.unestimated ? ` (${stats.unestimated} without an estimate)` : ""}</> : "no estimates yet"}</span>
      {stats.overdue > 0 && label === "today" && <span style={{ color: C.red }}>{plural(stats.overdue, "overdue task")}</span>}
      {stats.heavy && <span style={{ color: C.amber }}>Heavy day</span>}
    </div>
  );
}

function DayList({ v, ctx, emptyTitle, emptyHint }) {
  const empty = !v.priorities.length && !v.others.length && !v.done.length;
  return (
    <>
      {empty && (
        <div style={{ color: C.muted, fontSize: 13, padding: "10px 0" }}>
          <div style={{ color: C.paper }}>{emptyTitle}</div>
          <div style={{ fontSize: 12 }}>{emptyHint}</div>
        </div>
      )}
      {v.priorities.length > 0 && <>
        <SectionTitle tone={C.amber}>Top priorities{v.priorities.length > 3 ? " (3 or fewer keeps focus)" : ""}</SectionTitle>
        {v.priorities.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} reorderList={v.priorities} />)}
      </>}
      {v.others.length > 0 && <>
        {v.priorities.length > 0 && <SectionTitle>Also planned</SectionTitle>}
        {v.others.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} reorderList={v.others} />)}
      </>}
      {v.done.length > 0 && <>
        <SectionTitle>Done</SectionTitle>
        {v.done.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
      </>}
    </>
  );
}

// ------------------------------------------------------------------ views

function TodayView({ ctx, suggestions }) {
  const { tasks, today, actions } = ctx;
  const v = selectToday(tasks, today);
  const tomorrow = addDays(today, 1);
  return (
    <div>
      <Stats stats={v.stats} label="today" />
      {v.overdue.length > 0 && <>
        <SectionTitle tone={C.red} right={<span style={{ display: "flex", gap: 6 }}>
          <button type="button" style={{ ...btn(C.muted), padding: "1px 8px", fontSize: 11 }} onClick={() => actions.carry(today, today)}>Move all to today</button>
          <button type="button" style={{ ...btn(C.muted), padding: "1px 8px", fontSize: 11 }} onClick={() => actions.carry(today, tomorrow)}>Move all to tomorrow</button>
        </span>}>Overdue · needs attention</SectionTitle>
        {v.overdue.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} showDate />)}
      </>}
      <QuickAdd date={today} ctx={ctx} placeholder="Add a task for today and press Enter" />
      <DayList v={v} ctx={ctx} emptyTitle="Nothing planned for today." emptyHint="Add your first task above, or prepare tomorrow's plan in the Tomorrow tab." />
      {suggestions.length > 0 && <>
        <SectionTitle>Suggested follow-ups</SectionTitle>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Leads that are due for follow-up and have no task yet. Nothing is added until you click.</div>
        {suggestions.slice(0, 5).map((s) => (
          <div key={s.key} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{s.title}</span>
            <button type="button" style={btn(C.teal, ctx.busy.has("sg:" + s.key))} disabled={ctx.busy.has("sg:" + s.key)} onClick={() => actions.addSuggestion(s)}>Add task</button>
          </div>
        ))}
        {suggestions.length > 5 && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>+{suggestions.length - 5} more once these are handled</div>}
      </>}
    </div>
  );
}

function TomorrowView({ ctx }) {
  const { tasks, today, actions } = ctx;
  const v = selectTomorrow(tasks, today);
  const carryable = carryForwardIds(tasks, today, v.date, today).length;
  return (
    <div>
      <Stats stats={v.stats} label="tomorrow" />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}><QuickAdd date={v.date} ctx={ctx} placeholder="Plan something for tomorrow and press Enter" /></div>
        {carryable > 0 && <button type="button" style={btn(C.muted)} onClick={() => actions.carry(today, v.date)}>Carry {carryable} unfinished from today</button>}
      </div>
      <DayList v={v} ctx={ctx} emptyTitle="Tomorrow's plan is empty." emptyHint="Add tasks above, star the top priorities and give them estimates so the day is ready before you start it." />
    </div>
  );
}

function WeekView({ ctx }) {
  const { tasks, today, actions } = ctx;
  const w = selectWeek(tasks, today);
  const [showDone, setShowDone] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{fmtDay(w.start, today)} – {fmtDay(w.end, today)}</div>
      {w.overdue.length > 0 && <>
        <SectionTitle tone={C.red} right={<button type="button" style={{ ...btn(C.muted), padding: "1px 8px", fontSize: 11 }} onClick={() => actions.carry(today, today)}>Move all to today</button>}>Overdue</SectionTitle>
        {w.overdue.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} showDate compact />)}
      </>}
      {w.unscheduled.length > 0 && <>
        <SectionTitle>No date</SectionTitle>
        {w.unscheduled.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
      </>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8, marginTop: 8 }}>
        {w.days.map((d) => (
          <div key={d.date} style={{ border: `1px solid ${d.isToday ? C.teal : C.border}`, borderRadius: 10, padding: "6px 8px", opacity: d.isPast && !d.tasks.length ? 0.6 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
              <strong>{fmtDay(d.date, today)}</strong>
              <span style={{ color: d.stats.heavy ? C.amber : C.muted }}>
                {d.stats.heavy ? "Heavy · " : ""}{d.stats.remaining} left{d.stats.hasEstimates ? ` · ${formatMinutes(d.stats.estimatedMinutes)}` : ""}
              </span>
            </div>
            {d.tasks.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
            {!d.isPast && <QuickAdd date={d.date} ctx={ctx} placeholder={`Add to ${fmtDay(d.date, today)}`} />}
          </div>
        ))}
      </div>
      <SectionTitle right={<button type="button" style={{ ...btn(C.muted), padding: "1px 8px", fontSize: 11 }} onClick={() => setShowDone(!showDone)}>{showDone ? "Hide" : "Show"}</button>}>
        Completed this week · {w.completed.length}
      </SectionTitle>
      {showDone && w.completed.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
    </div>
  );
}

function UpcomingView({ ctx }) {
  const groups = selectUpcoming(ctx.tasks, ctx.today);
  if (!groups.length) return <p style={{ color: C.muted, fontSize: 13, margin: "10px 0" }}>Nothing is scheduled beyond this week. Tasks with later dates and recurring occurrences appear here.</p>;
  return groups.map((g) => (
    <div key={g.date}>
      <SectionTitle>{fmtDay(g.date, ctx.today)}</SectionTitle>
      {g.tasks.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
    </div>
  ));
}

function CompletedView({ ctx, showCancelled, setShowCancelled }) {
  const groups = selectCompleted(ctx.tasks, { includeCancelled: showCancelled });
  return (
    <div>
      <label style={{ fontSize: 12, color: C.muted, display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
        <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Include cancelled and skipped
      </label>
      {!groups.length && <p style={{ color: C.muted, fontSize: 13, margin: "10px 0" }}>No completed tasks in the last 60 days yet.</p>}
      {groups.map((g) => (
        <div key={g.date}>
          <SectionTitle>Completed {fmtDay(g.date, ctx.today)} · {g.tasks.length}</SectionTitle>
          {g.tasks.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} compact />)}
        </div>
      ))}
    </div>
  );
}

function RecurringView({ ctx, onNew }) {
  const rows = selectRecurring(ctx.series, ctx.tasks, ctx.today);
  const { actions, busy, setEditor, today } = ctx;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "4px 0" }}>
        <span style={{ fontSize: 12, color: C.muted }}>Each occurrence is its own task; completing one never completes the series.</span>
        <button type="button" style={btn(C.teal)} onClick={onNew}>+ New recurring task</button>
      </div>
      {!rows.length && <p style={{ color: C.muted, fontSize: 13, margin: "10px 0" }}>No recurring tasks yet. Use them for routines like daily outreach, a weekly pipeline review or monthly invoicing.</p>}
      {rows.map(({ series: s, next, description }) => {
        const b = busy.has("series:" + s.id);
        return (
          <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "7px 0", borderBottom: `1px solid ${C.border}`, opacity: s.status === "ended" ? 0.6 : 1 }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <button type="button" onClick={() => setEditor({ mode: "series", series: s })} style={{ background: "none", border: "none", padding: 0, color: C.paper, fontSize: 13.5, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>{s.title}</button>
              <div style={{ fontSize: 11, color: C.muted }}>
                {description} · {s.status === "active" ? (next ? `next ${fmtDay(next, today)}` : "no upcoming occurrence") : s.status}
                {s.endDate ? ` · until ${fmtDay(s.endDate, today)}` : ""}
              </div>
            </div>
            {s.status === "active" && <button type="button" style={btn(C.amber, b)} disabled={b} onClick={() => actions.seriesStatus(s, "paused")}>Pause</button>}
            {s.status === "paused" && <button type="button" style={btn(C.green, b)} disabled={b} onClick={() => actions.seriesStatus(s, "active")}>Resume</button>}
            {s.status !== "ended" && <button type="button" style={btn(C.red, b)} disabled={b} onClick={() => window.confirm(`End "${s.title}"? Future untouched occurrences are removed; history is kept. This can't be undone.`) && actions.seriesStatus(s, "ended")}>End</button>}
            <button type="button" style={btn(C.muted)} onClick={() => setEditor({ mode: "series", series: s })}>Edit</button>
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- editor

function RecordPicker({ type, value, label, onChange, leads, projects, shots }) {
  const [contacts, setContacts] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (type !== "contact" || contacts) return;
    let live = true;
    contactsApi.list().then((c) => live && setContacts(c)).catch(() => live && setContacts([]));
    return () => { live = false; };
  }, [type, contacts]);
  const items = useMemo(() => {
    const list =
      type === "lead" ? leads.map((l) => ({ id: l.id, label: l.companyName || "Untitled lead", sub: l.contactPerson })) :
      type === "project" ? projects.map((p) => ({ id: p.id, label: p.name, sub: p.client })) :
      type === "shot" ? shots.map((s) => ({ id: s.id, label: s.title, sub: projects.find((p) => p.id === s.projectId)?.name })) :
      type === "contact" ? (contacts || []).map((c) => ({ id: c.id, label: c.name, sub: c.company })) : [];
    const needle = q.trim().toLowerCase();
    return list.filter((i) => !needle || `${i.label} ${i.sub || ""}`.toLowerCase().includes(needle)).slice(0, 60);
  }, [type, q, leads, projects, shots, contacts]);
  if (!type) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input style={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search records" />
      <select style={field} value={value || ""} aria-label="Linked record" onChange={(e) => { const it = items.find((i) => i.id === e.target.value); onChange(e.target.value || null, it?.label || null); }}>
        <option value="">{type === "contact" && !contacts ? "Loading..." : "Choose a record"}</option>
        {value && !items.some((i) => i.id === value) && <option value={value}>{label || "Current link"}</option>}
        {items.map((i) => <option key={i.id} value={i.id}>{i.label}{i.sub ? ` · ${i.sub}` : ""}</option>)}
      </select>
    </div>
  );
}

const EMPTY_FORM = { title: "", notes: "", dueDate: "", startTime: "", estMinutes: "", priority: "normal", status: "todo", category: "general", linkType: null, linkId: null, linkLabel: null, isPriority: false };
const EMPTY_SCHEDULE = { recurrence: "daily", weekdays: [], monthDay: "", intervalDays: "", startDate: "", endDate: "" };

function TaskEditor({ editor, today, leads, projects, shots, onClose, onSwitchToSeries, onTaskSaved, onSaved, onRemoved, onSeriesChanged }) {
  const { mode } = editor;
  const isSeriesEdit = mode === "series";
  const [form, setForm] = useState(() => {
    if (mode === "task" || mode === "occurrence") return taskToForm(editor.task);
    if (isSeriesEdit) { const s = editor.series; return { ...EMPTY_FORM, title: s.title, notes: s.notes, estMinutes: s.estMinutes ?? "", startTime: s.startTime || "", priority: s.priority, category: s.category, linkType: s.linkType, linkId: s.linkId, linkLabel: s.linkLabel }; }
    return { ...EMPTY_FORM, dueDate: editor.dueDate ?? today };
  });
  const [repeat, setRepeat] = useState(isSeriesEdit || editor.repeat ? "yes" : "no");
  const [sched, setSched] = useState(() => {
    if (isSeriesEdit) { const s = editor.series; return { recurrence: s.recurrence, weekdays: s.weekdays, monthDay: s.monthDay ?? "", intervalDays: s.intervalDays ?? "", startDate: s.startDate, endDate: s.endDate || "" }; }
    return { ...EMPTY_SCHEDULE, startDate: editor.dueDate || today };
  });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const keyRef = useRef(newRequestKey());
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setS = (k) => (e) => setSched({ ...sched, [k]: e.target.value });

  const title = isSeriesEdit ? "Edit recurring task" : mode === "occurrence" ? "Edit this occurrence" : mode === "task" ? "Edit task" : repeat === "yes" ? "New recurring task" : "New task";

  const save = async () => {
    if (savingRef.current) return;
    setErrors({}); setError("");
    const wantsSeries = isSeriesEdit || (mode === "new" && repeat === "yes");
    const input = wantsSeries
      ? { ...form, ...sched, startDate: sched.startDate || form.dueDate || today, monthDay: sched.monthDay, intervalDays: sched.intervalDays }
      : form;
    const v = wantsSeries ? validateSeriesInput(input) : validateTaskInput(input);
    if (!v.ok) { setErrors(v.errors); return; }
    savingRef.current = true; setSaving(true);
    try {
      if (isSeriesEdit) { await tasksApi.updateSeries(editor.series, input, today); await onSeriesChanged(); }
      else if (wantsSeries) { await tasksApi.createSeries(input, today); await onSaved(true); }
      else if (mode === "new") { const { task } = await tasksApi.create(form, { requestKey: keyRef.current }); onTaskSaved(task); }
      else { onTaskSaved(await tasksApi.update(editor.task.id, form)); }
    } catch (e) {
      setError(e.message); if (e.validation) setErrors(e.validation);
      savingRef.current = false; setSaving(false);
    }
  };

  const remove = async () => {
    const skip = !!editor.task?.seriesId;
    if (!window.confirm(skip ? "Skip this occurrence? The recurring task itself is unchanged." : "Delete this task? This can't be undone.")) return;
    savingRef.current = true; setSaving(true);
    try { onRemoved(await tasksApi.remove(editor.task)); }
    catch (e) { setError(e.message); savingRef.current = false; setSaving(false); }
  };

  const err = (k) => errors[k] && <div style={{ color: C.red, fontSize: 11.5, marginTop: 2 }}>{errors[k]}</div>;
  const label = (t) => <label style={{ display: "block", fontSize: 11.5, color: C.muted, margin: "8px 0 3px" }}>{t}</label>;
  const toggleDay = (d) => setSched({ ...sched, weekdays: sched.weekdays.includes(d) ? sched.weekdays.filter((x) => x !== d) : [...sched.weekdays, d] });

  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }} onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div style={{ background: C.inkSoft, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, width: "min(560px, 100%)", maxHeight: "92vh", overflowY: "auto", color: C.paper }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{title}</h3>

        {mode === "occurrence" && (
          <div style={{ background: "rgba(47,191,166,0.1)", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5, margin: "6px 0" }}>
            This task repeats{editor.series ? ` (${describeRecurrence(editor.series)})` : ""}. Changes here affect <strong>only this occurrence</strong>.
            {editor.series && <> <button type="button" onClick={onSwitchToSeries} style={{ ...btn(C.teal), padding: "2px 8px", marginLeft: 6 }}>Edit the whole series</button></>}
          </div>
        )}
        {isSeriesEdit && (
          <div style={{ background: "rgba(242,166,90,0.1)", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5, margin: "6px 0" }}>
            Edits the recurring task. Future occurrences you haven't touched follow it; occurrences you edited, moved, started, starred or completed are left alone.
          </div>
        )}

        {label("Title *")}
        <input style={field} value={form.title} onChange={set("title")} maxLength={200} autoFocus aria-label="Title" />{err("title")}
        {label("Notes")}
        <textarea style={{ ...field, minHeight: 64, resize: "vertical" }} value={form.notes} onChange={set("notes")} aria-label="Notes" />{err("notes")}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          {!isSeriesEdit && !(mode === "new" && repeat === "yes") && <div>{label("Due date")}<input type="date" style={field} value={form.dueDate} onChange={set("dueDate")} aria-label="Due date" />{err("dueDate")}</div>}
          <div>{label("Start time")}<input type="time" style={field} value={form.startTime} onChange={set("startTime")} aria-label="Start time" />{err("startTime")}</div>
          <div>{label("Estimate (minutes)")}<input type="number" min="1" max="1440" style={field} value={form.estMinutes} onChange={set("estMinutes")} aria-label="Estimated minutes" />{err("estMinutes")}</div>
          <div>{label("Priority")}<select style={field} value={form.priority} onChange={set("priority")} aria-label="Priority">{PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
          {!isSeriesEdit && <div>{label("Status")}<select style={field} value={form.status} onChange={set("status")} aria-label="Status">{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>}
          <div>{label("Category")}<select style={field} value={form.category} onChange={set("category")} aria-label="Category">{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        </div>
        {!isSeriesEdit && (
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginTop: 10 }}>
            <input type="checkbox" checked={form.isPriority} onChange={set("isPriority")} style={{ accentColor: C.teal }} /> Top priority for its day
          </label>
        )}

        {label("Linked record (optional)")}
        <select style={field} value={form.linkType || ""} aria-label="Link type" onChange={(e) => setForm({ ...form, linkType: e.target.value || null, linkId: null, linkLabel: null })}>
          <option value="">No link</option>
          {LINK_TYPES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <div style={{ marginTop: 6 }}>
          <RecordPicker type={form.linkType} value={form.linkId} label={form.linkLabel} leads={leads} projects={projects} shots={shots} onChange={(id, lbl) => setForm({ ...form, linkId: id, linkLabel: lbl })} />
        </div>{err("link")}

        {mode === "new" && (
          <>
            {label("Repeat")}
            <select style={field} value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat">
              <option value="no">Doesn't repeat</option>
              <option value="yes">Repeats...</option>
            </select>
          </>
        )}
        {(isSeriesEdit || (mode === "new" && repeat === "yes")) && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "4px 10px 10px", marginTop: 8 }}>
            {label("Schedule")}
            <select style={field} value={sched.recurrence} onChange={setS("recurrence")} aria-label="Schedule">{RECURRENCES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>{err("recurrence")}
            {sched.recurrence === "weekly" && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} role="group" aria-label="Days of the week">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <button key={d} type="button" aria-pressed={sched.weekdays.includes(d)} onClick={() => toggleDay(d)} style={{ ...btn(sched.weekdays.includes(d) ? C.teal : C.muted), padding: "4px 9px" }}>{WEEKDAY_LABELS[d]}</button>
                ))}
              </div>
            )}{err("weekdays")}
            {sched.recurrence === "monthly" && <>{label("Day of the month (shorter months use their last day)")}<input type="number" min="1" max="31" style={field} value={sched.monthDay} onChange={setS("monthDay")} aria-label="Day of month" />{err("monthDay")}</>}
            {sched.recurrence === "interval" && <>{label("Repeat every N days (2-365)")}<input type="number" min="2" max="365" style={field} value={sched.intervalDays} onChange={setS("intervalDays")} aria-label="Interval days" />{err("intervalDays")}</>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
              <div>{label("Start date")}<input type="date" style={field} value={sched.startDate} onChange={setS("startDate")} aria-label="Start date" />{err("startDate")}</div>
              <div>{label("End date (optional)")}<input type="date" style={field} value={sched.endDate} onChange={setS("endDate")} aria-label="End date" />{err("endDate")}</div>
            </div>
            {isSeriesEdit && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Status: {editor.series.status}. Pause, resume or end from the Recurring tab.</div>}
          </div>
        )}

        {error && <div role="alert" style={{ color: C.red, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" style={btn(C.teal, saving)} disabled={saving} onClick={save}>{saving ? "Saving..." : mode === "new" ? (repeat === "yes" ? "Create recurring task" : "Create task") : isSeriesEdit ? "Save series" : mode === "occurrence" ? "Save this occurrence" : "Save"}</button>
          <button type="button" style={btn(C.muted, saving)} disabled={saving} onClick={onClose}>Cancel</button>
          {(mode === "task" || mode === "occurrence") && <button type="button" style={{ ...btn(C.red, saving), marginLeft: "auto" }} disabled={saving} onClick={remove}>{mode === "occurrence" ? "Skip this occurrence" : "Delete"}</button>}
        </div>
      </div>
    </div>
  );
}
