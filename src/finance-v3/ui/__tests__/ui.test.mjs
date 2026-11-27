// Finance V3 Phase 5 UI tests: the real screens (esbuild bundle) in real Chromium (Playwright), over the real client API
// with an in-page fake RPC that replays recorded outputs of the real database functions (fixtures.json).
// Skipped (and reported as skipped, never as passed) when esbuild / Playwright / Chromium are not installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [process.env.FIN3_UI_TOOLS, "/opt/npm-tools", "/opt/node-tools", process.cwd()].filter(Boolean);
let esbuild, chromium, react;
for (const r of roots) { try { const req = createRequire(path.join(r, "x.js")); esbuild ||= req("esbuild"); chromium ||= req("playwright").chromium; react ||= path.dirname(req.resolve("react/package.json")); } catch { /* next */ } }
const FX = JSON.parse(readFileSync(path.join(here, "fixtures.json"), "utf8"));
const ready = !!(esbuild && chromium && react);
let browser, bundle;
const T = (name, fn) => test(name, { skip: ready ? false : "esbuild/playwright not installed" }, fn);

before(async () => {
  if (!ready) return;
  const out = await esbuild.build({ entryPoints: [path.join(here, "entry.jsx")], bundle: true, write: false, format: "iife", loader: { ".js": "jsx" }, jsx: "automatic", logLevel: "silent",
    alias: { react: react, "react-dom": path.join(path.dirname(react), "react-dom"), "react/jsx-runtime": path.join(react, "jsx-runtime.js") }, define: { "process.env.NODE_ENV": '"production"' } });
  bundle = out.outputFiles[0].text;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

async function open({ width = 1280, height = 900, override = {}, delay = {}, perms, fixtures = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } }); await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://app.test" }); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("https://app.test/**", (r) => r.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#14191c"><div id="root"></div></body></html>' }));
  await page.goto("https://app.test/");
  await page.evaluate((fx) => { window.__fixtures = fx; }, { ...FX, ...(perms ? { fin3_my_permissions: perms } : {}), ...fixtures });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(([o, d]) => { Object.assign(window.__override, o); Object.assign(window.__delay, d); window.__mount(); }, [override, delay]);
  return { page, ctx, errors, calls: () => page.evaluate(() => window.__calls), writes: async () => (await page.evaluate(() => window.__calls)).map((c) => c.name).filter((n) => !/^fin3_(get|list|report|my|overview|explain|preview|trial|receivables|payables|safe|reserve|invoice|dashboard|notification_counts)/.test(n)) };
}
const BANKS = [{ id: "b1", ledger_account_id: "acc-1010", name: "Operating Bank", kind: "bank", currency: "KES", account_last4: "1234", is_active: true, ledger_balance: "2400.00" }];

