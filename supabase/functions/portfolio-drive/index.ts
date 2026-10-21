// Owner-side portfolio media management, stored in a DEDICATED Google Drive folder.
// Authenticated (verify_jwt on, plus an explicit getUser check). Actions (POST):
//
//   JSON  {action:"init-upload", name, mimeType, size}     -> {uploadUrl}   browser PUTs the file to Drive
//   JSON  {action:"finalize", fileId, replaceItemId?}      -> {item}        verifies the file IN DRIVE, then records it
//   FORM  action=upload, file, replaceItemId?              -> {item}        small files (<=20 MB) in one request
//   JSON  {action:"delete", itemId}                        -> {ok}          trashes the Drive file + removes the row
//   JSON  {action:"previews"}                              -> {urls:{itemId:url}}   short-lived owner preview URLs
//   JSON  {action:"verify"}                                -> {items:[{id,status,detail}]}  Drive health of every item
//
// Files are created with the drive.file scope the app already uses, stay PRIVATE (never shared), and are
// only ever served through portfolio-media. The browser cannot register an arbitrary Drive file id: finalize
// checks it exists, is not trashed, sits in this studio's portfolio folder, and is an allowed type and size.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { createDriveFolder, createResumableUploadSession, getAccessToken, getDriveFileMeta, trashDriveFile, uploadFileToDrive } from "../_shared/google.ts";
import { kindFromMime, MAX_BYTES, SERVER_UPLOAD_MAX_BYTES, safeDriveName, validateUpload } from "../_shared/portfolio/validate.ts";
import { signMediaTicket } from "../_shared/portfolio/ticket.ts";

