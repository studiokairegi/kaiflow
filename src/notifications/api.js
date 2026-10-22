// src/notifications/api.js
// Network layer for the notification centre. Reads go through RLS (owner-only); every write goes
// through a SECURITY DEFINER function that uses auth.uid(), never a client-supplied user id.
import { supabase } from "../supabaseClient";
import { FEED_EVENT_TYPES, toMs } from "./logic.js";

const FEED_COLUMNS = "id, project_id, shot_id, event_type, description, created_at, meta";

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "request_failed");
  return data;
}

/** @param {string} userId only used to name/filter the realtime channel; RLS is the real gate. */
export function createNotificationApi(userId) {
  return {
    async init() {
      const baseline = await rpc("notification_init");
      const ms = toMs(baseline);
      if (ms === null) throw new Error("notification_init returned no baseline");
      return ms;
    },

    /** Newest first, strictly after the first-run baseline, bounded by `limit`. */
    async fetchPage({ afterMs, beforeIso, limit }) {
      let q = supabase
        .from("activity_log")
        .select(FEED_COLUMNS)
        .in("event_type", FEED_EVENT_TYPES)
        .gt("created_at", new Date(afterMs).toISOString())
        .order("created_at", { ascending: false })
        .limit(limit);
      if (beforeIso) q = q.lte("created_at", beforeIso); // lte + client-side dedupe: never skips same-timestamp rows
      const { data, error } = await q;
      if (error) throw new Error(error.message || "feed_failed");
      return data || [];
    },

    async fetchStates(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await supabase
          .from("notification_state")
          .select("activity_id, read_at, opened_at, snoozed_until, reminded_until")
          .in("activity_id", ids.slice(i, i + 100));
        if (error) throw new Error(error.message || "state_failed");
        out.push(...(data || []));
      }
      return out;
    },

    ack: (ids, opened) => rpc("ack_notifications", { p_activity_ids: ids, p_opened: !!opened }),
    snooze: (id) => rpc("snooze_notification", { p_activity_id: id }),
    markReminded: (ids) => rpc("mark_notifications_reminded", { p_activity_ids: ids }),

    /** Client comment text for a short preview. Owner-only RLS applies. Returns { commentId: body }. */
    async fetchCommentBodies(commentIds) {
      const { data, error } = await supabase.from("cut_comments").select("id, body").in("id", commentIds);
      if (error) throw new Error(error.message);
      return Object.fromEntries((data || []).map((r) => [String(r.id), r.body]));
    },

    /** Realtime INSERTs for this user's activity. Returns an unsubscribe function. */
    subscribe(onRow, onStatus) {
      const channel = supabase
        .channel("notification-center-" + userId)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log", filter: "user_id=eq." + userId }, (payload) => {
          if (payload && payload.new) onRow(payload.new);
        })
        .subscribe((status) => onStatus && onStatus(status));
      return () => { supabase.removeChannel(channel); };
    },
  };
}
