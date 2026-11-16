// src/contracts.js
// Pure rules for client contracts (CRM > Contacts > client > Contracts). No network, no
// React, so it can be unit tested with `node --test src/contracts.test.mjs`.
//
// A contract is generated from a project: the scope (notes + shots), budget, deadline,
// production stages and payment milestones are read from the project at send time and
// FROZEN on the contract as `terms` (and rendered into `body`). If the project changes
// afterwards, compareTerms() reports what moved so the studio can send an updated one.

import { normalizeLang, isJapanese } from "./i18n/languages.js";

export const CONTRACT_STATUS = {
  sent: { label: "Awaiting signature", color: "#F2A65A" },
  viewed: { label: "Opened, not signed", color: "#F2C14E" },
  signed: { label: "Signed", color: "#3DDC84" },
  declined: { label: "Declined", color: "#E5646B" },
  expired: { label: "Expired", color: "#8b9a98" },
  voided: { label: "Voided", color: "#8b9a98" },
};

export const CONTRACT_CONSENT_TEXT =
  "I have read this agreement and agree to sign it electronically. I understand my typed name and signature are legally binding to the same extent as a handwritten signature.";

// Shown next to the signing checkbox and stored with the signature, in the language the contract was sent in.
export const CONTRACT_CONSENT_TEXT_JA =
  "私は本契約書の内容を読み、電子署名により署名することに同意します。入力した氏名および署名が、手書きの署名と同様の法的効力を有することを理解しています。";
export const consentTextFor = (lang) => (isJapanese(lang) ? CONTRACT_CONSENT_TEXT_JA : CONTRACT_CONSENT_TEXT);

export const MILESTONE_MIN = 2;
export const MILESTONE_MAX = 6;
// First is the deposit, last is delivery; anything between is numbered (exactly three keeps "Mid-project").
export function milestoneLabel(i, n, lang) {
  if (isJapanese(lang)) {
    if (i === 0) return "着手金";
    if (i === n - 1) return "納品時のお支払い";
    return n === 3 ? "中間金" : `第${i + 1}回お支払い`;
  }
  if (i === 0) return "Upfront payment";
  if (i === n - 1) return "Delivery payment";
  return n === 3 ? "Mid-project payment" : `Milestone ${i + 1} payment`;
}
export const DEFAULT_MILESTONE_PERCENTS = [50, 50];
export const DEFAULT_REVISION_ROUNDS = 2;

// Starting point only. Have a lawyer review it for your jurisdiction.
export const DEFAULT_CONTRACT_BODY = `SERVICES AGREEMENT

This Agreement is made on {{effective_date}} between {{studio_name}} ("the Studio") and {{client_company}} ("the Client") for the project "{{project_name}}".

1. Project and scope
{{scope}}

Deliverables ({{shot_count}}):
{{deliverables}}

Production process: {{stages}}

2. Timeline
The Studio will deliver the work by {{deadline}}. This date assumes the Client supplies the required materials and gives feedback promptly. If materials or feedback arrive late, the deadline moves by the same amount of time.

3. Fees and payment
The total fee for this project is {{fee}}.

Payment schedule:
{{payment_schedule}}

Invoices are payable {{payment_terms}}. The Studio may pause work while an invoice is overdue.

4. Revisions
The fee includes {{revision_rounds}} round(s) of revisions per deliverable. Further revisions, and any work outside the scope above, are quoted and agreed in writing before the Studio starts them.

5. Changes to scope, budget or deadline
Any change to the scope, deliverables, fee or deadline must be agreed in writing by both parties (email is enough) before work on the change begins.

6. Client responsibilities
The Client will provide the materials the Studio reasonably needs, name one person who can approve work on the Client's behalf, and confirm it has the right to use all materials it supplies.

7. Ownership and use
The Studio owns the work until the full fee has been paid. When it has, the Client may use the final delivered work for this project. The Studio keeps ownership of its tools, working files and pre-existing materials. Once the work has been publicly released, the Studio may show it in its portfolio and on social media, unless the Client asks in writing to delay this.

8. Confidentiality
Each party will keep the other's non-public information confidential and use it only for this project, except where the law requires disclosure.

9. Cancellation
If the Client cancels, the Client pays for work completed up to the cancellation date and any costs the Studio cannot recover. The upfront payment is not refundable.

10. Liability
The Studio's total liability under this Agreement is limited to the fees paid for this project. Neither party is liable for indirect or consequential losses.

11. General
This Agreement is the entire agreement on its subject and may only be changed in writing agreed by both parties. It is governed by the laws of {{governing_law}}. Signing electronically has the same effect as signing on paper.

Signed for the Studio: {{studio_signatory}}`;

