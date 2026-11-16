# Emma Shared Chat UI Handoff Report

Date: 13 Nov 2026
Scope: Emma (Agent Chat) tab UI only: `src/intelligence/ChatView.jsx`, new `src/intelligence/emma-chat.css`, and a small additive change to `src/chat/MessageList.jsx`. Starting point: `KairFlow_Phase_3_Round2_Fixed` (the Emma handoff of 13 Nov 2026).

## 1. Summary
Emma's conversation screen was built from inline styles and the finance UI kit, so it looked different from the staff Chat and the Inbox. It now reuses the shared chat system (`src/chat`): the same stylesheet and theme tokens, `MessageList`, `Composer`, icons and sidebar/header layout. The data flow (threads, send, polling, confirm/cancel, overdue handling) is unchanged. No worker, SQL, migration, API or `logic.js` change. Nothing here touches sending, the kill switch, secrets or production data.

| Check | Result |
|---|---|
| Frontend tests (`node --test src/intelligence/*.test.mjs src/chat/*.test.mjs`) | 311 pass (306 + 5 new), 0 fail |
| JSX syntax check of `ChatView.jsx` and `MessageList.jsx` (TypeScript transpile) | No errors |
| Production build (`vite build`) | **Not run** (no node_modules in the archive) |
| Visual check in a browser (desktop, phone width, light theme) | **Not run** |
| Worker tests, SQL tests, live Gemini/Ollama | Not run (not affected) |

## 2. What changed

### `src/intelligence/ChatView.jsx` (rewritten view layer)
| Area | Before | After |
|---|---|---|
| Styling | Inline styles, `S`/`T` from `finance/ui.jsx` | `chat/chat.css`, `chat-root chat-theme-{theme} chat-page` |
| Theme | Own colours | Shared tokens. New optional `theme` prop, default `"dark"` (same default as `InboxModule`; `App.jsx` passes none) |
| Messages | Hand-built bubbles, manual scroll | Shared `MessageList` (day separators, grouped bubbles, typing dots, stick-to-bottom, "jump to latest") |
| Input | `TextArea` + Send button, Ctrl+Enter | Shared `Composer` (auto-grow, emoji, 2000-character limit). **Enter sends**, Shift+Enter is a new line |
| Chat history | `<select>` | Sidebar of chats (`chat-row`), New chat button. On phones it switches between history and conversation |
| Header | `Section` title and pill | `chat-header` with avatar, title and worker-status dot |
| Suggestions | Buttons above the textarea | Scrollable pill strip above the composer |
| Notices | `Banner` | `chat-alert` (error, worker not online, overdue) inside the message list |
| Emma-only content | Inline | Tool labels, provenance line ("Answered by…") and Confirm/Cancel action cards render inside the assistant bubble via `message.extra` |
| Typing | "Working on it…" text | "Emma is typing…" while waiting |

Kept as is, because tests match on them: `if (value == null) setText("")` and the exact `fresh` (New chat) guard that avoids creating a second empty thread. The new-chat handler also returns to the conversation view on phones.

### `src/chat/MessageList.jsx` (shared, additive)
Two optional message fields, ignored by every existing caller:
- `message.extra`: a React node rendered inside the bubble after the body and attachments.
- `message.isError`: adds the `is-error` class to the row.

### `src/intelligence/emma-chat.css` (new)
Wrapper height (`clamp(480px, 100dvh − 250px, 780px)`, shorter on phones), action-card, chip-strip, status-dot and error-bubble styles. Everything else comes from `chat.css`.

## 2b. Bug check (second pass) and fixes
| # | Bug | Fix |
|---|---|---|
| 1 | `useLoad` keeps the previous result while a new one loads, so switching chats briefly showed the old chat's messages and "typing" state. | Results are tagged with their thread and ignored for any other; loading state shows meanwhile. (Existed before; the new sidebar made it easy to hit.) |
| 2 | A failed send that actually reached the server was retried with a new client key, so the server could not drop the duplicate and the message (and any action it triggers) could be queued twice. | A retry of the same text in the same chat reuses its key; cleared on success. The server already dedupes on (thread, key). |
| 3 | Phone: New chat did nothing when the current chat was empty (early return left the history list showing). | The button returns to the conversation first. |
| 4 | The Send button spun while Confirm/Cancel ran. | Spinner only while a message is being sent. |
| 5 | Wrapper border was a fixed dark colour, wrong with `theme="light"`. | Border moved onto the themed page using `--c-line`. |
| 6 | Chip strip had no group role. | Added `role="group"`. |

Checked and fine: server dedupe and 2000-character limit match the composer; polling and the 30 s refresh still surface late answers; grouping, day separators and scroll pinning work with Emma's data; markdown in replies is parsed as text only (links are http(s) with `noopener nofollow`).
Note: replies are now rendered with the shared markdown-lite parser, so `- ` / `1.` lines become lists and URLs in research text become clickable. Previously everything was literal text.

