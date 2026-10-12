// src/tasksApi.js
// Network layer for Tasks, as a factory so it can be tested with a fake
// Supabase client (it imports no app code; the instance is tasksInstance.js).
// Every write goes through RLS (owner only) and the database guard trigger.

import {
  taskFromRow, taskToRow, seriesFromRow, seriesToRow,
  validateTaskInput, validateSeriesInput, describeTaskError, newRequestKey,
  planMaterialization, scheduleChanged, addDays,
} from "./tasks.js";

/** How far back completed/cancelled tasks are loaded for the Completed view and weekly review. */
export const HISTORY_DAYS = 60;

export function makeTasksApi(sb) {
  const fail = (error) => {
    const e = new Error(describeTaskError(error));
    e.code = error?.code;
    throw e;
  };
  const validation = (errors) => {
    const e = new Error(Object.values(errors)[0]);
    e.validation = errors;
    throw e;
  };
  const one = (q) => q.select().single();

  return {
    /** Open tasks (any date) + completed/cancelled ones from the last HISTORY_DAYS. */
    async list(today) {
      const since = addDays(today, -HISTORY_DAYS);
      const [open, done] = await Promise.all([
        sb.from("studio_tasks").select("*").in("status", ["todo", "in_progress"]),
        sb.from("studio_tasks").select("*").in("status", ["completed", "cancelled"]).gte("updated_at", `${since}T00:00:00Z`),
      ]);
      if (open.error) fail(open.error);
      if (done.error) fail(done.error);
      return [...(open.data || []), ...(done.data || [])].map(taskFromRow);
    },

    /**
     * Idempotent create. The same requestKey (double click / retry) or the same
     * sourceKey (a suggestion added twice) returns the first row instead of a
     * second one. Resolves { task, created }.
     */
    async create(input, { requestKey = newRequestKey(), sourceKey = null } = {}) {
      const v = validateTaskInput(input);
      if (!v.ok) validation(v.errors);
      const row = { ...taskToRow(v.value), request_key: requestKey, source_key: sourceKey };
      const { data, error } = await sb.from("studio_tasks").insert(row).select().single();
      if (error) {
        if (error.code === "23505") {
          const col = sourceKey ? "source_key" : "request_key";
          const { data: existing, error: e2 } = await sb.from("studio_tasks").select("*").eq(col, sourceKey || requestKey).maybeSingle();
          if (e2) fail(e2);
          if (existing) return { task: taskFromRow(existing), created: false };
        }
        fail(error);
      }
      return { task: taskFromRow(data), created: true };
    },

    /** Edit one task (for a series occurrence this edits only that occurrence). */
    async update(id, input) {
      const v = validateTaskInput(input);
      if (!v.ok) validation(v.errors);
      const patch = taskToRow(v.value);
      if (v.value.status === "completed" && input.completedOn) patch.completed_on = input.completedOn;
      const { data, error } = await one(sb.from("studio_tasks").update(patch).eq("id", id));
      if (error) fail(error);
      return taskFromRow(data);
    },

    /** Complete / reopen / start / cancel. Completing only touches this row, never its series. */
    async setStatus(id, status, today) {
      const patch = { status };
      if (status === "completed") patch.completed_on = today;
      const { data, error } = await one(sb.from("studio_tasks").update(patch).eq("id", id));
      if (error) fail(error);
      return taskFromRow(data);
    },

    /** Change the date of one task in place (null = unscheduled). */
    async reschedule(id, date) {
      const { data, error } = await one(sb.from("studio_tasks").update({ due_date: date }).eq("id", id));
      if (error) fail(error);
      return taskFromRow(data);
    },

    /** Move several tasks to one date in a single statement (carry forward). */
    async moveMany(taskIds, date) {
      if (!taskIds.length) return [];
      const { data, error } = await sb.from("studio_tasks").update({ due_date: date }).in("id", taskIds).select();
      if (error) fail(error);
      return (data || []).map(taskFromRow);
    },

    async setPriority(id, isPriority) {
      const { data, error } = await one(sb.from("studio_tasks").update({ is_priority: !!isPriority }).eq("id", id));
      if (error) fail(error);
      return taskFromRow(data);
    },

    /** Quick estimate change from the row; minutes or null. */
    async setEstimate(id, minutes) {
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) throw new Error("Estimate must be 1-1440 minutes.");
      const { data, error } = await one(sb.from("studio_tasks").update({ est_minutes: minutes }).eq("id", id));
      if (error) fail(error);
      return taskFromRow(data);
    },

    async reorder(orderedIds) {
      const { error } = await sb.rpc("studio_tasks_reorder", { p_ids: orderedIds });
      if (error) fail(error);
    },

    /**
     * Delete a one-off task. A recurring occurrence is skipped (cancelled)
     * instead of deleted: its row is what stops the series from generating it
     * again on the next refresh.
     */
    async remove(task) {
      if (task.seriesId) return this.setStatus(task.id, "cancelled");
      const { error } = await sb.from("studio_tasks").delete().eq("id", task.id);
      if (error) fail(error);
      return null;
    },

    // ----------------------------------------------------------- recurring

    async listSeries() {
      const { data, error } = await sb.from("studio_task_series").select("*").order("created_at", { ascending: true });
      if (error) fail(error);
      return (data || []).map(seriesFromRow);
    },

    /** Create the definition, then materialize its first occurrences. Resolves { series, created }. */
    async createSeries(input, today) {
      const v = validateSeriesInput(input);
      if (!v.ok) validation(v.errors);
      const { data, error } = await sb.from("studio_task_series").insert(seriesToRow(v.value)).select().single();
      if (error) fail(error);
      const series = seriesFromRow(data);
      const created = await this.materialize(series, today);
      return { series, created };
    },

    /**
     * Edit the series definition. Untouched future occurrences follow it;
     * occurrences edited, moved, started, starred or completed on their own are
     * kept. A schedule change regenerates the untouched future occurrences.
     */
    async updateSeries(before, input, today) {
      const v = validateSeriesInput(input);
      if (!v.ok) validation(v.errors);
      const { data, error } = await one(sb.from("studio_task_series").update(seriesToRow(v.value)).eq("id", before.id));
      if (error) fail(error);
      const series = seriesFromRow(data);
      const regenerate = scheduleChanged(before, series);
      const { error: e2 } = await sb.rpc("studio_task_series_sync", { p_series_id: series.id, p_today: today, p_regenerate: regenerate });
      if (e2) fail(e2);
      const refreshed = regenerate ? await this.refreshSeries(series.id) : series;
      if (regenerate) await this.materialize(refreshed, today);
      return refreshed;
    },

    async refreshSeries(id) {
      const { data, error } = await sb.from("studio_task_series").select("*").eq("id", id).single();
      if (error) fail(error);
      return seriesFromRow(data);
    },

    /** 'paused' | 'active' (resume) | 'ended'. */
    async setSeriesStatus(id, status, today) {
      const { error } = await sb.rpc("studio_task_series_set_status", { p_series_id: id, p_status: status, p_today: today });
      if (error) fail(error);
      const series = await this.refreshSeries(id);
      if (status === "active") await this.materialize(series, today);
      return status === "active" ? this.refreshSeries(id) : series;
    },

    /** Materialize one series if it needs it. Safe to call on every load; returns rows inserted. */
    async materialize(series, today) {
      const plan = planMaterialization(series, today);
      if (!plan) return 0;
      const { data, error } = await sb.rpc("studio_task_materialize", {
        p_series_id: series.id, p_dates: plan.dates, p_through: plan.through, p_today: today,
      });
      if (error) fail(error);
      return Number(data) || 0;
    },

    /** Materialize every active series. One failing series never blocks the others. */
    async ensureMaterialized(seriesList, today) {
      let inserted = 0;
      let failed = 0;
      for (const s of seriesList) {
        try {
          inserted += await this.materialize(s, today);
        } catch {
          failed += 1;
        }
      }
      return { inserted, failed };
    },
  };
}