// Japanese counterpart of the template above (業務委託契約書). 甲 = the Client (委託者), 乙 = the Studio (受託者).
// Same {{placeholders}}, same structure and commercial terms. Starting point only: have a lawyer (or 行政書士) who
// reads Japanese review it, in particular the clause on who owns the copyright (著作権法27条・28条).
export const DEFAULT_CONTRACT_BODY_JA = `業務委託契約書

{{client_company}}（以下「甲」という。）と{{studio_name}}（以下「乙」という。）は、「{{project_name}}」（以下「本プロジェクト」という。）に関し、{{effective_date}}付けで、以下のとおり業務委託契約（以下「本契約」という。）を締結する。

第1条（業務内容）
乙は甲に対し、次の業務（以下「本業務」という。）を提供する。
{{scope}}

納品物（{{shot_count}}）：
{{deliverables}}

制作工程：{{stages}}

第2条（納期）
乙は、{{deadline}}までに本業務を納品する。この納期は、甲が必要な素材を提供し、速やかにフィードバックを行うことを前提とする。素材の提供またはフィードバックが遅れた場合、納期は遅れた期間と同じ期間だけ延長されるものとする。

第3条（報酬および支払い）
1. 本プロジェクトの報酬総額は{{fee}}とする。
2. 報酬は次のとおり支払う。
{{payment_schedule}}
3. 乙が発行する請求書は、{{payment_terms}}支払うものとする。請求書の支払いが遅延している間、乙は本業務を一時停止することができる。

第4条（修正対応）
報酬には、各納品物につき{{revision_rounds}}回までの修正対応が含まれる。これを超える修正および前条までに定める範囲外の業務については、乙が着手する前に見積りを提示し、書面により合意する。

第5条（範囲・報酬・納期の変更）
業務範囲、納品物、報酬または納期を変更する場合は、変更に着手する前に、甲乙間で書面（電子メールを含む。）により合意するものとする。

第6条（甲の責任）
甲は、乙が合理的に必要とする素材を提供し、甲に代わって業務の承認を行う担当者を1名指定し、乙に提供するすべての素材を使用する権利を有することを確認する。

第7条（権利の帰属および利用）
1. 本業務の成果物の権利は、報酬の全額が支払われるまで乙に帰属する。
2. 報酬の全額が支払われた時点で、甲は、本プロジェクトのために納品された最終成果物を利用することができる。
3. 乙は、乙の制作ツール、作業用ファイルおよび既存の素材に関する権利を引き続き保有する。
4. 乙は、成果物が公開された後は、甲が書面により延期を求めた場合を除き、乙のポートフォリオおよびソーシャルメディアで成果物を紹介することができる。

第8条（秘密保持）
甲および乙は、相手方の非公開情報を秘密として保持し、本プロジェクトの目的以外に使用しない。ただし、法令により開示が求められる場合はこの限りでない。

第9条（解約）
甲が本契約を解約する場合、甲は、解約日までに完了した業務に対する報酬、および乙が回収できない費用を支払う。着手金は返金しない。

第10条（責任の制限）
本契約に基づく乙の責任の総額は、本プロジェクトについて甲が支払った報酬の額を上限とする。いずれの当事者も、間接損害または派生的損害については責任を負わない。

第11条（一般条項）
1. 本契約は、その対象事項に関する甲乙間の完全な合意であり、甲乙が書面により合意した場合に限り変更することができる。
2. 本契約は{{governing_law}}に準拠し、同法に従って解釈される。
3. 電子署名による締結は、書面による署名と同一の効力を有するものとする。
4. 本契約に定めのない事項または本契約の解釈に疑義が生じた事項については、甲乙誠意をもって協議し、解決する。

乙の署名者：{{studio_signatory}}`;