## 3. Behaviour changes to be aware of
1. Enter now sends (was Ctrl+Enter). The footer under the composer says so.
2. The paperclip is hidden (`canAttach={false}`). Emma takes no files.
3. The emoji button in the composer is visible because it is part of the shared Composer. Hide it if unwanted.
4. Chat history is a sidebar, not a dropdown, so the tab is wider and uses the Inbox's two-pane layout.
5. A user message has no sending/retry state. Sending still goes through `useBusy`, as before.
6. Emma's replies carry an "AI" badge and the avatar "E".

## 4. Not verified, please check
- Build the app and open the Emma tab in dark and light themes, on desktop and on a phone.
- Confirm/Cancel cards: contrast inside the blue assistant bubble (the card uses a dark translucent background). Check the `Btn`/`Pill` colours there, since they still come from the finance UI kit.
- The `emma-wrap` height inside the Intelligence page (the tab bar and heading above it vary).
- The Inbox's `chat-page` is not given a fixed height by `.inbox-page-wrap`. Emma sets its own with `.emma-wrap`.
- The new tests read the source; none renders the component. A render test needs the project's React/jsdom setup, which was not in the archive.

## 5. Files
- `src/intelligence/ChatView.jsx` (modified)
- `src/intelligence/emma-chat.css` (new)
- `src/chat/MessageList.jsx` (modified: `extra`, `isError`)
- `src/intelligence/emma-shared-chat.test.mjs` (new, 5 source-contract tests)

Rollback: restore the previous `ChatView.jsx`, delete `emma-chat.css`, and the two `MessageList` additions can stay (unused).

## 6. Gemini for everything (decision of 13 Nov 2026)
Owner decision: Gemini handles every AI call (discovery, research, drafting, classification, Agent Chat), with Ollama as the automatic fallback.

Settings (`intelligence-worker/.env.example`, and the same lines must be set in `C:\ProgramData\KairFlowIntelligence\worker.env`):
```
KAIRFLOW_GEMINI_API_KEY=<already saved by enable-gemini.ps1>
KAIRFLOW_AI_D1=C
KAIRFLOW_AI_POLICY=default=gemini_first
KAIRFLOW_AI_FORCE_OLLAMA=0
```
Verified by simulation: with these values every call site resolves to Gemini first, except `health.ollama` (the selftest check of the fallback, on purpose). No settings warnings. Worker tests: 953 pass. The old template test (chat on Gemini, drafting and classification on Ollama) was replaced by one that checks every site.

Consequences to be aware of:
1. Private correspondence, CRM contacts, inbound email and chat history go to Google unredacted. On the free tier Google may use prompts to improve its products (the `.env.example` header still says "free tier only").
2. One shared quota: the local caps `KAIRFLOW_GEMINI_RPM=10` / `RPD=200` now cover all work. With the 25% draft reserve, non-drafting calls stop at 150 a day and drafting at 200. Check the real limits for `gemini-3.8-flash` in AI Studio and adjust; they were never confirmed from Google.
3. When the quota is used up the worker falls back to Ollama for each call, so drafting and chat keep working but slower and with the smaller local models.

Steps on the machine: edit `worker.env` with the three lines above, restart the worker (Settings > Stop Emma / Start Emma), run `python -m kairflow_intel selftest gemini` and read the "INFO routing" lines. In the Emma tab a reply should say "Answered by Gemini (…)".
Rollback: `KAIRFLOW_AI_FORCE_OLLAMA=1`, or `KAIRFLOW_AI_D1=A`, then restart.

## 7. Typing indicator (13 Nov 2026)
While Emma has not answered yet, the thread shows an Emma bubble (avatar "E") with three bouncing dots and "typing…", instead of a plain line. Implemented as an optional `typingStyle="bubble"` / `typingAvatar` on the shared `MessageList` (other chats keep the old line). Dots stop animating under reduced-motion settings. The "no answer yet" warning after five minutes is unchanged. Tests: 312 pass.

## 8. Third bug check (13 Nov 2026)
| # | Bug | Fix |
|---|---|---|
| 7 | If loading a chat failed, the thread showed "Loading messages…" forever and the error was never shown (load errors were never displayed; the thread-tagging fix in section 2b made it permanent). | Load errors from messages, actions or the chat list show as a notice ("It will retry automatically", polling and the 30 s refresh retry); the spinner stops on error. |

Checked and fine: the worker's env loaders (`controller.py`, `run-worker.ps1`, `repair-controller.ps1`, `enable-gemini.ps1`) split on the first `=`, so `KAIRFLOW_AI_POLICY=default=gemini_first` is read correctly. Retry key handling, new-thread-then-failed-send, thread switching, polling cleanup and the typing bubble were re-read with no further problems. Tests: 313 frontend, 953 worker, all pass.