const FOLDER_NAME = "StudioKairegi Portfolio";
const PREVIEW_TTL_SECONDS = 2 * 3600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, message: string, public code = "error") { super(message); } }

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) throw new HttpError(401, "Missing Authorization header", "unauthenticated");
    const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await auth.auth.getUser(token);
    if (authError || !user) throw new HttpError(401, "Invalid session", "unauthenticated");
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const isForm = (req.headers.get("Content-Type") || "").includes("multipart/form-data");
    const form = isForm ? await req.formData() : null;
    const body = isForm ? {} : await req.json().catch(() => ({}));
    const action = String((isForm ? form!.get("action") : body.action) ?? "");

    // previews/verify/delete don't need a Drive folder up front; everything else does.
    const drive = await driveContext(db, user.id, action === "previews");

    switch (action) {
      case "init-upload": {
        const count = await itemCount(db, user.id);
        const v = validateUpload({ name: body.name, mimeType: body.mimeType, size: body.size }, body.replaceItemId ? 0 : count);
        if (!v.ok) throw new HttpError(400, v.error, "invalid_file");
        const folderId = await ensureFolder(db, user.id, drive!.accessToken);
        const uploadUrl = await createResumableUploadSession(drive!.accessToken, folderId, safeDriveName(body.name), String(body.mimeType), Number(body.size), req.headers.get("Origin") || undefined);
        return json({ uploadUrl });
      }
      case "finalize": {
        if (typeof body.fileId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(body.fileId)) throw new HttpError(400, "Missing Drive file id.", "invalid_file");
        const folderId = await ensureFolder(db, user.id, drive!.accessToken);
        return json({ item: await register(db, user.id, drive!.accessToken, folderId, body.fileId, body.replaceItemId, null) });
      }
      case "upload": {
        const file = form!.get("file");
        if (!(file instanceof File)) throw new HttpError(400, "No file received.", "invalid_file");
        const replaceItemId = typeof form!.get("replaceItemId") === "string" ? String(form!.get("replaceItemId")) : undefined;
        const v = validateUpload({ name: file.name, mimeType: file.type, size: file.size }, replaceItemId ? 0 : await itemCount(db, user.id));
        if (!v.ok) throw new HttpError(400, v.error, "invalid_file");
        if (file.size > SERVER_UPLOAD_MAX_BYTES) throw new HttpError(413, "This file is too large for a direct upload; the app uploads it straight to Google Drive instead.", "too_large");
        const folderId = await ensureFolder(db, user.id, drive!.accessToken);
        const up = await uploadFileToDrive(drive!.accessToken, folderId, safeDriveName(file.name), file, file.type, false);
        return json({ item: await register(db, user.id, drive!.accessToken, folderId, up.id, replaceItemId, file.name) });
      }
      case "delete": {
        const item = await ownItem(db, user.id, body.itemId);
        if (item.drive_file_id) await trashDriveFile(drive!.accessToken, item.drive_file_id);          // recoverable from Drive's trash
        else if (item.storage_path) await db.storage.from("portfolio").remove([item.storage_path]);
        const { error } = await db.from("portfolio_items").delete().eq("id", item.id).eq("user_id", user.id);
        if (error) throw new HttpError(500, `Couldn't remove the item: ${error.message}`);
        return json({ ok: true });
      }
      case "previews": {
        const key = Deno.env.get("DOWNLOAD_SIGNING_KEY");
        if (!key) throw new HttpError(503, "Media signing isn't configured (DOWNLOAD_SIGNING_KEY).", "not_configured");
        const { data: items } = await db.from("portfolio_items").select("id").eq("user_id", user.id);
        const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS;
        const urls: Record<string, string> = {};
        for (const it of items ?? []) urls[it.id] = `${Deno.env.get("SUPABASE_URL")}/functions/v1/portfolio-media?t=${encodeURIComponent(await signMediaTicket({ i: it.id, l: null, u: user.id, exp }, key))}`;
        return json({ urls });
      }
      case "verify": {
        const { data: items } = await db.from("portfolio_items").select("id, drive_file_id, storage_path").eq("user_id", user.id);
        const folderId = await ensureFolder(db, user.id, drive!.accessToken);
        const out: Array<{ id: string; status: string; detail?: string }> = [];
        const list = items ?? [];
        for (let i = 0; i < list.length; i += 5) {
          out.push(...await Promise.all(list.slice(i, i + 5).map(async (it) => {
            if (!it.drive_file_id) return { id: it.id, status: "legacy", detail: "Still in the old storage; move it to Google Drive." };
            try {
              const m = await getDriveFileMeta(drive!.accessToken, it.drive_file_id);
              if (!m) return { id: it.id, status: "missing", detail: "This file no longer exists in Google Drive (or the app can't access it)." };
              if (m.trashed) return { id: it.id, status: "trashed", detail: "This file is in your Google Drive trash." };
              if (!m.parents?.includes(folderId)) return { id: it.id, status: "moved", detail: "This file was moved out of the portfolio folder." };
              return { id: it.id, status: "ok" };
            } catch (e) { return { id: it.id, status: "error", detail: `Couldn't check Google Drive: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}` }; }
          })));
        }
        return json({ items: out });
      }
      default:
        throw new HttpError(400, "Unknown action.", "bad_request");
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
    console.error("portfolio-drive error:", err instanceof Error ? err.message : String(err));
    return json({ error: err instanceof Error ? err.message : "Something went wrong.", code: "server_error" }, 500);
  }
});

// ---- helpers ------------------------------------------------------------------------------------------------

async function driveContext(db: ReturnType<typeof createClient>, userId: string, optional: boolean) {
  if (optional) return null;
  const { data: conn } = await db.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id", userId).maybeSingle();
  if (!conn) throw new HttpError(400, "Connect Google Drive first; the portfolio is stored in your Drive.", "not_connected");
  try {
    const refresh = await decryptText(conn.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!);
    return { accessToken: await getAccessToken(refresh) };
  } catch (e) {
    console.error("portfolio Drive token failure:", e instanceof Error ? e.message : String(e));
    throw new HttpError(502, "Google Drive access has expired or was revoked. Reconnect Google Drive and try again.", "drive_auth");
  }
}