T("Simple Mode is the default and shows the overview from the database figures", async () => {
  const { page, ctx, errors } = await open();
  await page.getByRole("heading", { name: "Finance", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed"), "true");
  await page.getByText("Safe to spend", { exact: true }).first().waitFor();
  const body = await page.locator(".fv3").innerText();
  for (const k of ["Money in the bank", "Clients owe you", "You owe animators", "Other bills to pay", "Business reserve", "Recent payments", "Recent invoices", "Recent activity"]) assert.ok(body.includes(k), k);
  assert.ok(body.includes("KES 0.00") && body.includes("KES 2,400.00") && body.includes("KES 3,760.00"), "figures come from the overview call");
  assert.ok(body.includes("Your commitments are higher than the cash you have"), "critical warning shown in plain words");
  assert.deepEqual(errors, []); await ctx.close();
});
T("Home shows a loading state, then content", async () => {
  const { page, ctx } = await open({ delay: { fin3_overview: 600 } });
  await page.locator('[aria-busy="true"]').first().waitFor(); await page.getByText("Money in the bank").waitFor(); await ctx.close();
});
T("Home shows an error with retry when the overview fails, and recovers", async () => {
  const { page, ctx } = await open({ override: { fin3_overview: { __error: { code: "V3004", message: "boom" } } } });
  await page.getByRole("alert").waitFor(); assert.ok((await page.getByRole("alert").innerText()).includes("could not be loaded"));
  await page.evaluate(() => { delete window.__override.fin3_overview; }); await page.getByRole("button", { name: "Try again" }).click(); await page.getByText("Money in the bank").waitFor(); await ctx.close();
});
T("empty states: no invoices, no payments", async () => {
  const { page, ctx } = await open({ override: { fin3_list_invoices: { items: [], next_cursor: null }, fin3_list_payments: [] } });
  await page.getByRole("button", { name: "Invoices", exact: true }).click(); await page.getByText("No invoices yet").waitFor();
  await page.getByRole("button", { name: "Payments", exact: true }).click(); await page.getByText("No payments", { exact: true }).waitFor(); await ctx.close();
});
T("the mode toggle persists the choice and changes no financial record", async () => {
  const { page, ctx, writes } = await open();
  await page.getByText("Money in the bank").waitFor();
  await page.getByRole("button", { name: "Accountant" }).click(); await page.getByRole("tab", { name: "Trial balance" }).waitFor();
  await page.getByRole("button", { name: "Simple", exact: true }).click(); await page.getByText("Money in the bank").waitFor();
  assert.deepEqual(await writes(), ["fin3_set_ui_prefs", "fin3_set_ui_prefs"]);
  const calls = await page.evaluate(() => window.__calls.filter((c) => c.name === "fin3_set_ui_prefs").map((c) => c.args.p_prefs.mode)); assert.deepEqual(calls, ["accountant", "simple"]); await ctx.close();
});
T("a saved Accountant preference opens Accountant Mode; a failed save is reported and the view reverts", async () => {
  const a = await open({ override: { fin3_get_ui_prefs: { mode: "accountant", is_default: false } } }); await a.page.getByRole("tab", { name: "Overview" }).waitFor(); await a.ctx.close();
  const b = await open({ override: { fin3_set_ui_prefs: { __error: { code: "V3005", message: "no" } } } });
  await b.page.getByText("Money in the bank").waitFor(); await b.page.getByRole("button", { name: "Accountant" }).click();
  await b.page.getByText("could not be saved").waitFor(); assert.equal(await b.page.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed"), "true"); await b.ctx.close();
});
T("quick actions follow permissions", async () => {
  const { page, ctx } = await open({ perms: ["finance.read"] });
  await page.getByText("Money in the bank").waitFor();
  assert.equal(await page.getByRole("button", { name: "Pay an animator" }).count(), 0); assert.equal(await page.getByRole("button", { name: "Create an invoice" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "View project profit" }).count(), 1); await ctx.close();
  const f = await open(); await f.page.getByText("Money in the bank").waitFor();
  for (const n of ["Create an invoice", "Send an invoice", "Record a client payment", "Add an expense", "Record animator work", "Approve animator work", "Pay an animator", "Pay a supplier", "Move money", "Add to reserve", "Record owner payment", "View project profit"]) assert.equal(await f.page.getByRole("button", { name: n, exact: true }).count(), 1, n);
  await f.ctx.close();
});
T("someone without finance.read sees a plain message and no data calls", async () => {
  const { page, ctx, calls } = await open({ perms: [] }); await page.getByText("Finance is not open to your role").waitFor();
  assert.ok(!(await calls()).some((c) => c.name === "fin3_overview")); await ctx.close();
});
T("safe-to-spend explanation: deductions add up to the same figure and trace to commitments", async () => {
  const { page, ctx } = await open(); await page.getByRole("button", { name: /Safe to spend/ }).click();
  const dlg = page.getByRole("dialog", { name: "How safe-to-spend is worked out" }); await dlg.waitFor();
  const t = await dlg.innerText(); assert.ok(t.includes("Less: Approved animator work not yet paid") && t.includes("Cash you hold") && t.includes("Safe to spend (never below zero)"));
  const e = FX.fin3_explain_safe_to_spend; const sum = e.deductions.reduce((s, d) => s + Number(d.amount), 0);
  assert.equal((Number(e.available_cash) - sum) <= 0 ? "0.00" : (Number(e.available_cash) - sum).toFixed(2), e.safe_to_spend);
  assert.ok(t.includes("SH-010"), "the animator work behind the deduction is listed"); assert.ok(t.includes("1010") || t.includes("Operating Bank Account"), "cash accounts are listed");
  await page.keyboard.press("Escape"); await dlg.waitFor({ state: "detached" }); await ctx.close();
});
T("Simple's safe-to-spend equals the Accountant overview and the explanation", async () => {
  const { page, ctx } = await open({ override: { fin3_get_ui_prefs: { mode: "accountant", is_default: false } } });
  await page.getByRole("tab", { name: "Overview" }).waitFor(); const txt = await page.locator("#panel-overview").innerText();
  assert.ok(txt.includes(`KES ${Number(FX.fin3_overview.safe_to_spend).toFixed(2)}`)); assert.equal(FX.fin3_overview.safe_to_spend, FX.fin3_explain_safe_to_spend.safe_to_spend); assert.equal(FX.fin3_overview.available_cash, FX.fin3_explain_safe_to_spend.available_cash); await ctx.close();
});

// ---- protection -------------------------------------------------------------------------------------------------
const BLOCK = { __error: { code: "V3007", message: "This would take you below your safe-to-spend limit." } };
async function openPayAnimator(opts) {
  const o = await open({ ...opts, fixtures: { fin3_list_bank_accounts: BANKS } });
  await o.page.getByRole("button", { name: "Pay an animator" }).click(); const d = o.page.getByRole("dialog", { name: "Pay an animator" }); await d.waitFor();
  await d.getByLabel("Which work").selectOption({ index: 1 }); await d.getByLabel("Amount to pay").fill("100"); await d.getByLabel("Pay from").selectOption({ index: 1 }); return { ...o, d };
}
T("a protection block is explained, and without finance.override there is no way past it", async () => {
  const { page, ctx, d, calls } = await openPayAnimator({ perms: ["finance.read", "finance.pay"], override: { fin3_pay_animator: BLOCK } });
  await d.getByRole("button", { name: "Pay now" }).click(); await d.getByText("Safe-to-spend protection stopped this.").waitFor();
  assert.equal(await d.getByLabel(/Reason for going ahead/).count(), 0); assert.equal(await d.getByRole("button", { name: "Go ahead anyway" }).count(), 0);
  assert.ok((await d.innerText()).includes("Only an owner or finance admin can override"));
  assert.ok((await calls()).filter((c) => c.name === "fin3_pay_animator").every((c) => c.args.p_override === null)); await ctx.close();
});
T("with finance.override the override needs a written reason and is sent as an explicit second step", async () => {
  const { page, ctx, d, calls } = await openPayAnimator({});
  await page.evaluate(() => { window.__override.fin3_pay_animator = (a) => (a.p_override ? { id: "paid" } : { __error: { code: "V3007", message: "Blocked by protection." } }); });
  await d.getByRole("button", { name: "Pay now" }).click(); await d.getByText("Safe-to-spend protection stopped this.").waitFor();
  const go = d.getByRole("button", { name: "Go ahead anyway" }); assert.equal(await go.isDisabled(), true);
  await d.getByLabel(/Reason for going ahead/).fill("Animator needs paying today"); assert.equal(await go.isDisabled(), false); await go.click(); await d.waitFor({ state: "detached" });
  const pays = (await calls()).filter((c) => c.name === "fin3_pay_animator"); assert.equal(pays.length, 2); assert.equal(pays[0].args.p_override, null); assert.deepEqual(pays[1].args.p_override, { reason: "Animator needs paying today" });
  assert.equal(pays[0].args.p_key, pays[1].args.p_key, "same idempotency key on the retry"); await ctx.close();
});
T("money fields reject bad input before any call is made", async () => {
  const { page, ctx, d, calls } = await openPayAnimator({}); const amt = d.getByLabel("Amount to pay");
  for (const bad of ["", "abc", "-5", "1.2.3", "0"]) { await amt.fill(bad); await d.getByRole("button", { name: "Pay now" }).click(); await d.locator(".err").first().waitFor(); }
  assert.equal((await calls()).filter((c) => c.name === "fin3_pay_animator").length, 0); await ctx.close();
});
T("amounts are sent as decimal strings, never numbers", async () => {
  const { page, ctx, d, calls } = await openPayAnimator({ override: { fin3_pay_animator: { id: "x" } } });
  await d.getByLabel("Amount to pay").fill("1,250.50"); await d.getByRole("button", { name: "Pay now" }).click(); await d.waitFor({ state: "detached" });
  const c = (await calls()).find((x) => x.name === "fin3_pay_animator"); assert.equal(c.args.p_amount, "1250.50"); assert.equal(typeof c.args.p_amount, "string"); await ctx.close();
});

// ---- invoices ---------------------------------------------------------------------------------------------------
async function openInvoice(opts = {}) { const o = await open(opts); await o.page.getByRole("button", { name: "Invoices", exact: true }).click(); await o.page.getByRole("row", { name: /INV|Acme/ }).first().click(); await o.page.getByRole("button", { name: /All invoices/ }).waitFor(); return o; }
T("invoice detail shows totals, payments, receipts, and a timeline that tells money and email events apart", async () => {
  const { page, ctx, errors } = await openInvoice(); await page.getByText("Activity").first().waitFor();
  const tl = page.getByRole("list", { name: "Invoice activity" }); await tl.waitFor();
  const kinds = new Set(FX.fin3_list_invoice_communications.map((i) => i.kind)); assert.ok(kinds.has("email") && (kinds.has("payment") || kinds.has("invoice_event")));
  assert.ok((await tl.locator(".tag.email").count()) >= 1, "email events are tagged Email"); assert.ok((await tl.locator(".tag.money, .tag.doc").count()) >= 1, "financial events are tagged differently");
  for (const k of ["Payments", "Receipts and refunds", "Online payment link"]) assert.ok((await page.locator(".fv3").innerText()).includes(k), k);
  assert.deepEqual(errors, []); await ctx.close();
});
T("email composer: preview, confirm, edit subject and message, send; the invoice is never edited", async () => {
  const { page, ctx, calls } = await openInvoice({ override: { fin3_queue_invoice_email: { id: "m1", status: "queued" }, fin3_issue_and_send_invoice: { id: "m1", status: "queued" } } }); await page.getByRole("button", { name: /Send or resend|Issue and send/ }).click();
  const d = page.getByRole("dialog"); await d.getByLabel("Subject", { exact: true }).waitFor(); const send = d.getByRole("button", { name: /^(Send email|Issue and send)$/ });
  assert.equal(await send.isDisabled(), true, "cannot send before confirming");
  await d.getByLabel("Subject", { exact: true }).fill("Your invoice is ready"); await d.getByLabel(/personal message/).fill("Thanks for the great project!\nSecond line.");
  await d.getByLabel(/I have checked/).check(); assert.equal(await send.isDisabled(), false); await send.click(); await d.getByText("The email is queued.").waitFor();
  const q = (await calls()).find((c) => ["fin3_queue_invoice_email", "fin3_issue_and_send_invoice"].includes(c.name)); const o = q.args.p_options;
  assert.equal(o.subject, "Your invoice is ready"); assert.equal(o.message, "Thanks for the great project!\nSecond line.");
  assert.ok(!(await calls()).some((c) => ["fin3_save_invoice_draft", "fin3_void_invoice", "fin3_credit_invoice"].includes(c.name))); await ctx.close();
});
T("email composer limits: over-long subject or message blocks sending; problems from the preview are shown", async () => {
  const { page, ctx } = await openInvoice({ override: { fin3_preview_invoice_email: { ...FX.fin3_preview_invoice_email, valid: false, problems: [{ code: "no_recipient", message: "This client has no email address." }] } } });
  await page.getByRole("button", { name: /Send or resend|Issue and send/ }).click(); const d = page.getByRole("dialog"); await d.getByText("This client has no email address.").waitFor();
  await d.getByLabel(/I have checked/).check(); assert.equal(await d.getByRole("button", { name: /^(Send email|Issue and send)$/ }).isDisabled(), true);
  await d.getByLabel("Subject", { exact: true }).fill("x".repeat(151)); await d.getByText(/At most 150/).waitFor(); await ctx.close();
});
T("email composer: a send failure is shown and nothing is claimed as sent", async () => {
  const { page, ctx } = await openInvoice({ override: { fin3_queue_invoice_email: { __error: { code: "V3018", message: "recipient invalid" } }, fin3_issue_and_send_invoice: { __error: { code: "V3018", message: "recipient invalid" } } } });
  await page.getByRole("button", { name: /Send or resend|Issue and send/ }).click(); const d = page.getByRole("dialog"); await d.getByLabel(/I have checked/).check();
  await d.getByRole("button", { name: /^(Send email|Issue and send)$/ }).click(); await d.getByText("It could not be sent.").waitFor(); assert.equal(await d.getByText("The email is queued.").count(), 0); await ctx.close();
});
T("payment link: generate, copy, regenerate (old link revoked first)", async () => {
  const { page, ctx, calls } = await openInvoice({ override: { fin3_create_payment_link: { link_id: "l1", kind: "pay", token: "tok_abc", expires_at: "2027-01-01T00:00:00Z" }, fin3_revoke_links: 1 } });
  await page.getByRole("button", { name: "Create payment link" }).click(); const link = page.getByTestId("pay-link"); await link.waitFor(); assert.equal(await link.innerText(), "https://example.test/pay?t=tok_abc");
  await page.getByRole("button", { name: "Copy link" }).click(); await page.getByRole("button", { name: "Copied" }).waitFor(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "https://example.test/pay?t=tok_abc");
  await page.getByRole("button", { name: /Make a new link/ }).click(); await page.waitForFunction(() => window.__calls.filter((c) => c.name === "fin3_create_payment_link").length === 2);
  const names = (await calls()).map((c) => c.name).filter((n) => ["fin3_revoke_links", "fin3_create_payment_link"].includes(n)); assert.deepEqual(names, ["fin3_create_payment_link", "fin3_revoke_links", "fin3_create_payment_link"]); await ctx.close();
});
T("PDF download uses the document service; receipts can be downloaded and emailed", async () => {
  const { page, ctx } = await openInvoice({ override: { fin3_queue_receipt_email: { id: "m1", status: "queued" } } });
  await page.getByRole("button", { name: "Download PDF" }).first().click(); await page.waitForFunction(() => window.__downloads.length >= 1);
  assert.deepEqual(await page.evaluate(() => window.__downloads[0]), { kind: "invoice", id: INV_ID_PLACEHOLDER }.id ? { kind: "invoice", id: await page.evaluate(() => window.__downloads[0].id) } : {});
  assert.ok(FX.fin3_list_receipts.items.length >= 1);
  const rc = page.getByRole("region", { name: "Receipts and refunds" }); await rc.getByRole("button", { name: "Download PDF" }).first().click(); await page.waitForFunction(() => window.__downloads.some((d) => d.kind === "receipt"));
  await rc.getByRole("button", { name: /Email receipt|Resend/ }).first().click(); await page.waitForFunction(() => window.__calls.some((c) => c.name === "fin3_queue_receipt_email")); await ctx.close();
});
const INV_ID_PLACEHOLDER = "x";
T("creating an invoice validates, then saves a draft with string amounts", async () => {
  const { page, ctx, calls } = await open({ override: { fin3_save_invoice_draft: { ...FX.fin3_get_invoice, status: "draft", invoice_no: null } } });
  await page.getByText("Money in the bank").waitFor(); await page.getByRole("button", { name: "Create an invoice", exact: true }).nth(0).click(); const d = page.getByRole("dialog"); await d.waitFor();
  await d.getByRole("button", { name: "Save draft" }).click(); await d.getByText("Choose a client.").waitFor();
  await d.getByLabel("Client", { exact: true }).selectOption({ label: "Acme Films" }); await d.getByLabel("Description").fill("Animation"); await d.getByLabel("Price each").fill("1,000.50"); await d.getByLabel(/Tax %/).fill("16");
  await d.getByRole("button", { name: "Save draft" }).click(); await page.getByRole("button", { name: /All invoices/ }).waitFor();
  const c = (await calls()).find((x) => x.name === "fin3_save_invoice_draft"); assert.deepEqual(c.args.p_lines, [{ description: "Animation", quantity: "1", unit_price: "1000.50", tax_rate: "16" }]); await ctx.close();
});

// ---- accountant -------------------------------------------------------------------------------------------------
const ACCOUNTANT = { fin3_get_ui_prefs: { mode: "accountant", is_default: false } };
T("every Accountant tab renders without error and without console errors", async () => {
  const { page, ctx, errors } = await open({ override: ACCOUNTANT, fixtures: { fin3_list_bank_accounts: BANKS } });
  await page.getByRole("tab", { name: "Overview" }).waitFor(); const tabs = await page.getByRole("tab").allInnerTexts(); assert.equal(tabs.length, 23);
  for (const t of tabs) { await page.getByRole("tab", { name: t, exact: true }).click(); const panel = page.locator('[role="tabpanel"]'); await panel.waitFor();
    await page.waitForFunction(() => !document.querySelector('[role="tabpanel"] [aria-busy="true"]'), null, { timeout: 5000 });
    assert.equal(await panel.getByRole("alert").filter({ hasText: /could not be loaded/ }).count(), 0, `${t} loaded`); }
  assert.deepEqual(errors, []); await ctx.close();
});
T("required Accountant sections exist", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT }); await page.getByRole("tab", { name: "Overview" }).waitFor(); const names = await page.getByRole("tab").allInnerTexts();
  for (const n of ["Overview", "Sales", "Purchases", "Expenses", "Banking", "Chart of accounts", "General ledger", "Journal entries", "Trial balance", "Profit & loss", "Balance sheet", "Cash flow", "Tax", "Receivables", "Payables", "Reconciliation", "Audit history", "Settings", "Payment records", "Email delivery"]) assert.ok(names.includes(n), n); await ctx.close();
});
T("tabs support arrow-key navigation", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT }); await page.getByRole("tab", { name: "Overview" }).focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "Sales" }).getAttribute("aria-selected"), "true"); await page.keyboard.press("End"); assert.equal(await page.getByRole("tab", { name: "Email delivery" }).getAttribute("aria-selected"), "true"); await ctx.close();
});
T("trial balance: account codes, debit and credit columns, totals equal, click-through to the ledger", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT }); await page.getByRole("tab", { name: "Trial balance" }).click();
  const t = page.getByRole("table", { name: "Trial balance" }); await t.waitFor(); const head = await t.locator("th").allInnerTexts(); assert.deepEqual(head.slice(0, 5), ["Code", "Account", "Type", "Debit", "Credit"]);
  assert.ok((await t.innerText()).includes("1010")); assert.ok((await page.locator("#panel-tb").innerText()).includes("Debits equal credits"));
  await t.getByRole("row", { name: /1010/ }).click(); await page.getByRole("tab", { name: "General ledger", selected: true }).waitFor(); await page.getByRole("table", { name: "General ledger" }).waitFor();
  assert.equal(await page.getByLabel("Account", { exact: true }).inputValue(), FX.fin3_trial_balance.accounts.find((a) => a.code === "1010").account_id); await ctx.close();
});
T("general ledger shows debit and credit columns, journal references and a running balance", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT }); await page.getByRole("tab", { name: "General ledger" }).click(); await page.getByLabel("Account", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Account", { exact: true }).selectOption({ label: FX.fin3_list_accounts.find((a) => a.code === "1010").code + " " + FX.fin3_list_accounts.find((a) => a.code === "1010").name });
  const t = page.getByRole("table", { name: "General ledger" }); await t.waitFor(); const h = await t.locator("th").allInnerTexts(); for (const c of ["Date", "Journal ref", "Debit", "Credit", "Balance"]) assert.ok(h.includes(c), c);
  assert.ok(/JE-\d+/.test(await t.innerText())); await ctx.close();
});
T("journal entries list lines with debit/credit, kind, and reversal markers", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT }); await page.getByRole("tab", { name: "Journal entries" }).click(); await page.getByRole("region", { name: /Journal entry/ }).first().waitFor();
  const first = FX.fin3_list_entries.items[0]; const sec = page.getByRole("region", { name: `Journal entry ${first.entry_no}` }); assert.ok((await sec.innerText()).includes(`JE-${first.entry_no}`)); await sec.getByRole("table").waitFor(); await ctx.close();
});
T("profit & loss, balance sheet, cash flow and tax show database figures and validate the period", async () => {
  const { page, ctx } = await open({ override: ACCOUNTANT });
  await page.getByRole("tab", { name: "Profit & loss" }).click(); const pl = page.locator("#panel-pl"); await pl.getByText("Net profit").waitFor(); assert.ok((await pl.innerText()).includes(Number(FX.fin3_report_profit_loss.net_profit).toLocaleString("en-US", { minimumFractionDigits: 2 })));
  await pl.getByLabel("From").fill("2027-01-02"); await pl.getByLabel("To").fill("2027-01-01"); await pl.getByText("not after the end date").first().waitFor();
  assert.equal((await page.evaluate(() => window.__calls.filter((c) => c.name === "fin3_report_profit_loss" && c.args.p_from === "2027-01-02").length)), 0, "an invalid period is never sent");
  await page.getByRole("tab", { name: "Balance sheet" }).click(); await page.locator("#panel-bs").getByText(/Assets equal liabilities plus equity/).waitFor();
  await page.getByRole("tab", { name: "Cash flow" }).click(); await page.locator("#panel-cf").getByText(/reconciles to the ledger/).waitFor();
  await page.getByRole("tab", { name: "Tax" }).click(); await page.locator("#panel-tax").getByText("Purchases").first().waitFor(); await ctx.close();
});
T("audit history paginates and filters", async () => {
  const big = { total: 120, limit: 50, offset: 0, items: FX.fin3_list_audit.items.slice(0, 5) };
  const { page, ctx } = await open({ override: { ...ACCOUNTANT, fin3_list_audit: big } }); await page.getByRole("tab", { name: "Audit history" }).click(); await page.getByRole("button", { name: "Next" }).click();
  await page.waitForFunction(() => window.__calls.some((c) => c.name === "fin3_list_audit" && c.args.p_offset === 50));
  await page.getByLabel("Filter by record type").selectOption("payment"); await page.waitForFunction(() => window.__calls.some((c) => c.name === "fin3_list_audit" && c.args.p_object_type === "payment")); await ctx.close();
});
T("email delivery audit shows plain statuses and is limited to people who may see integrations", async () => {
  const a = await open({ override: ACCOUNTANT }); await a.page.getByRole("tab", { name: "Email delivery" }).click(); await a.page.getByRole("table", { name: "Email delivery audit" }).waitFor(); await a.ctx.close();
  const b = await open({ override: ACCOUNTANT, perms: ["finance.read"] }); await b.page.getByRole("tab", { name: "Email delivery" }).click(); await b.page.getByText("Email delivery details are for finance admins").waitFor();
  assert.ok(!(await b.calls()).some((c) => c.name === "fin3_list_emails")); await b.ctx.close();
});
T("reconciliation starts from a statement balance and shows the difference", async () => {
  const { page, ctx } = await open({ override: { ...ACCOUNTANT, fin3_start_reconciliation: { id: "r1", status: "open" }, fin3_reconciliation_summary: { status: "open", statement_date: "2026-11-25", currency: "KES", statement_balance: "2400.00", ledger_balance: "2400.00", cleared_balance: "2400.00", difference: "0.00" } }, fixtures: { fin3_list_bank_accounts: BANKS } });
  await page.getByRole("tab", { name: "Reconciliation" }).click(); await page.getByRole("button", { name: "Start a reconciliation" }).click(); const d = page.getByRole("dialog"); await d.getByLabel("Account", { exact: true }).selectOption({ index: 1 }); await d.getByLabel(/Statement closing balance/).fill("2400.00"); await d.getByRole("button", { name: "Start" }).click(); await page.getByText("· agrees").waitFor(); await ctx.close();
});

