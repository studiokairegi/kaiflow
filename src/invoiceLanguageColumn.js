// Deploy-order safety for the `invoices.language` column (migration 20270111090000).
//
// Rule: never send `language` to a database that does not have the column.
//  - A row loaded from the database tells us: if it carries a `language` key the column exists
//    (invoiceFromRow records that as `languageColumn: true`).
//  - A brand-new invoice has no row yet. A new ENGLISH invoice omits the field (the database default applies), so it
//    saves on an unmigrated database. A new non-English invoice must send it, and fails loudly if the column is
//    missing, which is correct: silently saving it as English would send the client the wrong language.
import { normalizeLang } from "./i18n/languages.js";

export function rowHasLanguageColumn(row) {
  return !!row && Object.prototype.hasOwnProperty.call(row, "language");
}

export function invoiceLanguageFields(invoice) {
  const language = normalizeLang(invoice?.language);
  if (invoice?.id) return invoice.languageColumn === true ? { language } : {};
  return language !== "en" ? { language } : {};
}
