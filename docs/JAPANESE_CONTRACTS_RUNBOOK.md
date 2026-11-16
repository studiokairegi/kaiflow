# Runbook: Japanese client contracts (EN/JA), `src/migration_contract_language.sql`

Mirrors the invoice language feature (`docs/INVOICE_LANGUAGE_RUNBOOK.md`): the language belongs to the **contract**, is
chosen when the signing link is created, and is frozen with it. The same `?share=contract&token=…` link is used; Japanese
links also carry `&lang=ja` so the loading / invalid-link screens are already Japanese.

## What the Japanese signer gets
- Signing page: buttons, consent checkbox text, key-terms box, decline flow, error messages in Japanese.
- Contract text: built-in 業務委託契約書 template (甲 = client, 乙 = studio), editable per studio under
  *Edit contract template → 日本語 (Japanese)*. Dates are 2026年3月15日; yen fees have no decimals.
- Optional "Scope in Japanese" field on the create form (replaces the project notes for that contract only).
- Signed PDF (contract + certificate page) in Japanese, using `public/fonts/kairflow-jp.ttf` (same font as Japanese invoices).
- "Open in email" draft written in Japanese.

## Deploy order
1. Back up the database.
2. Run `src/migration_contract_language.sql` in the Supabase SQL editor (after `migration_client_contracts.sql`).
   It is backward compatible: the old frontend keeps working (English contracts, 10-argument `create_client_contract`).
3. Deploy the frontend. Make sure `/fonts/kairflow-jp.ttf` is served (it already is if Japanese invoice PDFs work).
4. Smoke test: create an English and a Japanese contract for a test client; open both links in a private window; sign the
   Japanese one (draw and type, with a kanji name); download the signed PDF; confirm the certificate page is Japanese.

Frontend-before-migration: English contracts still work. Creating a **Japanese** contract before the migration fails
(the database refuses the unknown `p_language` argument), deliberately.

## Rollback
`src/migration_contract_language.rollback.sql` restores the original functions and drops the language columns
(DATA LOSS: each contract's language and the studio's Japanese template text). Roll the frontend back first.

## Needs a human (not code)
- Have a Japanese-reading lawyer / 行政書士 review the Japanese template before real use. In particular: whether copyright
  (including the 著作権法27条・28条 rights) **transfers** to the client or is only **licensed** (the template, like the
  English one, only grants use after full payment), the 準拠法/管轄 wording, and whether the client wants a 反社条項.
- The signature is a click-through e-signature with an audit trail (time, IP, browser, document SHA-256). Some Japanese
  companies require a specific e-signature service or their own contract format; ask before relying on it for them.
- Scope text, shot titles and names are printed exactly as typed. Use the "Scope in Japanese" field when project notes are English.
