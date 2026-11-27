import test from "node:test";
import assert from "node:assert/strict";
import { renderFinanceEmail, attachmentName } from "../../../supabase/functions/_shared/finance_v3_email_templates.ts";

const TOKEN = "a".repeat(64);
const base = { invoice_no: "INV-000001", currency: "KES", total: "254.39", outstanding: "154.39", issue_date: "2026-11-23", due_date: "2026-12-07",
  studio: { name: "Kairegi <Studio>", brand_color: "#1F3A5F" }, client: { name: "Acme & Sons" }, view_token: TOKEN, pay_token: "b".repeat(64) };
const LINK = "https://x.test/functions/v1/finance-public";

test("every email type renders a subject, HTML and text; values are escaped", () => {
  for (const type of ["invoice", "invoice_reminder", "overdue_notice", "invoice_update", "refund_notice"]) {
    const r = renderFinanceEmail({ type, payload: { ...base, refund_no: "RFD-000001", refund_amount: "10.00", days_overdue: 4, credit_total: "5.00" }, linkBase: LINK });
    assert.ok(r.subject.length > 5 && r.html.length > 100 && r.text.length > 20, type);
    assert.ok(!r.html.includes("<Studio>"), "studio name must be escaped");
    assert.ok(r.html.includes("Kairegi &lt;Studio&gt;") && r.html.includes("Acme &amp; Sons"));
  }
  const rc = renderFinanceEmail({ type: "payment_receipt", linkBase: LINK, payload: { invoice_no: "INV-000001", receipt: { receipt_no: "RCT-000001", currency: "KES", payment_amount: "100.00", payment_date: "2026-11-23", remaining_balance: "154.39", invoice_fully_paid: false, studio: { name: "S" }, client: { name: "C" }, invoice_no: "INV-000001" } } });
  assert.match(rc.subject, /RCT-000001/); assert.match(rc.text, /KES 154\.39/);
});

test("invoice email links carry only the opaque token and only when it is a valid 64-hex token", () => {
  const r = renderFinanceEmail({ type: "invoice", payload: base, linkBase: LINK });
  assert.ok(r.html.includes(`${LINK}?t=${TOKEN}`) && r.text.includes(`${LINK}?t=${"b".repeat(64)}`));
  const bad = renderFinanceEmail({ type: "invoice", payload: { ...base, view_token: "nope", pay_token: "javascript:alert(1)" }, linkBase: LINK });
  assert.ok(!/href=/.test(bad.html) && !bad.text.includes("javascript"));
});

test("subjects cannot carry header injection or unbounded length", () => {
  const r = renderFinanceEmail({ type: "invoice", payload: { ...base, invoice_no: "INV-1\r\nBcc: evil@x.test", studio: { name: "S\nS" } }, linkBase: LINK });
  assert.ok(!/[\r\n]/.test(r.subject));
  assert.ok(r.subject.length <= 200);
});

test("amounts are copied from the payload, never recomputed", () => {
  const r = renderFinanceEmail({ type: "invoice", payload: { ...base, outstanding: "1234567.50" }, linkBase: LINK });
  assert.match(r.text, /KES 1,234,567\.50/);
});

test("an unknown email type is an error, and attachment names are filesystem-safe", () => {
  assert.throws(() => renderFinanceEmail({ type: "marketing", payload: {}, linkBase: LINK }));
  assert.equal(attachmentName("invoice_pdf", "INV/../000001"), "Invoice-INV_.._000001.pdf");
  assert.equal(attachmentName("receipt_pdf", "RCT-000001"), "Receipt-RCT-000001.pdf");
});

test("rendering is deterministic", () => {
  assert.deepEqual(renderFinanceEmail({ type: "invoice", payload: base, linkBase: LINK }), renderFinanceEmail({ type: "invoice", payload: base, linkBase: LINK }));
});

test("Phase 5: an edited invoice subject and message are used, escaped, bounded, and never change the amounts", () => {
  const plain = renderFinanceEmail({ type: "invoice", payload: base, linkBase: LINK });
  const r = renderFinanceEmail({ type: "invoice", linkBase: LINK, payload: { ...base, custom_subject: "Your <b>March</b> invoice", custom_message: "Hi Acme,\nThanks for the <script>x</script> project.\r\n" } });
  assert.equal(r.subject, "Your <b>March</b> invoice");                       // a subject is plain text in a header, not HTML
  assert.ok(r.html.includes("Thanks for the &lt;script&gt;x&lt;/script&gt; project.") && r.html.includes("Hi Acme,<br>Thanks"));
  assert.ok(!r.html.includes("<script>"));
  assert.match(r.text, /Hi Acme,\nThanks for the <script>x<\/script> project\./);
  for (const k of ["KES 154.39", "INV-000001"]) assert.ok(r.html.includes(k) && r.text.includes(k));
  assert.ok(r.html.includes(`${LINK}?t=${TOKEN}`));                           // links still come from the database tokens
  assert.equal(plain.subject, "Invoice INV-000001 from Kairegi <Studio>");   // no edit, no change
  assert.ok(!plain.html.includes("<br>"));
  const long = renderFinanceEmail({ type: "invoice", linkBase: LINK, payload: { ...base, custom_subject: "s".repeat(400), custom_message: "m".repeat(5000) } });
  assert.equal(long.subject.length, 150);
  assert.ok(long.text.split("\n").some((l) => l.length === 2000));
  const inj = renderFinanceEmail({ type: "invoice", linkBase: LINK, payload: { ...base, custom_subject: "Hello\r\nBcc: evil@x.test" } });
  assert.ok(!/[\r\n]/.test(inj.subject));
  const other = renderFinanceEmail({ type: "invoice_reminder", linkBase: LINK, payload: { ...base, custom_subject: "x", custom_message: "y" } });
  assert.ok(!other.html.includes(">y<") && /^Reminder:/.test(other.subject), "edits apply to invoice emails only");
});
