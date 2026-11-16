import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLang, formatDocDate, defaultLanguageFor, interpolate, makeTranslator, DOC_LANGUAGES, isJapanese } from "./languages.js";
import { INVOICE_STRINGS, invoiceT } from "./invoiceStrings.js";
import { CHECKOUT_STRINGS, checkoutT, localizeError } from "./checkoutStrings.js";
import { wrapMixed } from "./pdfJapanese.js";
import { wiseInstructions } from "../payments/wise.js";
import { requestPayLink } from "../payments/pdfPayLink.js";

const placeholders = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");   // a placeholder may repeat in a sentence

test("normalizeLang accepts only supported languages and falls back to English", () => {
  assert.equal(normalizeLang("ja"), "ja");
  assert.equal(normalizeLang("JA"), "ja");
  assert.equal(normalizeLang("ja-JP"), "ja");
  assert.equal(normalizeLang("en"), "en");
  for (const bad of [null, undefined, "", "fr", "japanese", "jab", "j", 5, {}]) assert.equal(normalizeLang(bad), "en");
  assert.equal(isJapanese("ja"), true);
  assert.deepEqual(DOC_LANGUAGES.map((l) => l.code), ["en", "ja"]);
});

test("a new invoice starts in the language the project's client was last sent", () => {
  assert.equal(defaultLanguageFor([]), "en");
  assert.equal(defaultLanguageFor([{ language: "en" }, { language: "ja" }]), "ja");
  assert.equal(defaultLanguageFor([{ language: "ja" }, { language: "en" }]), "en");
  assert.equal(defaultLanguageFor([{ language: "ja" }, {}]), "ja");
});

test("English and Japanese dictionaries have exactly the same keys and placeholders", () => {
  for (const [name, dict] of [["invoice", INVOICE_STRINGS], ["checkout", CHECKOUT_STRINGS]]) {
    const en = Object.keys(dict.en).sort();
    const ja = Object.keys(dict.ja).sort();
    assert.deepEqual(ja, en, `${name}: key mismatch`);
    // The Japanese Wise steps split the details differently (country / provider / recipient name+number), so for
    // those three keys the exact expected placeholder set is pinned instead of mirroring English.
    const jaWiseSteps = { "wise.step2": "country", "wise.step3": "provider", "wise.step4": "name,phone" };
    for (const k of en) {
      const expected = name === "checkout" && k in jaWiseSteps ? jaWiseSteps[k] : placeholders(dict.en[k]);
      assert.equal(placeholders(dict.ja[k]), expected, `${name}.${k}: placeholders differ`);
    }
    for (const k of ja) assert.ok(String(dict.ja[k]).length > 0, `${name}.${k}: empty`);
  }
});

test("Japanese strings really are Japanese (no key silently left in English)", () => {
  const hasJa = (s) => /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
  const allowedSame = new Set(["fallbackFileName", "vat", "choose.emailPlaceholder", "method.apple_pay", "summary.client"]);
  for (const dict of [INVOICE_STRINGS, CHECKOUT_STRINGS]) {
    for (const [k, v] of Object.entries(dict.ja)) {
      if (allowedSame.has(k)) continue;
      assert.ok(hasJa(v), `ja.${k} has no Japanese: ${v}`);
    }
  }
});

test("English invoice strings are exactly what the PDF printed before", () => {
  const t = invoiceT("en");
  assert.equal(t("title.proforma"), "Proforma Invoice");
  assert.equal(t("ref.other", { title: "Receipt" }), "Receipt payment ref.");
  assert.equal(t("status.received", { on: t("status.receivedOn", { date: "2026-11-01" }) }), "Payment received on 2026-11-01");
  assert.equal(t("issueDate", { value: "2026-11-15" }), "Issue date: 2026-11-15");
  assert.equal(t("note.invoice", { studio: "Studio Kairegi" }), "Thank you for working with Studio Kairegi.");
  assert.equal(t("payNow"), "Pay Now");
  assert.equal(t("defaultDescription"), "Animation services");
});

test("Japanese invoice strings and dates", () => {
  const t = invoiceT("ja");
  assert.equal(t("title.invoice"), "請求書");
  assert.equal(t("title.receipt"), "領収書");
  assert.equal(t("issueDate", { value: formatDocDate("2026-11-15", "ja") }), "発行日: 2026年11月15日");
  assert.equal(formatDocDate("2026-11-15", "en"), "2026-11-15");
  assert.equal(formatDocDate("", "ja"), "-");
  assert.equal(formatDocDate("not a date", "ja"), "not a date");
  assert.equal(t("status.received", { on: t("status.receivedOn", { date: formatDocDate("2026-11-01", "ja") }) }), "入金確認済み（入金日: 2026年11月1日）");
});

