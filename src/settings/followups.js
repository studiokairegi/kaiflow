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

// How many email slots to SHOW for a lead: the studio's schedule length, but never
// hide a slot that already has something in it (sent, or a drafted message), so
// shrinking the cadence can't make a lead's existing work disappear.
export function visibleSlotCount(emails, schedule) {
  const list = emails || [];
  let lastUsed = -1;
  list.forEach((e, i) => { if (e && (e.sent || (e.message || "").trim())) lastUsed = i; });
  return Math.min(list.length, Math.max(schedule.length, lastUsed + 1));
}

// "2/3 emails sent" - sent count out of the slots that are shown.
export function emailsSentSummary(emails, schedule) {
  const list = emails || [];
  const total = visibleSlotCount(list, schedule);
  const sent = list.slice(0, total).filter((e) => e.sent).length;
  return { sent, total };
}

// "Needs follow-up" flag with its own date. Due once that date is today or earlier.
// `today` is a YYYY-MM-DD string in the user's timezone (see todayInZone).
export function isManualFollowupDue(lead, today) {
  return !!lead && !!lead.needsFollowup && !!lead.followupDate && lead.followupDate <= today;
}

// null when there is no dated flag; otherwise "overdue" | "today" | "upcoming".
export function manualFollowupState(lead, today) {
  if (!lead || !lead.needsFollowup || !lead.followupDate) return null;
  if (lead.followupDate < today) return "overdue";
  return lead.followupDate === today ? "today" : "upcoming";
}
