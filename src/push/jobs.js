// Builds the timed alerts the app hands to the server so they still arrive after the tab is closed.
// Texts mirror what the open app shows (see advancePomodoroPhase in App.jsx).

export const POMODORO_KEY = "pomo:timer";
export const DIGEST_KEY = "digest:morning";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// `phase` is the phase that is running now and ends at `endsAt` (epoch ms). `nextBreak` is "break" or
// "longBreak" and `nextBreakMinutes` its length, both only used when a focus round ends.
export function pomodoroAlert({ phase, endsAt, cycle, rounds, nextBreak, nextBreakMinutes }) {
  if (!phase || !Number.isFinite(endsAt)) return null;
  const base = { key: POMODORO_KEY, due_at: new Date(endsAt).toISOString(), category: "focus", tag: "kairil-pomodoro", url: "/" };
  if (phase === "work") {
    if (cycle >= rounds) return { ...base, title: "Focus session complete", body: `${plural(rounds, "focus round")} finished. Nice work.` };
    const long = nextBreak === "longBreak";
    return { ...base, title: long ? "Long break time" : "Break time", body: `Round ${cycle} of ${rounds} done - ${plural(nextBreakMinutes, "minute")} to recharge.` };
  }
  if (phase === "break" || phase === "longBreak") {
    return { ...base, title: "Back to focus", body: `${phase === "longBreak" ? "Long break" : "Break"} over - ready for the next focus session.` };
  }
  return null;
}

// Next 09:00 in the browser's time zone, strictly after `now`.
export function nextMorning(now = new Date(), hour = 9) {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (+at <= +now) at.setDate(at.getDate() + 1);
  return at;
}

// A digest scheduled from what the app knew at the last visit. Returns null when nothing is pending.
export function digestAlert(counts, now = new Date()) {
  const parts = [
    counts.followupsDueToday > 0 && `${plural(counts.followupsDueToday, "follow-up")} due`,
    counts.hotAwaitingResponse > 0 && `${plural(counts.hotAwaitingResponse, "hot lead")} awaiting response`,
    counts.proposalsAwaitingResponse > 0 && `${plural(counts.proposalsAwaitingResponse, "proposal")} awaiting response`,
    counts.approachingDeadline > 0 && `${plural(counts.approachingDeadline, "lead")} approaching follow-up deadline`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return {
    key: DIGEST_KEY, due_at: nextMorning(now).toISOString(), category: "followups", tag: "kairil-needs-attention", url: "/",
    title: "CRM needs your attention", body: `${parts.join(" · ")} (as of your last visit)`,
  };
}
