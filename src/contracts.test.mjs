// Run: node --test src/contracts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContractTerms, renderContractBody, compareTerms, validateMilestonePercents,
  formatContractMoney, formatContractDate, DEFAULT_CONTRACT_BODY,
} from "./contracts.js";

const project = { id: "p1", name: "Brand Film", client: "Acme", notes: "30s spot", budget: "150000", budgetMode: "manual", currency: "KSh", deadline: "2026-03-15", clientAddress: "1 Main St", pipelineStages: [{ name: "Animation", sortOrder: 2, isEnabled: true }, { name: "Storyboard", sortOrder: 1, isEnabled: true }, { name: "Hidden", sortOrder: 3, isEnabled: false }] };
const cards = [
  { projectId: "p1", title: "Shot 1", due: "2026-02-01", rate: "50000", assignedPay: "9999" },
  { projectId: "p1", title: "Shot 2", due: "", rate: "100000" },
  { projectId: "other", title: "Not mine", rate: "1" },
];
const contact = { name: "Jane Doe", company: "Acme Ltd" };

test("terms: reads project, ignores other projects, never includes freelancer pay", () => {
  const t = buildContractTerms({ project, cards, contact, studio: { paymentTermsDays: 14 } });
  assert.equal(t.budget_total, 150000);
  assert.deepEqual(t.deliverables.map((d) => d.title), ["Shot 1", "Shot 2"]);
  assert.deepEqual(t.stages, ["Storyboard", "Animation"]);
  assert.equal(t.client_company, "Acme Ltd");
  assert.equal(JSON.stringify(t).includes("9999"), false);
});

test("terms: auto budget sums shot rates", () => {
  const t = buildContractTerms({ project: { ...project, budgetMode: "auto", budget: "1" }, cards, contact });
  assert.equal(t.budget_total, 150000);
});

test("milestones: split by percent and the last one absorbs rounding", () => {
  const t = buildContractTerms({ project: { ...project, budget: "100" }, cards: [], contact, milestonePercents: [33.33, 33.33, 33.34] });
  assert.equal(t.milestones.reduce((s, m) => s + m.amount, 0).toFixed(2), "100.00");
  const d = buildContractTerms({ project, cards, contact });
  assert.deepEqual(d.milestones.map((m) => m.amount), [75000, 37500, 37500]);
});

test("percent validation", () => {
  assert.equal(validateMilestonePercents([50, 25, 25]).ok, true);
  assert.equal(validateMilestonePercents([50, 25, 20]).ok, false);
  assert.equal(validateMilestonePercents(["", 50, 50]).ok, false);
  assert.equal(validateMilestonePercents([110, -5, -5]).ok, false);
});

test("body: fills every placeholder in the default template", () => {
  const t = buildContractTerms({ project, cards, contact, studio: { paymentTermsDays: 14 } });
  const body = renderContractBody(DEFAULT_CONTRACT_BODY, t, { studioName: "Studio Kairegi", governingLaw: "Kenya", revisionRounds: 2, effectiveDate: "1 January 2026" });
  assert.equal(/\{\{/.test(body), false);
  assert.match(body, /KSh 150,000\.00/);
  assert.match(body, /15 March 2026/);
  assert.match(body, /within 14 days of the invoice date/);
  assert.match(body, /Upfront payment: 50% \(KSh 75,000\.00\)/);
  assert.match(body, /1\. Shot 1 \(due 1 February 2026\)/);
  assert.match(body, /30s spot/);
  assert.match(body, /Signed for the Studio: Studio Kairegi/);
});

test("body: missing deadline/scope/payment terms get safe wording", () => {
  const t = buildContractTerms({ project: { ...project, deadline: "", notes: "" }, cards: [], contact });
  const body = renderContractBody(DEFAULT_CONTRACT_BODY, t, { studioName: "S" });
  assert.match(body, /a date to be agreed in writing/);
  assert.match(body, /As described in the deliverables below/);
  assert.match(body, /on receipt of invoice/);
});

test("drift: reports fee, deadline, scope and deliverable changes only", () => {
  const frozen = buildContractTerms({ project, cards, contact });
  assert.deepEqual(compareTerms(frozen, buildContractTerms({ project, cards, contact })), []);
  const changed = buildContractTerms({ project: { ...project, budget: "180000", deadline: "2026-04-01", notes: "45s spot" }, cards: [...cards, { projectId: "p1", title: "Shot 3", rate: "1" }], contact });
  const d = compareTerms(frozen, changed);
  assert.equal(d.length, 4);
  assert.ok(d.some((x) => x.startsWith("Fee")) && d.some((x) => x.startsWith("Deadline")) && d.some((x) => x.startsWith("Scope")) && d.some((x) => x === "Deliverables 2 \u2192 3"));
});

test("formatting", () => {
  assert.equal(formatContractMoney("$", 1234.5), "$1,234.50");
  assert.equal(formatContractMoney("KSh", 10), "KSh 10.00");
  assert.equal(formatContractDate("2026-03-15T00:00:00Z"), "15 March 2026");
  assert.equal(formatContractDate(""), "");
});
