# Invoicing bug audit and fixes — 2026-11-15

Baseline: `KairFlow_merged_client_language_emma_audit.zip` (the `_1` upload is byte-identical). No `.git` in the zip; the exact change is in `invoicing-bugfix.patch` (apply with `patch -p1` from the repo root).

## Confirmed bugs fixed

### 1. Invoice references collided across projects (blocked saving, milestones failed silently)
- **Cause:** `migration_settings_v2.sql` creates the unique index `invoices_user_number_uniq` on `(user_id, invoice_number)`, but every suggestion in `App.jsx` numbered from the current project's invoices only (New invoice button, project picker, invoices tab, follow-up document fallback, milestones). A second project was suggested `INV-0001` again, the save failed with 23505, and the alert told the user to reopen the editor, which suggested the same number. `handleCreateMilestones` swallowed the 23505 with no message.
- **Fix:** new `src/invoiceNumbering.js`. Suggestions come from all invoices the user owns (`ownInvoices` in `App.jsx`), never reuse an existing reference (case-insensitive), and skip taken numbers. `handleGenerateFollowupDoc` keeps the series number (PRO-0004 -> INV-0004) only while it is free, otherwise falls back to the next free number. Milestone creation now shows the ledger / duplicate-reference message.
- **Caveat:** the unique index is only created if no duplicates existed when `migration_settings_v2.sql` ran. If production has duplicates the index may be missing; check with `select indexname from pg_indexes where indexname = 'invoices_user_number_uniq';`.

### 2. PDF had no pagination
- **Cause:** `downloadInvoicePDF` drew every block at fixed offsets and never started a new page (only the Pay Now button checked the page height). About 25+ line items, or long descriptions / payment instructions, ran off the page.
- **Fix:** new `src/invoicePdfLayout.js` (`flowLines`, `ensureSpace`). Line items break across pages with the column header repeated; the subtotal and the totals block are kept together; description, "How to pay", note and footer flow across pages. A document that fits on one page is laid out exactly as before.

### 3. PDF never printed the invoice number; every download was `invoice.pdf`
- **Cause:** the PDF showed only "Payment ref." (and only once a Paystack payment existed) and named the file after that reference, falling back to `invoice`.
- **Fix:** the PDF prints `Reference no.: <number>` (Japanese: `書類番号: <number>`; new i18n key `number` in both languages) below the title. "Payment ref." is still printed when a Paystack payment exists. The file is named after the document reference (`INV-0007.pdf`), with sanitising, then the Paystack reference, then `invoice`.
- **Behaviour change to confirm:** English PDFs now have one extra line, and file names changed. If you deliberately wanted invoice numbers hidden from clients (see the comment in `invoiceRefs.js`), revert the `refNumber` lines in `downloadInvoicePDF`. The `/pay` checkout page already shows the invoice number to clients.

## Files changed
- `src/App.jsx` — numbering call sites, follow-up and milestone handlers, `downloadInvoicePDF`
- `src/i18n/invoiceStrings.js` — `number` key (en, ja)
- New: `src/invoiceNumbering.js`, `src/invoicePdfLayout.js`, `src/invoiceNumbering.test.mjs`, `src/invoicePdfLayout.test.mjs`

No database changes, no migrations, no function or config changes.

## Tests
`npm test` equivalent (`node --test`): 1292/1292 before, 1306/1306 after (14 new). The PDF tests run the real `downloadInvoicePDF` from `App.jsx` against a stand-in for jsPDF and assert: one page for a short invoice, 60 line items and a 5,000-character description flow to extra pages, nothing is drawn below the bottom margin, totals stay together, the reference line and file name are correct, Japanese label.

## Not verified
- Real jsPDF rendering and `vite build` (no `node_modules`, no network here). Please download one long and one short invoice in English and Japanese after deploying.
- SQL tests (`supabase/tests/*.sql`) were not run (no Postgres).

## Found but intentionally not changed (minor, not confirmed as defects)
- `nextInvoiceNumber` takes the trailing digits of any reference, so `INV-2026` suggests `INV-2027` (the collision guard still prevents duplicates).
- The frontend always sends `p_language`; before migration `20270111090000` runs, the pay link silently fails and the PDF has no Pay Now button.
- `refreshInvoiceRefs` returns an in-flight request, so a refresh right after a payment can miss it.
- Editor: switching document type back from Receipt leaves status "paid"; changing the type of a saved, ledger-posted invoice is rejected by the guard trigger with a generic message.
- Milestone amounts are rounded per milestone (up to a cent off the budget); a percentage total other than 100 only warns.
