// Regression harness for the pipeline redesign (design report v2 §6.5,
// §16 phase 1 exit gate). Proves that feeding today's legacy stage list
// through the new pipeline.js reproduces the current stagePercent /
// projectProgress output exactly, for every stage and for aggregate
// project progress. Run with: node src/pipeline.regression.test.mjs

import assert from "node:assert/strict";
import {
  buildPipeline,
  cutProgress,
  projectProgress,
  isProjectComplete,
} from "./pipeline.js";

// ---- 1. The CURRENT implementation, copied verbatim from App.jsx:16-29
//         and :251-263, kept here only as the thing being regression-
//         tested against. Never edited to match pipeline.js.
const STAGES = [
  { id: "character_design", label: "Character Design" },
  { id: "bg_lighting", label: "BG & Lighting Design" },
  { id: "storyboard", label: "Storyboard" },
  { id: "layout", label: "Layout" },
  { id: "genga", label: "Genga" },
  { id: "douga", label: "Douga" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "frametest", label: "Frame Test" },
  { id: "cleanup", label: "Cleanup & Color" },
  { id: "compositing", label: "Compositing" },
  { id: "editing", label: "Editing" },
  { id: "delivered", label: "Delivered" },
];

function legacyStagePercent(stageId) {
  const index = STAGES.findIndex((s) => s.id === stageId);
  if (index === -1) return 0;
  return Math.round((index / (STAGES.length - 1)) * 100);
}

function legacyProjectProgress(projectCards) {
  const delivered = projectCards.filter((c) => c.stage === "delivered").length;
  if (projectCards.length === 0) return { delivered, percent: 0 };
  const total = projectCards.reduce((sum, c) => sum + legacyStagePercent(c.stage), 0);
  const percent = Math.round(total / projectCards.length);
  return { delivered, percent };
}

// ---- 2. The SAME 12 stages, expressed as pipeline.js rows (this is what
//         the phase-2 backfill will insert into project_stages for every
//         existing project — see design report v2 §5.1, §10.1 step 2).
const legacyRows = STAGES.map((s, i) => ({
  stageKey: s.id,
  name: s.label,
  phase: null, // legacy family has no phase grouping (report §5.2)
  sortOrder: i * 10,
  kind: s.id === "delivered" ? "terminal" : "stage",
  isEnabled: true,
}));
const legacyPipeline = buildPipeline(legacyRows);

// ---- 3. Per-stage regression: every legacy stage must produce the exact
//         same percent under both implementations.
let failures = 0;
for (const s of STAGES) {
  const expected = legacyStagePercent(s.id);
  const actual = cutProgress(legacyPipeline, s.id);
  try {
    assert.equal(actual, expected, `stage "${s.id}"`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${s.id}: expected ${expected}, got ${actual}`);
  }
}

// Sanity: the exact sequence quoted in the design report §6.5.
const expectedSequence = [0, 9, 18, 27, 36, 45, 55, 64, 73, 82, 91, 100];
const actualSequence = STAGES.map((s) => cutProgress(legacyPipeline, s.id));
assert.deepEqual(actualSequence, expectedSequence, "legacy sequence must match report §6.5");

// ---- 4. Aggregate project progress regression, across representative
//         cut mixes (empty, single-stage, mixed, all-delivered).
const scenarios = [
  { name: "empty project", cards: [] },
  { name: "single cut at genga", cards: [{ stage: "genga" }] },
  {
    name: "mixed in-flight project",
    cards: [
      { stage: "character_design" },
      { stage: "genga" },
      { stage: "douga" },
      { stage: "cleanup" },
      { stage: "delivered" },
    ],
  },
  {
    name: "fully delivered project",
    cards: [{ stage: "delivered" }, { stage: "delivered" }, { stage: "delivered" }],
  },
];

for (const { name, cards } of scenarios) {
  const expected = legacyProjectProgress(cards);
  const stageKeys = cards.map((c) => c.stage);
  const actual = projectProgress(legacyPipeline, stageKeys);

  // NOTE: legacyProjectProgress returns percent:0 for an empty project;
  // pipeline.js returns percent:null + state:"no_shots" for the same
  // case, per design report v2 D3 (approved: "No shots yet" replaces a
  // misleading 0%). That is an intentional, approved behavior change,
  // not a regression, so it is asserted separately rather than compared
  // directly against the legacy 0%.
  if (cards.length === 0) {
    try {
      assert.equal(actual.percent, null, `${name}: percent should be null (D3)`);
      assert.equal(actual.state, "no_shots", `${name}: state should be no_shots`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${name}: ${e.message}`);
    }
    continue;
  }

  try {
    assert.equal(actual.percent, expected.percent, `${name}: percent`);
    assert.equal(actual.delivered, expected.delivered, `${name}: delivered count`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got percent=${actual.percent} delivered=${actual.delivered}`);
  }
}

// ---- 5. isProjectComplete regression against today's
//         `shots.length>0 && every stage==='delivered'` rule
//         (App.jsx:1773, computeDashboardStats).
const completeCases = [
  { name: "no cuts", cards: [], expected: false },
  { name: "one delivered", cards: [{ stage: "delivered" }], expected: true },
  {
    name: "one delivered, one not",
    cards: [{ stage: "delivered" }, { stage: "genga" }],
    expected: false,
  },
  {
    name: "all delivered, three cuts",
    cards: [{ stage: "delivered" }, { stage: "delivered" }, { stage: "delivered" }],
    expected: true,
  },
];
for (const { name, cards, expected } of completeCases) {
  const legacyRule = cards.length > 0 && cards.every((c) => c.stage === "delivered");
  const actual = isProjectComplete(cards.map((c) => c.stage));
  try {
    assert.equal(actual, expected, `${name}: expected`);
    assert.equal(actual, legacyRule, `${name}: must match legacy rule`);
  } catch (e) {
    failures++;
    console.error(`FAIL isProjectComplete ${name}: ${e.message}`);
  }
}

// ---- Result
if (failures > 0) {
  console.error(`\n${failures} regression failure(s).`);
  process.exit(1);
} else {
  console.log("All pipeline.js regression checks passed:");
  console.log(`  - ${STAGES.length} legacy stage percentages match exactly`);
  console.log(`  - sequence matches design report §6.5: [${actualSequence.join(", ")}]`);
  console.log(`  - ${scenarios.length} project-progress scenarios match (empty project intentionally now null/"No shots yet" per D3)`);
  console.log(`  - ${completeCases.length} isProjectComplete cases match today's rule`);
  process.exit(0);
}
