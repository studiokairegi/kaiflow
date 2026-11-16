// Run: node --test src/contracts.ja.test.mjs
// Japanese contracts: template rendering, formatting, language plumbing, string-table parity.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildContractTerms, renderContractBody, compareTerms, formatContractMoney, formatContractDate, milestoneLabel,
  DEFAULT_CONTRACT_BODY, DEFAULT_CONTRACT_BODY_JA, defaultContractBodyFor, consentTextFor, CONTRACT_CONSENT_TEXT,
  CONTRACT_CONSENT_TEXT_JA, contractSignLinkFor, contractEmail, todayISO, findUnfilled, validateMilestonePercents, isSafeSignatureSrc, formatProductionStage,
} from "./contracts.js";
import { CONTRACT_STRINGS, contractT, localizeSignError } from "./i18n/contractStrings.js";

const project = { id: "p1", name: "ブランドフィルム", client: "Acme", notes: "30s spot", budget: "150000", budgetMode: "manual", currency: "KSh", deadline: "2026-03-15", pipelineStages: [{ name: "絵コンテ", sortOrder: 1, isEnabled: true }, { name: "アニメーション", sortOrder: 2, isEnabled: true }] };
const cards = [{ projectId: "p1", title: "Shot 1", due: "2026-02-01", rate: "50000" }, { projectId: "p1", title: "Shot 2", due: "", rate: "100000" }];
const contact = { name: "山田 花子", company: "株式会社サンプル" };
const win = (globalThis.window = globalThis.window || { location: { origin: "https://app.example", pathname: "/" } });
void win;

const placeholders = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");

test("Japanese template uses exactly the same {{placeholders}} as the English one", () => {
  const keys = (s) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(keys(DEFAULT_CONTRACT_BODY_JA).filter((k) => k !== "studio_signatory"), keys(DEFAULT_CONTRACT_BODY).filter((k) => k !== "studio_signatory"));
  // The English template has no {{client_name}}/{{client_address}} either, so nothing may be missing.
  assert.deepEqual(keys(DEFAULT_CONTRACT_BODY_JA), keys(DEFAULT_CONTRACT_BODY));
});