test("unknown language and unknown key behave safely", () => {
  assert.equal(checkoutT("fr")("brand.badge"), "Payment");
  assert.equal(checkoutT("ja")("no.such.key"), "no.such.key");
  assert.equal(interpolate("a {x} b {y}", { x: 1 }), "a 1 b {y}");
  const t = makeTranslator({ en: { a: "A" }, ja: {} }, "ja");
  assert.equal(t("a"), "A");           // missing Japanese falls back to English, never to a blank
});

test("server errors are shown in the page language; English pages keep the server's own message", () => {
  const en = checkoutT("en"), ja = checkoutT("ja");
  assert.equal(localizeError({ message: "Boom", code: "x" }, en, "error.start"), "Boom");
  assert.equal(localizeError({ message: "Boom", code: "x" }, ja, "error.start"), CHECKOUT_STRINGS.ja["error.start"]);
  assert.equal(localizeError({ message: "Boom", code: "fx_unavailable" }, ja, "error.start"), CHECKOUT_STRINGS.ja["error.fx_unavailable"]);
  assert.equal(localizeError({ message: "Boom", code: "not_payable" }, ja, "error.start"), CHECKOUT_STRINGS.ja["error.not_payable"]);
  assert.equal(localizeError({}, en, "error.start"), CHECKOUT_STRINGS.en["error.start"]);
});

test("wiseInstructions: English unchanged, Japanese translated, same step count", () => {
  const tr = { country: "Kenya", mobile_provider: "M-PESA", recipient_name: "A B", phone: "+254712345678" };
  const en = wiseInstructions(tr);
  const ja = wiseInstructions(tr, "ja");
  assert.equal(en.steps[0], "Open Wise (website or app) and choose Send money.");
  assert.equal(en.steps[1], "Set the recipient's country to Kenya and choose Mobile wallet, then M-PESA. The amount delivered is in Kenyan shillings (KES).");
  assert.equal(ja.steps.length, en.steps.length);
  assert.equal(ja.warnings.length, 3);
  assert.match(ja.steps[1], /ケニア（Kenya）/);
  assert.match(ja.steps[2], /M-PESA/);
  assert.match(ja.steps[3], /A B/);
  assert.match(ja.steps[3], /\+254712345678/);
});

// A fake jsPDF text measurer: every CJK character is 4 units wide, everything else 2.
const fakeDoc = { getTextWidth: (t) => [...t].reduce((w, c) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 4 : 2), 0) };
test("wrapMixed breaks Japanese anywhere, keeps Latin words whole, honours newlines, and never starts a line with 。", () => {
  const lines = wrapMixed(fakeDoc, "あいうえおかきくけこ", 20);        // 5 chars per line
  assert.deepEqual(lines, ["あいうえお", "かきくけこ"]);
  const mixed = wrapMixed(fakeDoc, "株式会社 Kairegi Studio 御中", 40);
  assert.ok(mixed.every((l) => fakeDoc.getTextWidth(l) <= 40), JSON.stringify(mixed));
  assert.ok(mixed.join(" ").includes("Kairegi"), "Latin word was split");
  assert.deepEqual(wrapMixed(fakeDoc, "a\nb", 40), ["a", "b"]);
  const punct = wrapMixed(fakeDoc, "あいうえお。", 20);
  assert.ok(!punct.some((l) => l.startsWith("。")), JSON.stringify(punct));
  assert.deepEqual(wrapMixed(fakeDoc, "", 20), [""]);
});

test("a payment link is created in the invoice's language", async () => {
  const calls = [];
  const token = "a".repeat(64);
  const create = async (...args) => { calls.push(args); return { token, expires_at: null }; };
  const inv = { id: "i1", docType: "invoice", language: "ja" };
  const r = await requestPayLink(inv, 100, { create, origin: "https://app.example.com" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ["i1", null, 14, "ja"]);
  calls.length = 0;
  await requestPayLink({ id: "i2", docType: "invoice" }, 100, { create, origin: "https://app.example.com" });
  assert.equal(calls[0][3], "en");
});

test("migration: language columns, validation, and the public view returns the link's language", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20270111090000_invoice_client_language.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.invoices\s+add column if not exists language text not null default 'en'/i);
  assert.match(sql, /alter table public\.payment_checkout_sessions\s+add column if not exists language text not null default 'en'/i);
  assert.match(sql, /check \(language in \('en', 'ja'\)\)/);
  assert.match(sql, /drop function if exists public\.payments_create_checkout_session\(uuid, numeric, int\)/);
  assert.match(sql, /p_language text default null/);
  assert.match(sql, /coalesce\(nullif\(btrim\(p_language\), ''\), inv\.language, 'en'\)/);
  assert.match(sql, /'language', s\.language/);
  assert.match(sql, /grant execute on function public\.payments_public_checkout\(text\) to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.payments_create_checkout_session\(uuid, numeric, int, text\) to authenticated/);
});

