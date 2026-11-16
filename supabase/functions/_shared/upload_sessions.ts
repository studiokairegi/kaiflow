// Server-side bookkeeping for direct-to-Drive upload sessions (table public.upload_sessions).
//  * per-scope rate limiting of NEW sessions (an attacker holding a share token cannot open unlimited Drive sessions)
//  * the record the cleanup job needs to trash completed-but-never-finalized, rejected and duplicate Drive files
// Everything here FAILS OPEN: if the migration has not been applied yet, uploads keep working and the problem is logged.

export type UploadKind = "freelancer" | "final_qc";

// deno-lint-ignore no-explicit-any
type Db = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message?: string } | null }> };

export type SessionGate = { allowed: boolean; retryAfterSeconds: number };

export async function registerUploadSession(
  db: Db,
  args: { kind: UploadKind; uploadId: string; scope: string; userId: string; shotId: string; folderId: string; limit: number; windowSeconds: number },
): Promise<SessionGate> {
  try {
    const { data, error } = await db.rpc("register_upload_session", {
      p_kind: args.kind,
      p_upload_id: args.uploadId,
      p_scope: args.scope,
      p_user_id: args.userId,
      p_shot_id: args.shotId,
      p_folder_id: args.folderId,
      p_limit: args.limit,
      p_window_seconds: args.windowSeconds,
    });
    if (error) {
      console.error("register_upload_session failed (failing open):", error.message);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (data && data.allowed === false) return { allowed: false, retryAfterSeconds: Number(data.retry_after_seconds) || args.windowSeconds };
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    console.error("register_upload_session threw (failing open):", err instanceof Error ? err.message : String(err));
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export async function markUploadSessionFinalized(db: Db, kind: UploadKind, uploadId: string, driveFileId: string): Promise<void> {
  try {
    const { error } = await db.rpc("mark_upload_session_finalized", { p_kind: kind, p_upload_id: uploadId, p_drive_file_id: driveFileId });
    if (error) console.error("mark_upload_session_finalized failed:", error.message);
  } catch (err) {
    console.error("mark_upload_session_finalized threw:", err instanceof Error ? err.message : String(err));
  }
}

export const RATE_LIMIT_MESSAGE = "Too many uploads were started in a short time. Please wait a few minutes and try again.";