// The dedicated folder: remembered per studio, re-validated every time, recreated (visibly) if it was deleted.
async function ensureFolder(db: ReturnType<typeof createClient>, userId: string, accessToken: string): Promise<string> {
  const { data: row } = await db.from("portfolio_settings").select("drive_folder_id").eq("user_id", userId).maybeSingle();
  if (row?.drive_folder_id) {
    const meta = await getDriveFileMeta(accessToken, row.drive_folder_id);
    if (meta && !meta.trashed) return row.drive_folder_id;
  }
  const folder = await createDriveFolder(accessToken, FOLDER_NAME);
  const { error } = await db.from("portfolio_settings").upsert({ user_id: userId, drive_folder_id: folder.id, updated_at: new Date().toISOString() });
  if (error) throw new HttpError(500, `Couldn't save the portfolio folder: ${error.message}`);
  return folder.id;
}

async function itemCount(db: ReturnType<typeof createClient>, userId: string): Promise<number> {
  const { count } = await db.from("portfolio_items").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return count ?? 0;
}

async function ownItem(db: ReturnType<typeof createClient>, userId: string, id: unknown) {
  if (typeof id !== "string") throw new HttpError(400, "Missing item.", "bad_request");
  const { data } = await db.from("portfolio_items").select("id, drive_file_id, storage_path, title").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "Portfolio item not found.", "not_found");
  return data;
}

// Verifies the Drive file, then inserts a new item or swaps the media of an existing one.
async function register(db: ReturnType<typeof createClient>, userId: string, accessToken: string, folderId: string,
                        fileId: string, replaceItemId: unknown, originalName: string | null) {
  const meta = await getDriveFileMeta(accessToken, fileId);
  if (!meta) throw new HttpError(422, "Google Drive has no such file yet. The upload may not have finished.", "drive_file_missing");
  if (meta.trashed) throw new HttpError(422, "That file is in the Drive trash.", "drive_file_missing");
  if (!meta.parents?.includes(folderId)) throw new HttpError(422, "That file isn't in your portfolio folder.", "drive_file_foreign");
  const kind = kindFromMime(meta.mimeType || "");
  const size = Number(meta.size);
  if (!kind) throw new HttpError(422, "Unsupported file type.", "invalid_file");
  if (!(size > 0) || size > MAX_BYTES) throw new HttpError(422, "The uploaded file is empty or too large.", "invalid_file");

  const media = { kind, mime_type: meta.mimeType!, size_bytes: size, drive_file_id: fileId, storage_path: null as string | null };
  if (replaceItemId !== undefined && replaceItemId !== null && replaceItemId !== "") {
    const old = await ownItem(db, userId, replaceItemId);
    const { data, error } = await db.from("portfolio_items").update({ ...media, updated_at: new Date().toISOString() }).eq("id", old.id).select("*").single();
    if (error) { await trashDriveFile(accessToken, fileId); throw new HttpError(500, `Couldn't update the item: ${error.message}`); }
    if (old.drive_file_id && old.drive_file_id !== fileId) await trashDriveFile(accessToken, old.drive_file_id);
    else if (old.storage_path) await db.storage.from("portfolio").remove([old.storage_path]);   // legacy -> Drive migration
    return data;
  }
  const { data: last } = await db.from("portfolio_items").select("sort_order").eq("user_id", userId).order("sort_order", { ascending: false }).limit(1);
  const title = safeDriveName(originalName ?? meta.name ?? "").replace(/\.[^.]+$/, "").slice(0, 120);
  const { data, error } = await db.from("portfolio_items").insert({ user_id: userId, title, sort_order: (last?.[0]?.sort_order ?? -1) + 1, ...media }).select("*").single();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "That file was already added.", "duplicate");
    await trashDriveFile(accessToken, fileId);                         // never leave an orphan in Drive
    throw new HttpError(500, `Couldn't save the item: ${error.message}`);
  }
  return data;
}