test("Japanese template has the same eleven clauses as the English one", () => {
  const en = DEFAULT_CONTRACT_BODY.match(/^\d+\.\s/gm).length;
  const ja = (DEFAULT_CONTRACT_BODY_JA.match(/^第\d+条/gm) || []).length;
  assert.equal(ja, 11);
  assert.ok(en >= ja);                      // English also numbers sub-lists, so only the Japanese clause count is pinned
  assert.deepEqual((DEFAULT_CONTRACT_BODY_JA.match(/^第\d+条/gm) || []).map((c) => Number(c.slice(1, -1))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("Japanese body: every placeholder is filled, in Japanese wording and formats", () => {
  const t = buildContractTerms({ project, cards, contact, studio: { paymentTermsDays: 14 }, language: "ja" });
  assert.equal(t.language, "ja");
  const body = renderContractBody(DEFAULT_CONTRACT_BODY_JA, t, { studioName: "スタジオ・カイレギ", governingLaw: "日本法", revisionRounds: 2, effectiveDate: "2026年11月16日" });
  assert.equal(/\{\{/.test(body), false);
  assert.match(body, /KSh 150,000\.00/);
  assert.match(body, /2026年3月15日までに本業務を納品する/);
  assert.match(body, /請求書の発行日から14日以内に支払うものとする/);
  assert.match(body, /着手金：50%（KSh 75,000\.00）/);
  assert.match(body, /納品時のお支払い：50%/);
  assert.match(body, /1\. Shot 1（納期：2026年2月1日）/);
  assert.match(body, /納品物（2点）/);
  assert.match(body, /制作工程：絵コンテ、アニメーション/);
  assert.match(body, /株式会社サンプル（以下「甲」という。）/);
  assert.match(body, /本契約は日本法に準拠し/);
  assert.match(body, /乙の署名者：スタジオ・カイレギ/);
});

test("Japanese body: missing deadline / scope / payment terms get safe Japanese wording, no doubled particles", () => {
  const t = buildContractTerms({ project: { ...project, deadline: "", notes: "" }, cards: [], contact, language: "ja" });
  const body = renderContractBody(DEFAULT_CONTRACT_BODY_JA, t, { studioName: "S" });
  assert.match(body, /書面により別途合意する日までに/);
  assert.match(body, /下記の納品物のとおりとする/);
  assert.match(body, /請求書の受領後直ちに支払うものとする/);
  assert.match(body, /\[準拠法\]に準拠し/);
  assert.equal(/ににし|ちにに/.test(body), false);
  assert.match(body, /納品物（別途協議）/);
});

test("the language is read from the terms, so a stored Japanese contract re-renders in Japanese", () => {
  const t = buildContractTerms({ project, cards, contact, language: "ja" });
  assert.match(renderContractBody("{{deadline}} {{fee}}", t, {}), /2026年3月15日 KSh 150,000\.00/);
  const en = buildContractTerms({ project, cards, contact });
  assert.equal(en.language, "en");
  assert.match(renderContractBody("{{deadline}}", en, {}), /15 March 2026/);
});

test("English output is unchanged by the language work", () => {
  const t = buildContractTerms({ project, cards, contact, studio: { paymentTermsDays: 14 } });
  const a = renderContractBody(DEFAULT_CONTRACT_BODY, t, { studioName: "S", effectiveDate: "x" });
  const b = renderContractBody(DEFAULT_CONTRACT_BODY, t, { studioName: "S", effectiveDate: "x", language: "en" });
  assert.equal(a, b);
  assert.match(a, /Upfront payment: 50% \(KSh 75,000\.00\)/);
  assert.equal(formatContractMoney("$", 1234.5), "$1,234.50");
  assert.equal(formatContractDate("2026-03-15T00:00:00Z"), "15 March 2026");
  assert.deepEqual(buildContractTerms({ project, cards, contact }).milestones.map((m) => m.label), ["Upfront payment", "Delivery payment"]);
});

test("formatting: yen has no decimals in Japanese, other currencies keep two; dates are 年月日", () => {
  assert.equal(formatContractMoney("¥", 1500000, "ja"), "¥1,500,000");
  assert.equal(formatContractMoney("JPY", 1500000, "ja"), "JPY 1,500,000");
  assert.equal(formatContractMoney("$", 1234.5, "ja"), "$1,234.50");
  assert.equal(formatContractDate("2026-03-05", "ja"), "2026年3月5日");
  assert.equal(formatContractDate("", "ja"), "");
  assert.equal(formatContractDate("garbage", "ja"), "");
});

test("HUEMAN production pipeline labels are translated only in Japanese contract output", () => {
  const stages = ["Brief", "Storyboard / Stillomatic", "Character Concept", "Layout", "Enshutsu", "Sakkan", "COC", "Genga", "Douga", "Shiage", "Delivered"];
  const expected = ["企画・制作指示", "絵コンテ／スティルオマティック", "キャラクター設定", "レイアウト", "演出", "作画監督", "COC", "原画", "動画", "仕上げ", "納品"];
  assert.deepEqual(stages.map((stage) => formatProductionStage(stage, "ja")), expected);
  assert.deepEqual(stages.map((stage) => formatProductionStage(stage, "en")), stages);
  const terms = buildContractTerms({ project: { ...project, pipelineStages: stages.map((name, sortOrder) => ({ name, sortOrder, isEnabled: true })) }, cards, contact, language: "ja" });
  assert.deepEqual(terms.stages, stages, "frozen project data must retain the original stage labels");
  const body = renderContractBody(DEFAULT_CONTRACT_BODY_JA, terms, { studioName: "Studio Kairegi", governingLaw: "日本法" });
  for (const label of expected) assert.ok(body.includes(label), `missing Japanese stage label: ${label}`);
  assert.equal(body.includes("Storyboard / Stillomatic"), false);
  assert.equal(body.includes("Character Concept"), false);
  assert.equal(body.includes("Brief"), false);
  assert.ok(body.includes("COC"), "COC is retained because its meaning is not defined in this repository");
});

test("built-in animation production pipeline labels are localized without altering English labels", () => {
  const labels = ["Character Design", "BG & Lighting Design", "Storyboard / Animatic", "Layout", "Genga", "Douga", "Backgrounds", "Frame Test", "Cleanup & Color", "Compositing", "Editing", "Delivered"];
  const japanese = ["キャラクター設定", "背景・ライティング設定", "絵コンテ／アニマティック", "レイアウト", "原画", "動画", "背景", "フレームテスト", "クリンナップ・彩色", "撮影・コンポジット", "編集", "納品"];
  assert.deepEqual(labels.map((label) => formatProductionStage(label, "ja")), japanese);
  assert.deepEqual(labels.map((label) => formatProductionStage(label, "en")), labels);
});

test("milestone labels in Japanese", () => {
  assert.deepEqual([0, 1].map((i) => milestoneLabel(i, 2, "ja")), ["着手金", "納品時のお支払い"]);
  assert.deepEqual([0, 1, 2].map((i) => milestoneLabel(i, 3, "ja")), ["着手金", "中間金", "納品時のお支払い"]);
  assert.deepEqual([0, 1, 2, 3].map((i) => milestoneLabel(i, 4, "ja")), ["着手金", "第2回お支払い", "第3回お支払い", "納品時のお支払い"]);
});

test("a hand-written Japanese scope replaces the project notes and is not reported as drift", () => {
  const frozen = buildContractTerms({ project, cards, contact, language: "ja", scopeOverride: "30秒のプロモーション映像を制作する。" });
  assert.equal(frozen.scope, "30秒のプロモーション映像を制作する。");
  assert.equal(frozen.scope_custom, true);
  const now = buildContractTerms({ project, cards, contact, language: "ja", scopeOverride: frozen.scope });
  assert.deepEqual(compareTerms(frozen, now), []);
  assert.equal(buildContractTerms({ project, cards, contact, language: "ja" }).scope_custom, undefined);
  assert.equal(buildContractTerms({ project, cards, contact, language: "ja", scopeOverride: "   " }).scope, "30s spot");
});

test("consent text and default template follow the language; unknown languages fall back to English", () => {
  assert.equal(consentTextFor("ja"), CONTRACT_CONSENT_TEXT_JA);
  assert.equal(consentTextFor("en"), CONTRACT_CONSENT_TEXT);
  for (const bad of [undefined, null, "", "fr", "japanese"]) assert.equal(consentTextFor(bad), CONTRACT_CONSENT_TEXT);
  assert.equal(defaultContractBodyFor("ja-JP"), DEFAULT_CONTRACT_BODY_JA);
  assert.equal(defaultContractBodyFor("xx"), DEFAULT_CONTRACT_BODY);
});

test("signing link: Japanese links carry a language hint, English links are exactly as before", () => {
  assert.equal(contractSignLinkFor("abc", "en"), "https://app.example/?share=contract&token=abc");
  assert.equal(contractSignLinkFor("abc", "ja"), "https://app.example/?share=contract&token=abc&lang=ja");
  assert.equal(contractSignLinkFor("abc"), "https://app.example/?share=contract&token=abc");
});

test("Japanese language survives creation, public retrieval, signing and PDF generation", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20270112100000_contract_language.sql", import.meta.url), "utf8");
  const api = readFileSync(new URL("./contractsApi.js", import.meta.url), "utf8");
  const pdf = readFileSync(new URL("./ndaPdf.js", import.meta.url), "utf8");
  assert.match(migration, /language text not null default 'en'/);
  assert.match(migration, /'language', r\.language/);
  assert.match(migration, /if v_lang not in \('en', 'ja'\)/);
  assert.match(migration, /signer_email, expires_at, language\)/);
  assert.match(migration, /v_lang\)\s*returning id into v_id/s);
  assert.match(api, /p_language: "ja"/);
  assert.match(api, /contract_public_get/);
  assert.match(api, /p_consent: consentText/);
  assert.match(pdf, /isJapanese\(r\.language\)/);
  assert.match(pdf, /await useJapaneseFont\(doc, opts\.fetchImpl\)/);
  const font = readFileSync(new URL("../public/fonts/kairflow-jp.ttf", import.meta.url));
  assert.ok(font.length > 1_000_000, "embedded Japanese font asset must be present");
  assert.deepEqual([...font.subarray(0, 4)], [0, 1, 0, 0], "Japanese font must be a valid TrueType file");
});

test("invitation email is written in the contract's language", () => {
  const ja = contractEmail({ lang: "ja", studioName: "スタジオ・カイレギ", contactName: "山田 花子", project: "ブランドフィルム", link: "https://x/y", days: 30 });
  assert.equal(ja.subject, "スタジオ・カイレギ：ブランドフィルムの契約書へのご署名のお願い");
  assert.match(ja.body, /^山田 花子 様/);
  assert.match(ja.body, /https:\/\/x\/y/);
  assert.match(ja.body, /30日間/);
  assert.match(contractEmail({ lang: "ja", studioName: "S", contactName: "", project: "P", link: "l", days: 7 }).body, /^ご担当者様/);
  const en = contractEmail({ lang: "en", studioName: "S", contactName: "Jane Doe", project: "P", link: "l", days: 7 });
  assert.equal(en.subject, "S: please sign the agreement for P");
  assert.match(en.body, /^Hi Jane,/);
});

test("signing-page strings: English and Japanese have exactly the same keys and placeholders", () => {
  assert.deepEqual(Object.keys(CONTRACT_STRINGS.ja).sort(), Object.keys(CONTRACT_STRINGS.en).sort());
  for (const k of Object.keys(CONTRACT_STRINGS.en)) assert.equal(placeholders(CONTRACT_STRINGS.ja[k]), placeholders(CONTRACT_STRINGS.en[k]), `placeholders differ: ${k}`);
});

test("Japanese signing and certificate dictionary fully covers every English UI key without English fallbacks", () => {
  for (const [key, english] of Object.entries(CONTRACT_STRINGS.en)) {
    assert.ok(Object.hasOwn(CONTRACT_STRINGS.ja, key), `missing Japanese translation: ${key}`);
    assert.notEqual(CONTRACT_STRINGS.ja[key], english, `English fallback remains for: ${key}`);
    assert.ok(CONTRACT_STRINGS.ja[key].trim(), `empty Japanese translation: ${key}`);
  }
  for (const key of ["asked", "summary.project", "summary.fee", "summary.deadline", "summary.schedule", "sign.nameLabel", "sign.draw", "sign.type", "sign.drawHint", "sign.clear", "sign.recorded", "sign.button", "sign.decline", "decline.confirm", "pdf.cert.title", "pdf.cert.document", "pdf.cert.requestedBy", "pdf.cert.signer", "pdf.cert.status", "pdf.cert.sent", "pdf.cert.signed", "pdf.cert.method", "pdf.cert.consent", "pdf.cert.ip", "pdf.cert.requestId"]) {
    assert.ok(CONTRACT_STRINGS.ja[key], `missing required Japanese label: ${key}`);
  }
  assert.equal(consentTextFor("ja"), CONTRACT_CONSENT_TEXT_JA);
  assert.equal(CONTRACT_STRINGS.en["sign.drawHint"], "", "new Japanese-only guidance must not alter the English signer UI");
  assert.equal(CONTRACT_STRINGS.en["decline.confirm"], "", "new Japanese-only decline copy must not alter the English signer UI");
});

test("signing-page strings: English values are the exact wording the page always used", () => {
  const t = contractT("en");
  assert.equal(t("sign.button", { doc: "NDA" }), "Sign NDA");
  assert.equal(t("closed.declined", { doc: "contract" }), "You declined this contract. The studio has been notified.");
  assert.equal(t("asked", { studio: "Kairegi" }), "Kairegi has asked you to sign");
  assert.equal(t("signed.on", { date: "D", studio: "Kairegi" }), " on D. Kairegi can now see your signed copy.");
  assert.equal(contractT(undefined).lang, "en");
  assert.equal(contractT("ja").lang, "ja");
});

test("database error messages reach Japanese signers as Japanese; English signers see the original", () => {
  assert.match(localizeSignError("This signing link has expired", "ja", "sign.error"), /有効期限/);
  assert.match(localizeSignError("This signing link is not valid", "ja", "sign.error"), /無効/);
  assert.match(localizeSignError("This contract can no longer be signed (signed).", "ja", "sign.error"), /すでに/);
  assert.equal(localizeSignError("Invalid signature image", "ja", "sign.error"), CONTRACT_STRINGS.ja["sign.error"]);
  assert.equal(localizeSignError("", "ja", "decline.error"), CONTRACT_STRINGS.ja["decline.error"]);
  assert.equal(localizeSignError("This signing link has expired", "en", "sign.error"), "This signing link has expired");
  assert.equal(localizeSignError("", "en", "sign.error"), "Signing failed. Please try again.");
});

test("every Japanese string is actually Japanese (no English copied across by mistake)", () => {
  const keepLatin = new Set(["pdf.fileName"]);
  for (const [k, v] of Object.entries(CONTRACT_STRINGS.ja)) {
    if (keepLatin.has(k)) continue;
    assert.match(v, /[\u3040-\u30ff\u3400-\u9fff]/, `${k} has no Japanese characters`);
  }
});

test("effective date is the Japan calendar day, not the UTC day (00:00-09:00 JST regression)", () => {
  const now = new Date("2026-03-14T23:00:00Z");            // 08:00 on 15 March in Tokyo
  assert.equal(todayISO("ja", now), "2026-03-15");
  assert.equal(formatContractDate(todayISO("ja", now), "ja"), "2026年3月15日");
  const late = new Date("2026-03-15T16:00:00Z");           // 01:00 on 16 March in Tokyo
  assert.equal(todayISO("ja", late), "2026-03-16");
});

test("yen schedule in a Japanese contract is whole yen and adds up to the fee", () => {
  const p = { id: "p", name: "P", budget: "100001", budgetMode: "manual", currency: "¥" };
  const t = buildContractTerms({ project: p, cards: [], milestonePercents: [33.33, 33.33, 33.34], language: "ja" });
  assert.ok(t.milestones.every((m) => Number.isInteger(m.amount)));
  assert.equal(t.milestones.reduce((a, m) => a + m.amount, 0), t.budget_total);
  assert.equal(t.budget_total, 100001);
  // English contracts keep their two-decimal behaviour.
  const en = buildContractTerms({ project: p, cards: [], milestonePercents: [33.33, 33.33, 33.34] });
  assert.equal(en.milestones[0].amount, 33330.33);
});

test("template tokens only read real placeholders, never inherited object properties", () => {
  assert.equal(renderContractBody("{{constructor}}|{{toString}}", {}, {}), "{{constructor}}|{{toString}}");
});

test("unfilled placeholders are judged from the template, never from text typed into the scope", () => {
  const t = buildContractTerms({ project, cards, contact, language: "ja" });
  assert.deepEqual(findUnfilled(DEFAULT_CONTRACT_BODY_JA, t, { studioName: "S" }), ["[準拠法]"]);
  assert.deepEqual(findUnfilled(DEFAULT_CONTRACT_BODY_JA, t, { studioName: "S", governingLaw: "日本法" }), []);
  assert.deepEqual(findUnfilled(DEFAULT_CONTRACT_BODY, buildContractTerms({ project, cards, contact }), { studioName: "S" }), ["[governing law]"]);
  assert.deepEqual(findUnfilled("{{mystery}} {{constructor}}", t, {}), ["{{mystery}}", "{{constructor}}"]);
  // Regression: a scope the client wrote containing the marker strings must not block sending.
  const tricky = buildContractTerms({ project: { ...project, notes: "範囲 [governing law] [準拠法] {{fee}}" }, cards, contact, language: "ja", studio: {} });
  assert.deepEqual(findUnfilled(DEFAULT_CONTRACT_BODY_JA, tricky, { governingLaw: "日本法" }), []);
});

test("dates: only YYYY-MM-DD input is accepted; anything else is empty rather than a wrong date", () => {
  assert.equal(formatContractDate("２０２６-03-15", "ja"), "");
  assert.equal(formatContractDate("2026-02-31", "ja"), "");
  assert.equal(formatContractDate("March 5 2026", "ja"), "");
  assert.equal(formatContractDate("2026-03-15T09:00:00Z", "ja"), "2026年3月15日");
  assert.equal(formatContractDate(new Date(2026, 2, 5), "ja"), "2026年3月5日");
});

test("compareTerms formats a Japanese contract's drift in Japanese", () => {
  const a = buildContractTerms({ project, cards, contact, language: "ja" });
  const b = buildContractTerms({ project: { ...project, deadline: "2026-04-01" }, cards, contact, language: "ja" });
  assert.match(compareTerms(a, b, "ja")[0], /2026年3月15日 → 2026年4月1日/);
});

test("payments must be more than 0%", () => {
  assert.equal(validateMilestonePercents([0, 100]).ok, false);
  assert.equal(validateMilestonePercents([50, 50]).ok, true);
  assert.equal(validateMilestonePercents([100, 0]).ok, false);
});

test("only a PNG data URL is accepted as a signature image source", () => {
  assert.equal(isSafeSignatureSrc("data:image/png;base64,iVBORw0KGgo="), true);
  for (const bad of ["https://evil.example/p.png", "javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,<script>", "", null, undefined, 5]) assert.equal(isSafeSignatureSrc(bad), false);
});

test("the Japanese template has exactly the same number of numbered clauses as the English one", () => {
  const en = new Set([...DEFAULT_CONTRACT_BODY.matchAll(/^(\d+)\.\s+[A-Z]/gm)].map((m) => m[1]));
  const ja = new Set([...DEFAULT_CONTRACT_BODY_JA.matchAll(/^第(\d+)条/gm)].map((m) => m[1]));
  assert.deepEqual([...ja], [...en]);
});
