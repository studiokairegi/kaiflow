// src/pipeline.js
//
// Single source of truth for pipeline/progress math. Per the design report
// (kairil-pipeline-design-report-v2.md §6, §15), no other file may contain
// a duplicate of stagePercent/projectProgress-style calculations. Every
// consumer (App.jsx board/cards/dashboard, SharedViews.jsx portals) must
// call these functions instead of computing progress itself.
//
// A "pipeline" here is the ordered set of stage rows that apply to one
// project (today: the legacy family, built from the existing STAGES
// constant; after the schema migration: a project's project_stages rows).
// Nothing in this module hard-codes stage names or ids.

export const DELIVERED_STAGE_KEY = "delivered";

/**
 * @typedef {Object} StageRow
 * @property {string} stageKey   - value shots.stage stores for this row
 * @property {string} name
 * @property {string|null} phase - 'pre_production' | 'production' | 'post_production' | null (terminal)
 * @property {number} sortOrder
 * @property {'stage'|'terminal'} kind
 * @property {boolean} isEnabled
 */

/**
 * Build a pipeline view from a project's stage rows.
 * @param {StageRow[]} stageRows
 */
export function buildPipeline(stageRows) {
  const rows = [...stageRows].sort((a, b) => a.sortOrder - b.sortOrder);
  const byKey = new Map(rows.map((r) => [r.stageKey, r]));
  const enabled = rows.filter((r) => r.kind === "stage" && r.isEnabled);
  return { rows, byKey, enabled, n: enabled.length };
}

/**
 * Progress (0-100) for a single cut's stored stage key, or null if the
 * pipeline has no enabled stages or the key isn't part of this pipeline
 * (an "unrecognized stage" cut).
 * @param {ReturnType<typeof buildPipeline>} pipeline
 * @param {string} stageKey
 */
export function cutProgress(pipeline, stageKey) {
  if (stageKey === DELIVERED_STAGE_KEY) return 100;
  const { byKey, enabled, n } = pipeline;
  if (n === 0) return null;
  const stored = byKey.get(stageKey);
  if (!stored) return null;
  const passed = enabled.filter((r) => r.sortOrder < stored.sortOrder).length;
  return Math.round((Math.min(passed, n - 1) / n) * 100);
}

/**
 * Whether a cut's effective progress counts as "in an enabled stage",
 * "in a disabled/stranded stage", "delivered", or "unrecognized".
 */
export function cutState(pipeline, stageKey) {
  if (stageKey === DELIVERED_STAGE_KEY) return "delivered";
  const stored = pipeline.byKey.get(stageKey);
  if (!stored) return "unrecognized";
  if (stored.kind === "stage" && !stored.isEnabled) return "stranded";
  return "active";
}

/**
 * Aggregate progress for a project.
 * @param {ReturnType<typeof buildPipeline>} pipeline
 * @param {string[]} cutStageKeys - one entry per cut, its shots.stage value
 */
export function projectProgress(pipeline, cutStageKeys) {
  if (pipeline.n === 0) {
    return { percent: null, delivered: 0, total: cutStageKeys.length, state: "no_pipeline" };
  }
  if (cutStageKeys.length === 0) {
    return { percent: null, delivered: 0, total: 0, state: "no_shots" };
  }
  let sum = 0;
  let counted = 0;
  let delivered = 0;
  let unrecognized = 0;
  for (const stageKey of cutStageKeys) {
    if (stageKey === DELIVERED_STAGE_KEY) delivered += 1;
    const p = cutProgress(pipeline, stageKey);
    if (p === null) {
      unrecognized += 1;
      continue;
    }
    sum += p;
    counted += 1;
  }
  if (counted === 0) {
    return { percent: null, delivered, total: cutStageKeys.length, state: "unrecognized" };
  }
  return {
    percent: Math.round(sum / counted),
    delivered,
    total: cutStageKeys.length,
    unrecognized,
    state: "ok",
  };
}

/**
 * Per-phase progress, presentation only. Phases with zero enabled stages
 * are omitted entirely (never shown as 0% and never counted toward the
 * project percent).
 */
