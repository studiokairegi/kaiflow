# Indie Game Developers Campaign V2 — Personalized Outreach and Reply Handling

**Session:** 6  
**Migration:** `20261112192000_intelligence_indie_outreach_v6.sql`  
**Scope:** Project-specific first contact, portfolio-sharing policy, deterministic reply outcomes, and the Indie follow-up/re-engagement sequence.

## 1. First-contact drafting

The English and Japanese composers now receive the verified project title explicitly. For an Indie prospect with a project title, a first-contact draft is accepted only when all of the following are true:

- The model cites at least one verified project-specific evidence row and one verified visual-style/visual-asset evidence row.
- Project evidence identifies the exact game title.
- The body names the exact game and contains at least two meaningful terms grounded in the cited project/visual evidence.
- The email describes a concrete cinematic opportunity (for example, a teaser, trailer, animated sequence, or visual direction).
- It introduces Studio Kairegi as an anime animation studio (with the equivalent Japanese-language requirement on the Japanese path).
- It ends with a natural question.
- It contains no em dash and no URL of any kind.

The project/visual evidence gate is in addition to the existing evidence-ID trace, sentence-level grounding, claim/entity/number checks, approved-studio-facts validation, similarity check, compliance footer, and human approval. Visual evidence remains human-verified; discovery of an image/video URL alone is not sufficient.

If a source-backed Indie prospect reaches the draft handler without an exact project title, the handler flags it for review and does not create an initial draft. The low-level composer retains compatibility for older non-project fixtures, but the production draft handler fails closed for source-backed projects missing a title.

## 2. Portfolio and website policy

Portfolio and studio website links are not included in initial, follow-up, or re-engagement messages. The same cold-outreach policy blocks unsolicited portfolio/showreel/reel/sample language, not just URLs. The Japanese policy avoids treating references to the recipient's own production record as a portfolio offer.

Portfolio material can be included in a reply only when the inbound message explicitly requests it. The composer receives the portfolio knowledge-base entry only for that reply intent. `policy.validate_outbound` independently blocks links and portfolio language for cold initial/follow-up messages, including the takeover workflow. Re-engagement is persisted as `followup`, so it receives the same final policy check.

Pricing, discount, free-work and guarantee restrictions remain unchanged. No website URL is appended to first-contact copy.

## 3. Reply outcomes and actions

The classifier supports these additional explicit outcomes:

| Outcome | Action | Suppression behavior |
|---|---|---|
| `not_now` | Pause and require human review of whether later contact is welcome | Not an unsubscribe/DNC by itself |
| `not_interested` | Stop the sequence | Not an unsubscribe/DNC by itself |
| `already_has_trailer` | Stop the sequence and review future need | No automatic DNC |
| `wrong_person` | Human review to correct recipient | No automatic DNC |
| `referral` | Human review of the referral | No automatic DNC |
| `tell_me_more` | Prepare a personalized reply for human approval | No automatic sending |

Existing deterministic bounce, unsubscribe, complaint, pricing, contract, negotiation, deadline, availability and meeting handling remains higher priority than AI classification. Unsubscribe and complaint continue to use the existing suppression RPC behavior. `not_interested` is deliberately separate from unsubscribe: it stops the current sequence without asserting a permanent legal opt-out.

The worker writes a `reply_outcome_action` audit event with the normalized outcome and intended action. A `tell_me_more` reply can be drafted, but model-written replies remain pending human approval. Other non-green outcomes are recorded and escalated rather than auto-replied to.

Any inbound message continues to interrupt the cold follow-up sequence. The database candidate query excludes prospects with any inbound message; takeover handling applies the same stop/review distinctions.

## 4. Indie sequence

The Indie sequence is anchored to the original sent initial message, not the most recent reminder:

| Stage | Due date | Composition kind | Stored message kind |
|---|---|---|---|
| 1 | 5 business days after initial | `followup` | `followup` |
| 2 | 10 business days after initial | `followup` | `followup` |
| 3 | 3 calendar months after initial | `reengagement` | `followup` |
| 4 | 6 calendar months after initial | `reengagement` | `followup` |

