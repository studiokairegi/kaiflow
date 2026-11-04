// Agent Chat. Messages go to a database function that re-checks authorization and queues a job; the local worker answers
// using a fixed list of tools. Nothing here can send email: sending is only ever done from the Outreach tab.
import React, { useEffect, useRef, useState } from "react";
import { S, T, Btn, Banner, Pill, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { CHAT_SUGGESTIONS, actionStatus, awaitingAnswer, chatTurns, groupActions, hasPendingActions, isActionLive, newClientKey, workerState } from "./logic.js";
import { Muted, Section, TextArea, useLoad } from "./kit.jsx";

export default function ChatView({ supabase, tick, workerSeconds, onChanged }) {
  const threads = useLoad(() => intelApi.chatThreads(supabase), [supabase]);
  const [threadId, setThreadId] = useState(null);
  const [text, setText] = useState("");
  const [fast, setFast] = useState(0);
  const { busy, error, run } = useBusy();
  const msgs = useLoad(() => (threadId ? intelApi.chatMessages(supabase, threadId) : Promise.resolve([])), [supabase, threadId, tick, fast]);
  const acts = useLoad(() => (threadId ? intelApi.chatActions(supabase, threadId) : Promise.resolve([])), [supabase, threadId, tick, fast]);
  const byRequest = groupActions(acts.data);
  const list = msgs.data || [];
  const waiting = awaitingAnswer(list) || false;
  const decide = (action, confirm) => run(async () => {
    const r = confirm ? await intelApi.chatConfirm(supabase, action.id) : await intelApi.chatCancel(supabase, action.id);
    if (confirm && r && r.ok === false) throw new Error(r.error || (r.status === "expired" ? "That request expired. Ask again." : "It could not be completed."));
    setFast((n) => n + 1);
    await acts.reload();
    await onChanged?.();
  });
  const end = useRef(null);
  useEffect(() => { if (!threadId && threads.data?.length) setThreadId(threads.data[0].id); }, [threads.data, threadId]);
  useEffect(() => {
    if (!waiting && !hasPendingActions(acts.data)) return undefined;
    const id = setInterval(() => setFast((n) => n + 1), 3000);       // answer is usually a few seconds; poll quickly only while waiting
    return () => clearInterval(id);
  }, [waiting, acts.data]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [list.length, waiting]);
  const w = workerState(workerSeconds);

  const send = (value) => run(async () => {
    const body = (value ?? text).trim();
    if (!body) return;
    let id = threadId;
    if (!id) { id = await intelApi.chatNewThread(supabase, body.slice(0, 60)); setThreadId(id); }
    await intelApi.chatSend(supabase, id, body, newClientKey());
    setText("");
    await threads.reload();
    setFast((n) => n + 1);
  });
  const fresh = () => run(async () => { const id = await intelApi.chatNewThread(supabase, "New chat"); setThreadId(id); await threads.reload(); });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      {w.tone !== "ok" && <Banner tone="warn">{w.label}. Your message is saved and answered as soon as the worker is running.</Banner>}
      <Section title="Agent Chat" hint="Ask anything. The assistant can look things up, research, and prepare changes (approvals, limits, sending). Changes only happen when you press Confirm. It cannot change user roles or admin access."
        action={<div style={S.row}><Pill tone={w.tone}>{w.label}</Pill><Btn small disabled={busy} onClick={fresh}>New chat</Btn></div>}>
        {(threads.data || []).length > 1 && (
          <select value={threadId || ""} onChange={(e) => setThreadId(e.target.value)} style={S.input} aria-label="Chat history">
            {threads.data.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 220, maxHeight: 460, overflowY: "auto", padding: 4 }} role="log" aria-live="polite">
          {chatTurns(list).length === 0 && !waiting && <Muted>Try one of the suggestions below.</Muted>}
          {chatTurns(list).map((t) => (
            <div key={t.id} style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
              background: t.role === "user" ? T.accent || "#2f6fed" : "rgba(127,127,127,0.14)", color: t.role === "user" ? "#fff" : "inherit", whiteSpace: "pre-wrap",
              border: t.error ? `1px solid ${T.bad}` : "none" }}>
              {t.text}
              {t.tools?.length > 0 && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>{t.tools.join(" · ")}</div>}
              {t.role === "assistant" && (byRequest.get(t.replyTo) || []).map((a) => {
                const st = actionStatus(a);
                return (
                  <div key={a.id} style={{ marginTop: 10, padding: 10, borderRadius: 8, border: `1px solid ${T.border || "rgba(127,127,127,0.4)"}`, background: "rgba(127,127,127,0.08)" }}>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{a.summary}</div>
                    <div style={{ ...S.row, marginTop: 8 }}>
                      <Pill tone={st.tone}>{st.label}</Pill>
                      {isActionLive(a) && <>
                        <Btn small kind="primary" disabled={busy} onClick={() => decide(a, true)}>Confirm</Btn>
                        <Btn small disabled={busy} onClick={() => decide(a, false)}>Cancel</Btn>
                      </>}
                      {a.status === "failed" && a.result?.error && <span style={{ fontSize: 12 }}>{a.result.error}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {waiting && <Muted>Working on it…</Muted>}
          <div ref={end} />
        </div>
        <div style={S.row}>
          {CHAT_SUGGESTIONS.map((s) => <Btn key={s} small disabled={busy} onClick={() => send(s)}>{s}</Btn>)}
        </div>
        <TextArea rows={3} value={text} maxLength={2000} placeholder="Ask the agent…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <div style={S.row}><Btn kind="primary" disabled={busy || !text.trim()} onClick={() => send()}>Send</Btn><Muted>Ctrl+Enter to send</Muted></div>
      </Section>
    </div>
  );
}