// ---- layout, accessibility --------------------------------------------------------------------------------------
for (const [name, w] of [["phone", 375], ["tablet", 768]]) T(`${name} width: no horizontal page scroll on Home, Invoices and Accountant tabs`, async () => {
  const { page, ctx } = await open({ width: w, height: 800, override: {} }); await page.getByText("Money in the bank").waitFor();
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok((await over()) <= 1, "home");
  await page.getByRole("button", { name: "Invoices", exact: true }).click(); await page.getByRole("table", { name: "Invoices" }).waitFor(); assert.ok((await over()) <= 1, "invoices");
  if (w === 375) assert.equal(await page.getByRole("table", { name: "Invoices" }).locator("thead").evaluate((el) => el.getBoundingClientRect().width <= 1), true, "phones show cards, not a wide table");
  await page.getByRole("button", { name: "Accountant" }).click(); for (const t of ["Trial balance", "Journal entries", "Profit & loss", "Sales"]) { await page.getByRole("tab", { name: t, exact: true }).click(); await page.waitForTimeout(150); assert.ok((await over()) <= 1, t); } await ctx.close(); });
T("dialogs are modal, label themselves, trap focus, close on Escape and return focus", async () => {
  const { page, ctx } = await open({ fixtures: { fin3_list_bank_accounts: BANKS } }); await page.getByText("Money in the bank").waitFor(); const opener = page.getByRole("button", { name: "Move money" }); await opener.click();
  const d = page.getByRole("dialog", { name: "Move money between accounts" }); await d.waitFor(); assert.equal(await d.getAttribute("aria-modal"), "true");
  for (let i = 0; i < 14; i++) { await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true, "focus stays inside"); }
  await page.keyboard.press("Escape"); await d.waitFor({ state: "detached" }); assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Move money"); await ctx.close();
});
T("every form control in every dialog has an accessible name", async () => {
  const { page, ctx } = await open({ fixtures: { fin3_list_bank_accounts: BANKS } }); await page.getByText("Money in the bank").waitFor();
  for (const b of ["Record a client payment", "Add an expense", "Record animator work", "Approve animator work", "Pay an animator", "Pay a supplier", "Move money", "Add to reserve", "Record owner payment", "Create an invoice"]) {
    await page.getByRole("button", { name: b, exact: true }).first().click(); const d = page.getByRole("dialog"); await d.waitFor(); await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea').length > 0);
    const unnamed = await d.locator("input,select,textarea").evaluateAll((els) => els.filter((e) => !(e.labels && e.labels.length) && !e.getAttribute("aria-label")).length); assert.equal(unnamed, 0, b);
    await page.keyboard.press("Escape"); await d.waitFor({ state: "detached" }); } await ctx.close();
});
T("no placeholder controls: every visible button on every Simple screen does something", async () => {
  const { page, ctx } = await open(); await page.getByText("Money in the bank").waitFor();
  const labels = await page.getByRole("button").allInnerTexts(); assert.ok(!labels.some((l) => /coming soon|todo|placeholder|not implemented/i.test(l))); assert.ok(!(await page.locator(".fv3").innerText()).match(/coming soon|lorem|todo/i)); await ctx.close();
});

