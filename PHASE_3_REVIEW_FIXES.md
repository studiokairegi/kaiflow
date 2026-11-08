# Phase 3 review fixes (Japanese communication)

1. policy.py: Japanese Outlook separators (-----元のメッセージ-----, 差出人:, 送信日時: ...) and Japanese attribution lines
   (…さんは書きました:, Gmail 2026年11月8日(日) … <a@b>:) now end the sender's new text, so our own quoted opt-out footer
   can no longer be read as an unsubscribe.
2. drafting._is_consequential_japanese_inbound now reads the sender's body; policy.CLASS_PATTERNS gained 価格, 単価, 報酬,
   請求, お支払い, 保証, 確約, 稼働, 人数, クレーム, 返金, 不誠実.
3. compose_japanese grounding: stock courtesy sentences are exempt; factual sentences are checked on kanji/katakana content
   terms (not particle-padded bigrams); evaluative claims (評価, 人気, 順調, 増員, 若手育成, ...) need evidence; sign-off
   regex accepts comma forms.
4. One language decision: is_japanese_animation_prospect delegates to should_use_japanese (explicit language beats country,
   "ja-JP" works); compose_english no longer refuses Japan-country prospects; takeover English path passes language "en"
   so it can never fall into the Japanese templates.
   Test change: tests/test_logic.py Japanese-template test now uses language "" (country fallback) instead of "en".
5. takeover: Japanese drafts get the same similarity check (one regeneration, then needs_human) and their evidence trace
   is stored.
6. Salutation: family name alone (佐藤様), company line above the name, and "ご担当 佐藤様" are accepted; wrong names and
   generic greetings for a named contact are still rejected.

New tests: intelligence-worker/tests/test_phase3_bugfixes.py (26 of its cases fail on the previous pass).
No deployment, push, worker activation, or email sending occurred.