export const defaultContractBodyFor = (lang) => (isJapanese(lang) ? DEFAULT_CONTRACT_BODY_JA : DEFAULT_CONTRACT_BODY);

// Wording the renderer inserts around project data. English values are exactly what the renderer always produced.
const BODY_WORDS = {
  en: {
    studio: "the Studio", client: "the Client", project: "the project",
    scope: "As described in the deliverables below.", shotCount: "to be agreed", stages: "to be agreed",
    agreed: "To be agreed in writing.", deadline: "a date to be agreed in writing",
    payTermsDays: (n) => `within ${n} days of the invoice date`, payTermsNone: "on receipt of invoice",
    due: (d) => ` (due ${d})`, sep: ", ", count: (n) => String(n),
    milestone: (label, pct, money) => `- ${label}: ${pct}% (${money})`, law: "[governing law]",
  },
  ja: {
    studio: "乙", client: "甲", project: "本プロジェクト",
    scope: "下記の納品物のとおりとする。", shotCount: "別途協議", stages: "別途協議",
    agreed: "別途、書面により合意する。", deadline: "書面により別途合意する日",
    payTermsDays: (n) => `請求書の発行日から${n}日以内に`, payTermsNone: "請求書の受領後直ちに",
    due: (d) => `（納期：${d}）`, sep: "、", count: (n) => `${n}点`,
    milestone: (label, pct, money) => `- ${label}：${pct}%（${money}）`, law: "[準拠法]",
  },
};