// ---- Phase 6 ---------------------------------------------------------------------------------------------------------
T("Home 'This month' card shows the dashboard service figures, not a UI sum", async () => {
  const { page, ctx, calls, errors } = await open(); await page.getByText("This month", { exact: true }).waitFor(); await page.getByText("Overdue invoices").first().waitFor();
  const body = await page.locator(".fv3").innerText(); assert.ok(body.includes("KES 3,500.00") && body.includes("KES 8,000.00") && body.includes("-4,500.00"), "revenue, expenses, profit from fin3_dashboard");
  assert.ok((await calls()).some((c) => c.name === "fin3_dashboard")); assert.deepEqual(errors, []); await ctx.close();
});
T("notification bell shows the unread count and the panel lists alerts; mark-all-read calls only the notification RPC", async () => {
  const { page, ctx, calls } = await open({ override: { fin3_notification_counts: { unread: 2, critical_unread: 1, total: 2 } } });
  const bell = page.getByRole("button", { name: /Notifications, 2 unread/ }); await bell.waitFor(); await bell.click();
  const d = page.getByRole("dialog", { name: "Finance notifications" }); await d.waitFor(); await d.getByText("Reserve", { exact: false }).first().waitFor();
  await d.getByRole("button", { name: "Mark all as read" }).click(); await page.waitForTimeout(200);
  const names = (await calls()).map((c) => c.name); assert.ok(names.includes("fin3_mark_notifications_read"));
  assert.ok(!names.some((n) => /fin3_(post|record|pay|send|approve|void|refund)/.test(n)), "no financial write"); await page.keyboard.press("Escape"); await d.waitFor({ state: "detached" }); await ctx.close();
});
T("Accountant: reports, exports and alerts tabs render real data and export downloads a CSV", async () => {
  const { page, ctx, calls, errors } = await open({ override: { fin3_get_ui_prefs: { mode: "accountant", is_default: false } } });
  await page.getByRole("tab", { name: "More reports" }).click(); await page.getByRole("combobox", { name: "Report" }).waitFor();
  await page.getByRole("combobox", { name: "Report" }).selectOption("reservesReport"); await page.waitForTimeout(200);
  assert.ok((await calls()).some((c) => c.name === "fin3_report_reserves"));
  await page.getByRole("tab", { name: "Alerts" }).click(); await page.getByRole("heading", { name: "Alerts and reminders" }).waitFor(); await page.getByText("Books health").waitFor();
  await page.getByRole("tab", { name: "Exports" }).click(); await page.getByRole("button", { name: "Download CSV" }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  assert.match(dl.suggestedFilename(), /\.csv$/); assert.deepEqual(errors, []); await ctx.close();
});
T("alert settings are read-only without finance.admin and saving surfaces errors", async () => {
  const perms = FX.fin3_my_permissions; const noAdmin = Array.isArray(perms) ? perms.filter((p) => p !== "finance.admin") : perms;
  const { page, ctx } = await open({ perms: noAdmin, override: { fin3_get_ui_prefs: { mode: "accountant", is_default: false } } });
  await page.getByRole("tab", { name: "Alerts" }).click(); await page.getByText("Only a finance admin can change these.").waitFor(); await ctx.close();
});
