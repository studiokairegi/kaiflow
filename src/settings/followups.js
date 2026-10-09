// Follow-up cadence logic. A lead keeps its OWN email slots (initial + N follow-ups);
// the studio schedule decides which of them are scheduled. Nothing here ever deletes
// a lead's slots when the schedule shrinks, and nothing assumes "5 emails".

const slot = (label) => ({ label, message: "", sent: false, dateSent: null });

export function emptyEmailSlots(scheduleLength) {
  const slots = [slot("Initial Email")];
  for (let i = 1; i < Math.max(2, scheduleLength); i += 1) slots.push(slot(`Follow-up ${i}`));
  return slots;
}

// Returns the lead's own slots, padded UP to the schedule length (never truncated).
export function normalizeEmailSlots(emails, scheduleLength) {
  const base = emails && emails.length ? emails : emptyEmailSlots(scheduleLength);
  if (base.length >= scheduleLength) return base;
  const padded = [...base];
  while (padded.length < scheduleLength) padded.push(slot(`Follow-up ${padded.length}`));
  return padded;
}

// Index of the final slot that is actually scheduled for this lead.
export function lastScheduledIndex(emails, schedule) {
  return Math.min(schedule.length, emails.length) - 1;
}

// Next unsent slot that falls inside the schedule; -1 when outreach is complete.
// Slots beyond the schedule are never "due".
export function nextScheduledIndex(emails, schedule) {
  const last = lastScheduledIndex(emails, schedule);
  return emails.findIndex((e, i) => !e.sent && i <= last);
}

export function followupCountLabel(emails, schedule) {
  const n = lastScheduledIndex(emails, schedule);
  return `${n} follow-up${n === 1 ? "" : "s"}`;
}

// Should sending slot `index` auto-move a Cold Email lead to No Response?
// Only the final scheduled follow-up does (and only if the studio keeps that on).
export function sendingTriggersNoResponse({ index, sent, stage, emails, schedule, autoNoResponse }) {
  if (!autoNoResponse || !sent || stage !== "cold_email") return false;
  return index > 0 && index === lastScheduledIndex(emails, schedule);
}