// ---- helpers --------------------------------------------------------------
export function parseMoney(value) {
  const n = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Japanese yen has no minor unit, so a yen fee is shown without decimals in a Japanese contract.
const YEN = new Set(["¥", "￥", "JPY", "円"]);
export const isYen = (symbol) => YEN.has(String(symbol || "").trim().toUpperCase());
export function formatContractMoney(symbol, amount, lang) {
  const s = symbol || "$";
  const ja = isJapanese(lang);
  const digits = ja && isYen(s) ? 0 : 2;
  const n = (Number(amount) || 0).toLocaleString(ja ? "ja-JP" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return s.length > 1 ? `${s} ${n}` : `${s}${n}`;
}

// "2026-03-15" and full ISO strings both read as a LOCAL calendar day (new Date("2026-03-15")
// would be UTC midnight and show the previous day for anyone west of UTC).
export function formatContractDate(value, lang) {
  if (!value) return "";
  let d;
  if (value instanceof Date) d = value;
  else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return "";                                   // anything that isn't YYYY-MM-DD... is not guessed at
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return "";   // e.g. 2026-02-31
  }
  if (Number.isNaN(d.getTime())) return "";
  if (isJapanese(lang)) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;   // 2026年3月15日
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function validateMilestonePercents(percents) {
  if (!Array.isArray(percents) || percents.length < MILESTONE_MIN || percents.length > MILESTONE_MAX) return { ok: false, error: `Use between ${MILESTONE_MIN} and ${MILESTONE_MAX} payments.` };
  const nums = percents.map((p) => (p === "" || p === null || p === undefined ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 100)) return { ok: false, error: "Each payment must be more than 0% and at most 100%." };
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) return { ok: false, error: `The payments add up to ${sum}%, they need to add up to 100%.` };
  return { ok: true, value: nums };
}

// Today's calendar day as YYYY-MM-DD. A Japanese contract is dated in Japan (JST) and an English one in the
// creator's local time; toISOString() would give the UTC day, i.e. yesterday for 00:00-09:00 JST.
export function todayISO(lang, now = new Date()) {
  if (isJapanese(lang)) return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ---- terms from project ---------------------------------------------------
/**
 * Reads the project (and its shots) into the snapshot stored on the contract.
 * `project` and `cards` are App.jsx's in-memory shapes; `contact` is a contacts.js contact.
 * Freelancer pay (assignedPay) is deliberately never read: this document goes to the client.
 */
export function buildContractTerms({ project, cards = [], contact = {}, studio = {}, milestonePercents, language, scopeOverride }) {
  const lang = normalizeLang(language);
  const projectCards = cards.filter((c) => c.projectId === project.id && String(c.title || "").trim());
  const autoTotal = projectCards.reduce((s, c) => s + parseMoney(c.rate), 0);
  const currency = project.currency || studio.currency || "$";
  // Yen has no minor unit: in a Japanese contract every amount is a whole yen, so the schedule printed in the
  // contract adds up exactly to the printed fee.
  const wholeYen = lang === "ja" && isYen(currency);
  const roundMoney = wholeYen ? Math.round : round2;
  const total = roundMoney(project.budgetMode === "auto" ? autoTotal : parseMoney(project.budget));

  const pcts = (milestonePercents && milestonePercents.length >= MILESTONE_MIN && milestonePercents.length <= MILESTONE_MAX ? milestonePercents : DEFAULT_MILESTONE_PERCENTS).map(Number);
  let allocated = 0;
  const milestones = pcts.map((percent, i) => {
    const amount = i === pcts.length - 1 ? roundMoney(total - allocated) : roundMoney((total * percent) / 100);
    allocated = roundMoney(allocated + amount);
    return { label: milestoneLabel(i, pcts.length, lang), percent, amount };
  });

  const stages = (project.pipelineStages || [])
    .filter((s) => s.isEnabled !== false && s.name)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((s) => s.name);

  // A Japanese contract often needs the scope written in Japanese even when the project notes are in English: an
  // explicit scope text replaces the project notes, and is remembered as custom so drift checks don't flag it.
  const customScope = String(scopeOverride ?? "").trim();
  return {
    language: lang,
    project_id: project.id,
    project_name: project.name || "",
    client_name: contact.name || project.client || "",
    client_company: contact.company || project.client || contact.name || "",
    client_address: project.clientAddress || "",
    client_tax_id: project.clientTaxId || "",
    scope: customScope || String(project.notes || "").trim(),
    ...(customScope ? { scope_custom: true } : {}),
    deliverables: projectCards.map((c) => ({ title: String(c.title).trim(), due: c.due || "" })),
    stages,
    currency,
    budget_total: total,
    budget_mode: project.budgetMode === "auto" ? "auto" : "manual",
    deadline: project.deadline || "",
    payment_terms_days: Number(studio.paymentTermsDays) || 0,
    milestones,
  };
}

// ---- body -----------------------------------------------------------------
export function renderContractBody(template, terms, vars = {}) {
  return renderContract(template, terms, vars).text;
}

// What the renderer could NOT fill in, judged from the template itself: unknown {{tokens}} and a {{governing_law}}
// with no governing law set. Text typed into the scope, client name etc. is never inspected, so a scope that happens
// to contain "[governing law]" or "{{fee}}" is not a problem.
export function findUnfilled(template, terms, vars = {}) {
  return renderContract(template, terms, vars).unfilled;
}

function renderContract(template, terms, vars = {}) {
  const t = terms || {};
  const lang = normalizeLang(vars.language ?? t.language);
  const w = BODY_WORDS[lang];
  const money = (n) => formatContractMoney(t.currency, n, lang);
  const deliverables = (t.deliverables || []).length
    ? t.deliverables.map((d, i) => `${i + 1}. ${d.title}${d.due ? w.due(formatContractDate(d.due, lang)) : ""}`).join("\n")
    : w.agreed;
  const schedule = (t.milestones || []).length
    ? t.milestones.map((m) => w.milestone(m.label, m.percent, money(m.amount))).join("\n")
    : w.agreed;

  const map = {
    studio_name: vars.studioName || w.studio,
    studio_signatory: vars.studioSignatory || vars.studioName || w.studio,
    client_name: t.client_name || vars.signerName || w.client,
    client_company: t.client_company || t.client_name || w.client,
    client_address: t.client_address || "",
    project_name: t.project_name || w.project,
    scope: t.scope || w.scope,
    shot_count: (t.deliverables || []).length ? w.count((t.deliverables || []).length) : w.shotCount,
    deliverables,
    stages: (t.stages || []).length ? t.stages.join(w.sep) : w.stages,
    fee: money(t.budget_total),
    currency: t.currency || "$",
    payment_schedule: schedule,
    payment_terms: Number(t.payment_terms_days) > 0 ? w.payTermsDays(t.payment_terms_days) : w.payTermsNone,
    deadline: formatContractDate(t.deadline, lang) || w.deadline,
    revision_rounds: String(vars.revisionRounds ?? DEFAULT_REVISION_ROUNDS),
    governing_law: vars.governingLaw || w.law,
    effective_date: vars.effectiveDate || formatContractDate(todayISO(lang), lang),
  };
  const unfilled = [];
  const text = String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(map, k)) { if (!unfilled.includes(m)) unfilled.push(m); return m; }
    if (k === "governing_law" && !vars.governingLaw && !unfilled.includes(w.law)) unfilled.push(w.law);
    return map[k];
  });
  return { text, unfilled };
}