Month arithmetic clamps to the final day of the target month when the original day does not exist (for example, January 31 plus three months becomes April 30).

Both re-engagement stages require a verified, dated development update or marketing milestone newer than the original introduction. A newly discovered page, a crawl timestamp, or an old project fact is not sufficient. The composer must cite a dated project-update/marketing fact. If the evidence gate fails, the job is held and no message is created.

The same Indie timing is applied to CRM takeover conversations. Non-Indie campaign scheduling retains its existing configured business-day cadence and three-slot limit.

### Organization setting

`intel_settings.max_followups` now permits values from 0 to 4 and defaults to 4 for newly created settings rows. Existing organization values are **not overwritten** by the migration. An existing organization must deliberately set `max_followups = 4` to enable all four Indie sequence stages. If the current value is 1, only the first follow-up stage is enabled. Non-Indie scheduling remains capped at three follow-up slots in the database candidate query, and its worker step limit remains three.

## 5. Preserved safety controls

- Initial drafts and model-written replies remain pending human approval (`p_auto_ok=false` for model-written content).
- Existing kill switch, campaign state, send-window, daily cap, provider capability/quota, suppression, CRM recipient-match and final send-reservation gates are unchanged.
- No outbound send is performed by this session.
- Existing compliance footer, physical address, opt-out wording, message-size, price/guarantee, unsupported-claim, URL and near-duplicate checks remain active.
- Project evidence IDs continue to be stored with model-written drafts.
- No portfolio is offered unless the recipient explicitly requests it.

## 6. Files changed

### Worker code
- `intelligence-worker/kairflow_intel/drafting.py`
- `intelligence-worker/kairflow_intel/policy.py`
- `intelligence-worker/kairflow_intel/classify.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/takeover.py`
- `intelligence-worker/kairflow_intel/chat.py`
- `intelligence-worker/kairflow_intel/indie_outreach.py` (new)

### Tests
- `intelligence-worker/tests/test_indie_outreach_v6.py` (new)
- `intelligence-worker/tests/test_logic.py`
- `intelligence-worker/tests/test_phase2_fixes.py`
- `intelligence-worker/tests/test_phase5_audit_fixes.py`
- `intelligence-worker/tests/test_takeover.py`
- `intelligence-worker/tests/test_v1.py`

### Database
- `supabase/migrations/20261112192000_intelligence_indie_outreach_v6.sql` (new)

No frontend UI was added. Session 7 owns the review UI, reply-state presentation, settings controls, browser E2E and release integration.

## 7. Validation

| Check | Result |
|---|---:|
| Python unit tests | **863 passed, 0 failed** |
| Python compileall | Passed |
| Frontend/Node tests | **1,126 passed, 0 failed** |
| Production build | Blocked: `node_modules/vite/bin/vite.js` is absent |
| PostgreSQL migration execution | Not run: no `psql`, Supabase CLI or staging database available |
| Browser E2E | Not run; no running app/browser environment |
| Live provider sends | Not run |
| Production deployment | Not performed |

The Python test run still emits existing AI-router/preflight warnings about Gemini quota/auth and local Ollama availability. These are not test failures and do not demonstrate live provider health.

## 8. Migration and rollout notes

The migration is not applied. The repository includes migration files dated later than the audit date, so the deployed Supabase migration ledger must be reconciled before application. Review the function body and grants in staging, verify that existing organization `max_followups` values remain unchanged, set the intended Indie sequence limit explicitly, and test the function with both Indie and non-Indie prospects. No production or staging database was modified.

## 9. Explicitly out of scope

- Session 7 frontend integration, review screens, reply-state controls and browser E2E.
- Applying migrations or changing live organization settings.
- Sending messages, contacting developers, or running live outreach.
- Enabling Steam, itch.io or Kickstarter automated access.