// ---- fixes from the production-readiness audit ------------------------------------------------------------
import * as Sch from "../settings/schema.js";

test("Japanese payment instructions / footer note: loaded, validated, and written only when the columns exist or are used", () => {
  const base = Sch.DEFAULT_SETTINGS;
  assert.equal("invoice_footer_note_ja" in Sch.settingsToRow(base, "u"), false);        // un-migrated database still saves
  const used = Sch.settingsToRow({ ...base, invoicePaymentInstructionsJa: " 銀行振込 ", invoiceFooterNoteJa: "遅延損害金あり" }, "u");
  assert.equal(used.invoice_payment_instructions_ja, "銀行振込");
  assert.equal(used.invoice_footer_note_ja, "遅延損害金あり");
  const loaded = Sch.settingsFromRow({ invoice_payment_instructions_ja: "x", invoice_footer_note_ja: "" });
  assert.equal(loaded.jaDocColumns, true);
  assert.equal(loaded.invoicePaymentInstructionsJa, "x");
  assert.equal(Sch.settingsToRow(loaded, "u").invoice_footer_note_ja, "");              // clearing a saved value really clears it
  assert.ok(Sch.validateSettings({ ...base, invoicePaymentInstructionsJa: "あ".repeat(601) }).invoicePaymentInstructionsJa);
  assert.ok(Sch.validateSettings({ ...base, invoiceFooterNoteJa: "あ".repeat(301) }).invoiceFooterNoteJa);
  assert.equal(Sch.validateSettings({ ...base, invoiceFooterNoteJa: "あ".repeat(300) }).invoiceFooterNoteJa, undefined);
});

test("App.jsx: new English invoices omit language (un-migrated DB still saves); existing rows and Japanese send it; milestones carry it; PDF uses the Japanese texts", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /\.\.\.invoiceLanguageFields\(invoice\),/);
  assert.match(app, /languageColumn: rowHasLanguageColumn\(row\),/);
  assert.match(app, /language: defaultLanguageFor\(projectInvoices\),/);
  assert.match(app, /\(ja && settings\.invoicePaymentInstructionsJa\) \|\| settings\.invoicePaymentInstructions/);
  assert.match(app, /\(ja && settings\.invoiceFooterNoteJa\) \|\| settings\.invoiceFooterNote/);
});

test("rollback script restores the old functions and removes every column the migration added", () => {
  const rb = readFileSync(new URL("../../supabase/rollback/20270111090000_invoice_client_language.rollback.sql", import.meta.url), "utf8");
  const mg = readFileSync(new URL("../../supabase/migrations/20270111090000_invoice_client_language.sql", import.meta.url), "utf8");
  assert.match(rb, /create or replace function public\.payments_create_checkout_session\(p_invoice uuid, p_amount numeric default null, p_expires_days int default 14\)/);
  assert.doesNotMatch(rb.split("alter table public.invoices drop constraint")[0].replace(/--.*\n/g, ""), /p_language/);
  for (const col of ["invoices drop column if exists language", "payment_checkout_sessions drop column if exists language", "invoice_payment_instructions_ja", "invoice_footer_note_ja"]) assert.ok(rb.includes(col), col);
  assert.match(mg, /invoice_payment_instructions_ja/);
  assert.match(mg, /create or replace function public\.create_milestone_invoices/);
  assert.match(mg, /paid_date, language\)/);
});

test("the Japanese font is cached by the host and the SQL language tests are part of run.sh", () => {
  const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /\/fonts\/\*\s+Cache-Control: public, max-age=\d+/);
  const run = readFileSync(new URL("../../supabase/tests/run.sh", import.meta.url), "utf8");
  assert.ok(run.includes("20270111090000_invoice_client_language.sql") && run.includes("payments_language.test.sql"));
  assert.ok(readFileSync(new URL("../../supabase/tests/payments_language.test.sql", import.meta.url), "utf8").includes("_t.chk"));
});