// ---- drift: has the project moved since the contract was sent? -------------
const dayOf = (v) => String(v || "").slice(0, 10);
const delivSig = (list) => (list || []).map((d) => `${d.title}|${dayOf(d.due)}`).join("\n");

/** Human-readable list of what differs between a contract's frozen terms and the project now. */
export function compareTerms(frozen, current, lang) {
  if (!frozen || !current) return [];
  const out = [];
  if (Math.abs((Number(frozen.budget_total) || 0) - (Number(current.budget_total) || 0)) > 0.004 || (frozen.currency || "") !== (current.currency || "")) {
    out.push(`Fee ${formatContractMoney(frozen.currency, frozen.budget_total, lang)} \u2192 ${formatContractMoney(current.currency, current.budget_total, lang)}`);
  }
  if (dayOf(frozen.deadline) !== dayOf(current.deadline)) {
    out.push(`Deadline ${formatContractDate(frozen.deadline, lang) || "none"} \u2192 ${formatContractDate(current.deadline, lang) || "none"}`);
  }
  if (String(frozen.scope || "").trim() !== String(current.scope || "").trim()) out.push("Scope notes changed");
  if (delivSig(frozen.deliverables) !== delivSig(current.deliverables)) {
    const a = (frozen.deliverables || []).length, b = (current.deliverables || []).length;
    out.push(a !== b ? `Deliverables ${a} \u2192 ${b}` : "Deliverable names or due dates changed");
  }
  return out;
}

// The signature is shown with <img src=...>: only accept the PNG data URL the signing page itself produces, so a
// tampered row can never point the browser at some other URL.
export const isSafeSignatureSrc = (s) => typeof s === "string" && s.length < 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(s);

export const contractSignLink = (token) =>
  `${window.location.origin}${window.location.pathname}?share=contract&token=${token}`;

// The signing link carries a language hint so the "loading" / "invalid link" screens (shown before the contract is
// fetched) are already in the right language. Once loaded, the contract's own stored language decides.
export const contractSignLinkFor = (token, lang) => (isJapanese(lang) ? `${contractSignLink(token)}&lang=ja` : contractSignLink(token));

/** Subject and body of the "please sign" email, in the contract's language. */
export function contractEmail({ lang, studioName, contactName, project, link, days }) {
  if (isJapanese(lang)) {
    const name = String(contactName || "").trim();
    return {
      subject: `${studioName}：${project}の契約書へのご署名のお願い`,
      body: `${name ? `${name} 様` : "ご担当者様"}\n\nお世話になっております。${studioName}です。\n「${project}」に関する契約書をお送りいたします。内容をご確認のうえ、下記のリンクよりご署名をお願いいたします。\n${link}\n\nリンクの有効期限は${days}日間です。\n\nどうぞよろしくお願いいたします。\n${studioName}`,
    };
  }
  return {
    subject: `${studioName}: please sign the agreement for ${project}`,
    body: `Hi ${String(contactName || "").split(" ")[0]},\n\nPlease review and sign the agreement for ${project} here:\n${link}\n\nThe link expires in ${days} days.\n\nThanks,\n${studioName}`,
  };
}
