# Phase 3 — second review fixes (Japanese communication)

Scope: defects found by the independent review of `KairFlow_Phase3_Eighth_Pass_Fixed`. Phase 4 not started.

| # | Defect | Fix |
|---|---|---|
| 1 | `メールで結構です` / `電話は不要です` read as unsubscribe; `それで結構です` read as rejection. Both permanently suppress the contact and close the prospect. | `policy.UNSUBSCRIBE`: Japanese alternatives are bounded to one sentence and skip channel statements (`メールで…`); `メールでの連絡は結構` stays an opt-out. `decline`: `(?<!で)結構です`. |
| 2 | Japanese amounts (`5,000円`, `￥5,000`, `30ドル`, `五千円`) passed the composer and `validate_outbound`. | New `policy.PRICE_IN_DRAFT_JA`, used by the composer, the knowledge-base check in `jobs.h_draft` and `validate_outbound` (so takeover and every path is covered). |
| 3 | `先日はお時間をいただき…` accepted in a first email. | New `policy.PRIOR_CONTACT_JA_INITIAL` (initial mail only; follow-ups may refer to our own mail) and `FALSE_CLAIMS_JA`; also in `validate_outbound`. Model instruction updated. |
| 4 | `ゲームもプレイいたしました` accepted when the evidence says `プレイヤー`. | `FALSE_CLAIMS_JA` blocks play/view/meeting claims outright (as English does); term grounding now needs ≥ 2/3 of two-character pieces, not 1/2. |
| 5 | An English message with a Japanese signature selected Japanese. | `_without_signature` / `_decisive_language`: language is read from the message body, not the signature block. |
| 6 | Reply subject was never enforced; an English-subject thread could not receive a Japanese reply. | Replies and follow-ups with a thread subject use exactly `Re: <thread subject>`; the model does not choose it. Japanese-subject and company-name rules apply only to unthreaded mail. |
| 7 | `佐藤花様` (truncated) and given-name-only `花子様` accepted. | Unspaced names: 2-character family name, or 3 only when ≥ 2 given-name characters remain. Spaced Japanese names: family-name token only. Latin names: either token. |
| 8 | `Thank you.` / `Sounds good` flipped a Japanese thread to English. | Stock English courtesy no longer establishes a language switch (our own sent mail is still judged normally). One existing test that encoded the old behaviour now uses a substantive English sentence. |
| 9 | Reply relevance rejected `こちらです` / `以下` link replies. | Phrase family extended (`こちら`, `以下`, `お送り`, `ご覧`). |
| 10 | `\b` around `配信停止` never matched in Japanese text; Japanese salutation lines were compared as substance. | `\b` removed; leading salutation lines (`…様`, `御中`, `ご担当者様`) are stripped before similarity. |
| 11 | Japanese takeover demanded the English knowledge base. | English `require_kb` skipped on the Japanese path; `compose_japanese` enforces the Japanese entries. |

Files: `intelligence-worker/kairflow_intel/{policy,drafting,jobs,takeover}.py`, `tests/test_phase3_japanese.py` (one test), `tests/test_phase3_review_fixes2.py` (new, 15 tests).
Housekeeping: removed the empty file `main` and the pasted git-diff file `bject -Skip 15`.

Verification: `python -m unittest discover -s tests -t .` → 360 passed (was 345); `node --experimental-strip-types --test` → 750 passed; compileall passed.

Not verified / still required before production: `npm run build` (dependencies not installed here); live Ollama output; native Japanese review; Supabase SQL on a disposable database.
Known limit: an unspaced name such as `長谷川花子` cannot reveal where the family name ends, so `長谷様` is accepted; store the contact name with a space to make the check exact.
Not changed: English composer still lets the model choose follow-up/reply subjects (Phase 2 scope); legacy fixed Japanese template builders remain as unused code.
No deployment, push, worker activation, autonomy change, migration or email sending occurred.
