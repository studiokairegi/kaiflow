// src/contracts.js
// Pure rules for client contracts (CRM > Contacts > client > Contracts). No network, no
// React, so it can be unit tested with `node --test src/contracts.test.mjs`.
//
// A contract is generated from a project: the scope (notes + shots), budget, deadline,
// production stages and payment milestones are read from the project at send time and
// FROZEN on the contract as `terms` (and rendered into `body`). If the project changes
// afterwards, compareTerms() reports what moved so the studio can send an updated one.

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

export const MILESTONE_LABELS = ["Upfront payment", "Mid-project payment", "Delivery payment"];
export const DEFAULT_MILESTONE_PERCENTS = [50, 25, 25];
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

// ---- helpers --------------------------------------------------------------
export function parseMoney(value) {
  const n = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function formatContractMoney(symbol, amount) {
  const s = symbol || "$";
  const n = (Number(amount) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s.length > 1 ? `${s} ${n}` : `${s}${n}`;
}

// "2026-03-15" and full ISO strings both read as a LOCAL calendar day (new Date("2026-03-15")
// would be UTC midnight and show the previous day for anyone west of UTC).
export function formatContractDate(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function validateMilestonePercents(percents) {
  if (!Array.isArray(percents) || percents.length !== 3) return { ok: false, error: "Enter three payment percentages." };
  const nums = percents.map((p) => (p === "" || p === null || p === undefined ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return { ok: false, error: "Each percentage must be between 0 and 100." };
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) return { ok: false, error: `The three payments add up to ${sum}%, they need to add up to 100%.` };
  return { ok: true, value: nums };
}

// ---- terms from project ---------------------------------------------------
/**
 * Reads the project (and its shots) into the snapshot stored on the contract.
 * `project` and `cards` are App.jsx's in-memory shapes; `contact` is a contacts.js contact.
 * Freelancer pay (assignedPay) is deliberately never read: this document goes to the client.
 */
export function buildContractTerms({ project, cards = [], contact = {}, studio = {}, milestonePercents }) {
  const projectCards = cards.filter((c) => c.projectId === project.id && String(c.title || "").trim());
  const autoTotal = projectCards.reduce((s, c) => s + parseMoney(c.rate), 0);
  const total = round2(project.budgetMode === "auto" ? autoTotal : parseMoney(project.budget));

  const pcts = (milestonePercents && milestonePercents.length === 3 ? milestonePercents : DEFAULT_MILESTONE_PERCENTS).map(Number);
  let allocated = 0;
  const milestones = pcts.map((percent, i) => {
    const amount = i === pcts.length - 1 ? round2(total - allocated) : round2((total * percent) / 100);
    allocated = round2(allocated + amount);
    return { label: MILESTONE_LABELS[i], percent, amount };
  });

  const stages = (project.pipelineStages || [])
    .filter((s) => s.isEnabled !== false && s.name)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((s) => s.name);

  return {
    project_id: project.id,
    project_name: project.name || "",
    client_name: contact.name || project.client || "",
    client_company: contact.company || project.client || contact.name || "",
    client_address: project.clientAddress || "",
    client_tax_id: project.clientTaxId || "",
    scope: String(project.notes || "").trim(),
    deliverables: projectCards.map((c) => ({ title: String(c.title).trim(), due: c.due || "" })),
    stages,
    currency: project.currency || studio.currency || "$",
    budget_total: total,
    budget_mode: project.budgetMode === "auto" ? "auto" : "manual",
    deadline: project.deadline || "",
    payment_terms_days: Number(studio.paymentTermsDays) || 0,
    milestones,
  };
}

// ---- body -----------------------------------------------------------------
export function renderContractBody(template, terms, vars = {}) {
  const t = terms || {};
  const deliverables = (t.deliverables || []).length
    ? t.deliverables.map((d, i) => `${i + 1}. ${d.title}${d.due ? ` (due ${formatContractDate(d.due)})` : ""}`).join("\n")
    : "To be agreed in writing.";
  const schedule = (t.milestones || []).length
    ? t.milestones.map((m) => `- ${m.label}: ${m.percent}% (${formatContractMoney(t.currency, m.amount)})`).join("\n")
    : "To be agreed in writing.";

  const map = {
    studio_name: vars.studioName || "the Studio",
    studio_signatory: vars.studioSignatory || vars.studioName || "the Studio",
    client_name: t.client_name || vars.signerName || "the Client",
    client_company: t.client_company || t.client_name || "the Client",
    client_address: t.client_address || "",
    project_name: t.project_name || "the project",
    scope: t.scope || "As described in the deliverables below.",
    shot_count: (t.deliverables || []).length ? String((t.deliverables || []).length) : "to be agreed",
    deliverables,
    stages: (t.stages || []).length ? t.stages.join(", ") : "to be agreed",
    fee: formatContractMoney(t.currency, t.budget_total),
    currency: t.currency || "$",
    payment_schedule: schedule,
    payment_terms: Number(t.payment_terms_days) > 0 ? `within ${t.payment_terms_days} days of the invoice date` : "on receipt of invoice",
    deadline: formatContractDate(t.deadline) || "a date to be agreed in writing",
    revision_rounds: String(vars.revisionRounds ?? DEFAULT_REVISION_ROUNDS),
    governing_law: vars.governingLaw || "[governing law]",
    effective_date: vars.effectiveDate || formatContractDate(new Date().toISOString().slice(0, 10)),
  };
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}

// ---- drift: has the project moved since the contract was sent? -------------
const dayOf = (v) => String(v || "").slice(0, 10);
const delivSig = (list) => (list || []).map((d) => `${d.title}|${dayOf(d.due)}`).join("\n");

/** Human-readable list of what differs between a contract's frozen terms and the project now. */
export function compareTerms(frozen, current) {
  if (!frozen || !current) return [];
  const out = [];
  if (Math.abs((Number(frozen.budget_total) || 0) - (Number(current.budget_total) || 0)) > 0.004 || (frozen.currency || "") !== (current.currency || "")) {
    out.push(`Fee ${formatContractMoney(frozen.currency, frozen.budget_total)} \u2192 ${formatContractMoney(current.currency, current.budget_total)}`);
  }
  if (dayOf(frozen.deadline) !== dayOf(current.deadline)) {
    out.push(`Deadline ${formatContractDate(frozen.deadline) || "none"} \u2192 ${formatContractDate(current.deadline) || "none"}`);
  }
  if (String(frozen.scope || "").trim() !== String(current.scope || "").trim()) out.push("Scope notes changed");
  if (delivSig(frozen.deliverables) !== delivSig(current.deliverables)) {
    const a = (frozen.deliverables || []).length, b = (current.deliverables || []).length;
    out.push(a !== b ? `Deliverables ${a} \u2192 ${b}` : "Deliverable names or due dates changed");
  }
  return out;
}

export const contractSignLink = (token) =>
  `${window.location.origin}${window.location.pathname}?share=contract&token=${token}`;
