"""Deterministic Indie reply outcomes and sequence schedule helpers."""
from __future__ import annotations

import calendar
from datetime import date, timedelta


OUTCOME_ACTIONS = {
    "bounce": "review_delivery_failure_and_permanent_suppression_if_confirmed",
    "out_of_office": "wait_for_return_no_followup_reset",
    "rejection": "stop_sequence_not_dnc",
    "other": "human_review",
    "unsubscribe": "permanent_suppression",
    "complaint": "permanent_suppression_and_human_review",
    "not_interested": "stop_sequence_not_dnc",
    "not_now": "pause_and_review_reengagement_permission",
    "already_has_trailer": "stop_sequence_and_review_future_need",
    "wrong_person": "human_review_contact_correction",
    "referral": "human_review_referral",
    "tell_me_more": "prepare_reply_for_human_approval",
    "portfolio_request": "share_portfolio_in_reply_only",
    "positive": "prepare_reply_for_human_approval",
    "meeting_request": "human_review_scheduling",
    "pricing": "human_review_pricing",
    "negotiation": "human_review_negotiation",
    "contract": "human_review_contract",
    "deadline": "human_review_deadline",
    "availability": "human_review_capacity",
    "ambiguous": "human_review",
}


def _add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def business_days_between(start: date, end: date) -> int:
    """Count weekdays after start through end, matching the SQL helper's exclusive start."""
    if end <= start:
        return 0
    count, cursor = 0, start + timedelta(days=1)
    while cursor <= end:
        if cursor.weekday() < 5:
            count += 1
        cursor += timedelta(days=1)
    return count


def due_sequence_stage(initial_sent: date, today: date, sent_followups: int) -> str | None:
    """Return followup/reengagement when stage is due; None means not due or sequence complete.

    Stage 0: business day 5. Stage 1: business day 10. Stage 2: month 3.
    Stage 3: month 6. The caller must still enforce max_followups, inbound stop,
    send windows, approval, suppression, and the evidence gate for re-engagement.
    """
    if sent_followups < 0 or sent_followups >= 4:
        return None
    if sent_followups == 0 and business_days_between(initial_sent, today) >= 5:
        return "followup"
    if sent_followups == 1 and business_days_between(initial_sent, today) >= 10:
        return "followup"
    if sent_followups == 2 and today >= _add_months(initial_sent, 3):
        return "reengagement"
    if sent_followups == 3 and today >= _add_months(initial_sent, 6):
        return "reengagement"
    return None
