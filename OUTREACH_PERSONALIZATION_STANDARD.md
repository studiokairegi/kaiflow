# KairFlow Intelligence — Outreach Personalization Standard (Phase 6)

**Scope:** Master roadmap Phase 6, task 5-6, 14 and the Business Rules section ("identify suitable
contact people", "draft personalized initial outreach using Studio Kairegi's approved positioning",
"preserve existing email provider adapters", "present Studio Kairegi as a studio, not an individual
freelancer", "do not offer unpaid samples", "do not invent client requirements/capacity/pricing").

**Baseline inspected this session:** `kairflow_intel/drafting.py`, `policy.py`, `contactability.py`,
`gemini.py`, `providers/` (gmail.py, zoho.py, smtp.py, router.py, registry.py), and the matching test
files (`test_indie_outreach_v6.py`, `test_phase5_drafting_routing.py`, `test_indie_research_integrity_v6.py`).

## 1. Contact identification (task 5) — already in place

`contactability.assess()` (used by both `research.qualify()` branches) turns raw contact evidence into
a `pass | needs_review | rejected` status from verifiable signals only: a verified source URL, an
explicit employee-affiliation statement, delivery evidence, and suppression/bounce/complaint facts
looked up via `intel_agent_contactability_facts` / `intel_agent_indie_suppression_facts`. A missing or
unavailable suppression lookup is treated as `needs_review`, **never** as a pass — an address is never
upgraded to contactable on missing information.

## 2. Personalized drafting (task 6) — already in place, verified by re-reading the composer

`drafting.py` builds every outreach message from the studio's own approved knowledge-base entries
(`kb["studio.about"]`, `kb[TYPE_KEY[ptype]]`, Japanese counterparts with `.ja` suffixes) plus a
one-sentence "hook" grounded in a *verified* evidence snippet for that specific prospect
(`plain_hook()`, or `model_hook()` when an AI router is available). `model_hook()` already refuses any
AI-written hook that:
- is outside a 30-220 character length band, contains a newline, a URL, a digit, a price/free/discount
  phrase, or an unverifiable claim (`policy.FALSE_CLAIMS`); or
- is not majority-grounded in the actual verified snippets passed to it (≥50% of its content words must
  already appear in the evidence text).

A rejected AI hook falls back to the deterministic `plain_hook()` — drafting never blocks on the model.

## 3. Business rules — enforced as code, not as instructions to the model

| Business rule | Where it is enforced |
|---|---|
| Present Studio Kairegi as a studio, not a freelancer | `kb["studio.about"]` is the single approved paragraph every draft is built from; the model is never asked to describe the studio freely. |
| No unpaid samples / no portfolio before request | `policy.UNSOLICITED_PORTFOLIO` blocks cold-outreach bodies that mention a portfolio/showreel/samples; `policy.validate_outbound` rejects any `initial`/`followup`/`reengagement` draft containing a link at all (`policy.URL.search(body)`), so a portfolio link cannot even be attached. |
| No invented requirements, capacity, pricing, or relationships | `policy.FALSE_CLAIMS` / `FALSE_CLAIMS_JA` block claims of prior contact, meetings, or experience the research doesn't support; `policy.PRICE_IN_DRAFT` / `PRICE_IN_DRAFT_JA` block any price, discount, "free", or guarantee language in cold outreach, in **both** languages. |
| Must not send automatically because a model recommends it | Every draft is written to a `pending` message row; sending is a **separate**, explicitly-approved action (`mailops.send_message`) gated by `intel_agent_reserve_send` / `intel_agent_mark_sending`, which re-checks the kill switch at the last possible step before the provider call. Nothing in `drafting.py` can send a message. |
| Respect suppression / daily caps / kill switch | See `FOLLOWUP_WORKFLOW.md` and `EMAIL_SAFETY_TESTS.md`. |

`validate_outbound()` additionally enforces a hard body-length cap (`MAX_BODY_CHARS=3200`), a
mandatory opt-out sentence and physical postal address in every cold-outreach body, and a check that
every URL present is on the campaign's approved list or the prospect's own verified domain — a draft
failing any of these is a validator rejection, not a soft warning.

### Uniqueness / anti-boilerplate check

`uniqueness_check()` compares a new draft against the sender's own prior drafts (token-overlap
similarity on the substantive body, with names masked out) so the same canned paragraph is not resent
to a string of near-identical prospects under a different name.

## 4. Email provider adapters — preserved, not touched this session

`providers/registry.py`, `router.py`, `gmail.py`, `zoho.py`, `smtp.py` and the Resend adapter remain
exactly as they were; the Phase 6 work in this session did not add, remove or edit any provider
adapter code. `mailops.send_message()` already resolves a concrete mailbox and provider via
`intel_agent_assign_provider_account` rather than hardcoding Gmail/Zoho/SMTP credentials into business
logic, satisfying the roadmap's explicit instruction on this point without any change being needed.

## 5. What this session did **not** re-verify

The grounding, language-detection (`should_use_japanese`), and false-claim regex coverage in
`drafting.py` and `policy.py` are extensive (several hundred lines of hand-tuned patterns across many
prior "Cloud sessions" — see the `PHASE_*_BUGFIX_*` reports already in this repository). This session
re-read them and ran the existing tests against them (see `EMAIL_SAFETY_TESTS.md`) but did not attempt
to re-derive or re-tune the regexes themselves; they were not identified as a Phase 6 gap, and
"avoid unnecessary rewrites" (Global Implementation Rule 3) argues against touching mature, tested code
with no found defect.
