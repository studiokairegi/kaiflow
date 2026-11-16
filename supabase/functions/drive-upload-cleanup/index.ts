// Scheduled housekeeping for direct-to-Drive uploads. Trashes (never permanently deletes) Drive files that no
// registered record points at:
//   * sessions never finalized after RETENTION_UNFINALIZED_DAYS: completed-but-abandoned uploads and files rejected by validation
//   * duplicates: extra files that share an upload id with the one file that WAS finalized
// A file is skipped (kept) whenever the app still references it: the recorded finalized id, any valid Final QC version
// for that upload key, any deliverable on the shot. Trashed files stay recoverable from Drive's trash for 30 days.
// Auth: header `x-cron-secret` must equal the UPLOAD_CLEANUP_SECRET secret (deployed with --no-verify-jwt so a
// scheduler can call it). Without the secret configured the function refuses to run.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getCachedAccessToken, listFilesByAppProperty, trashDriveFile } from "../_shared/google.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const RETENTION_UNFINALIZED_DAYS = 8; // Drive resumable sessions live ~7 days; the client forgets state after 6.
const DUPLICATE_SWEEP_AFTER_DAYS = 1;
const BATCH = 25;
const PROP: Record<string, string> = { freelancer: "freelancerUpload", final_qc: "finalQcUpload" };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// deno-lint-ignore no-explicit-any
type Row = any;

/** File ids the application still references for this session. Returns null when the lookup failed (skip the row, retry next run). */
// deno-lint-ignore no-explicit-any
async function referencedFileIds(db: any, row: Row): Promise<Set<string> | null> {
  const keep = new Set<string>();
  if (row.drive_file_id) keep.add(row.drive_file_id);
  if (row.kind === "final_qc") {
    const { data, error } = await db.from("cut_final_versions").select("drive_file_id,validation_status").eq("shot_id", row.shot_id).eq("upload_key", row.upload_id);
    if (error) return null;
    for (const v of data ?? []) if (v.validation_status === "valid" && v.drive_file_id) keep.add(v.drive_file_id);
  } else {
    const { data, error } = await db.from("shots").select("deliverables").eq("id", row.shot_id).maybeSingle();
    if (error) return null;
    for (const d of Array.isArray(data?.deliverables) ? data.deliverables : []) if (typeof d?.driveFileId === "string") keep.add(d.driveFileId);
  }
  return keep;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("UPLOAD_CLEANUP_SECRET") || "";
  if (!secret) return json({ error: "UPLOAD_CLEANUP_SECRET is not configured." }, 503);
  if (!safeEqual(req.headers.get("x-cron-secret") || "", secret)) return json({ error: "Forbidden" }, 403);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = Date.now();
  const unfinalizedBefore = new Date(now - RETENTION_UNFINALIZED_DAYS * 86_400_000).toISOString();
  const finalizedBefore = new Date(now - DUPLICATE_SWEEP_AFTER_DAYS * 86_400_000).toISOString();
  const { data: rows, error } = await db
    .from("upload_sessions")
    .select("id,kind,upload_id,user_id,shot_id,folder_id,drive_file_id,finalized_at")
    .is("cleaned_at", null)
    .or(`and(finalized_at.is.null,created_at.lt.${unfinalizedBefore}),finalized_at.lt.${finalizedBefore}`)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) { console.error("drive-upload-cleanup query failed:", error.message); return json({ error: "Query failed" }, 500); }

  const summary = { examined: rows?.length ?? 0, trashed: 0, skipped: 0, failed: 0 };
  for (const row of rows ?? []) {
    try {
      const keep = await referencedFileIds(db, row);
      if (!keep || !row.folder_id || !row.user_id || !PROP[row.kind]) { summary.skipped++; continue; }
      const { data: connection } = await db.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id", row.user_id).maybeSingle();
      if (connection) {
        const access = await getCachedAccessToken(await decryptText(connection.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!));
        const matches = await listFilesByAppProperty(access, row.folder_id, PROP[row.kind], row.upload_id);
        let allOk = true;
        for (const file of matches) {
          if (keep.has(file.id)) continue;
          if (await trashDriveFile(access, file.id)) summary.trashed++;
          else { allOk = false; summary.failed++; }
        }
        if (!allOk) continue; // leave the row open: retried on the next run
      }
      // No Drive connection any more means there is nothing this job can reach; close the row either way.
      await db.from("upload_sessions").update({ cleaned_at: new Date().toISOString() }).eq("id", row.id);
    } catch (err) {
      summary.failed++;
      console.error("drive-upload-cleanup row failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return json({ ok: true, ...summary });
});