export function phaseSummary(pipeline, cutStageKeys) {
  const phases = ["pre_production", "production", "post_production"];
  const out = [];
  for (const phase of phases) {
    const stagesInPhase = pipeline.enabled.filter((r) => r.phase === phase);
    if (stagesInPhase.length === 0) continue;
    const n = stagesInPhase.length;
    let sum = 0;
    let counted = 0;
    for (const stageKey of cutStageKeys) {
      const stored = pipeline.byKey.get(stageKey);
      if (stageKey === DELIVERED_STAGE_KEY) {
        sum += 100;
        counted += 1;
        continue;
      }
      if (!stored) continue;
      const passed = stagesInPhase.filter((r) => r.sortOrder < stored.sortOrder).length;
      sum += Math.round((Math.min(passed, n - 1) / n) * 100);
      counted += 1;
    }
    out.push({
      phase,
      percent: counted === 0 ? null : Math.round(sum / counted),
      stageCount: n,
    });
  }
  return out;
}

/**
 * Per-enabled-stage status for a project's detail view: 'complete',
 * 'not_started', or 'in_progress', plus how many valid cuts sit in it.
 */
export function stageStatus(pipeline, cutStageKeys) {
  const valid = cutStageKeys.filter((k) => pipeline.byKey.has(k) || k === DELIVERED_STAGE_KEY);
  return pipeline.enabled.map((stage) => {
    let before = 0;
    let atOrAfter = 0;
    let inThisStage = 0;
    for (const stageKey of valid) {
      if (stageKey === DELIVERED_STAGE_KEY) {
        atOrAfter += 1;
        continue;
      }
      const stored = pipeline.byKey.get(stageKey);
      if (stored.sortOrder < stage.sortOrder) before += 1;
      else {
        atOrAfter += 1;
        if (stored.sortOrder === stage.sortOrder) inThisStage += 1;
      }
    }
    let status = "in_progress";
    if (valid.length > 0 && before === valid.length) status = "not_started";
    else if (valid.length > 0 && atOrAfter === valid.length && inThisStage === 0) status = "complete";
    return { stageKey: stage.stageKey, name: stage.name, status, cutsInStage: inThisStage };
  });
}

/**
 * The ordered set of board columns for a project: its enabled stages (in
 * order), any disabled ("stranded") stage that currently holds ≥1 cut,
 * the shared Delivered column last, and — only if some cut's stored key
 * matches nothing in this pipeline at all — a final "unrecognized" column.
 * Design report v2 §8. A lane with zero cuts and no enabled row simply
 * doesn't appear, so disabling an empty stage removes its column outright.
 */
export function boardColumns(pipeline, cutStageKeys) {
  const counts = new Map();
  for (const k of cutStageKeys) counts.set(k, (counts.get(k) || 0) + 1);

  const columns = pipeline.enabled.map((r) => ({
    stageKey: r.stageKey,
    name: r.name,
    kind: "enabled",
    count: counts.get(r.stageKey) || 0,
  }));

  const stranded = pipeline.rows
    .filter((r) => r.kind === "stage" && !r.isEnabled && (counts.get(r.stageKey) || 0) > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ stageKey: r.stageKey, name: r.name, kind: "stranded", count: counts.get(r.stageKey) }));

  columns.push(...stranded);
  columns.push({
    stageKey: DELIVERED_STAGE_KEY,
    name: "Delivered",
    kind: "delivered",
    count: counts.get(DELIVERED_STAGE_KEY) || 0,
  });

  const recognizedKeys = new Set(pipeline.rows.map((r) => r.stageKey));
  const unrecognizedCount = cutStageKeys.filter((k) => !recognizedKeys.has(k)).length;
  if (unrecognizedCount > 0) {
    columns.push({ stageKey: null, name: "Unrecognized stage", kind: "unrecognized", count: unrecognizedCount });
  }

  return columns;
}

/**
 * A project counts as complete once it has at least one cut and every cut
 * is Delivered. Independent of pipeline configuration/n, so it behaves
 * identically for legacy and canonical projects, and for a project with
 * "no pipeline configured" whose cuts happen to all be Delivered already.
 */
export function isProjectComplete(cutStageKeys) {
  return cutStageKeys.length > 0 && cutStageKeys.every((k) => k === DELIVERED_STAGE_KEY);
}
