// Final QC Drive folder provisioning.
//
// Layout (follows the existing per-project / per-cut convention):
//   <Project root>/
//     References/ Cuts/ Deliverables/ Attachments/   <- untouched, existing
//     Final QC/                                      <- NEW, one per project
//       <Cut title>/                                 <- NEW, one per cut
//
// Idempotent and race-safe:
//   1. A persisted folder id is reused if Drive confirms it still exists and
//      isn't trashed.
//   2. Otherwise an existing folder with the exact name is adopted (so
//      retries and projects that already have a manually created "Final QC"
//      reuse it instead of duplicating).
//   3. Otherwise one is created, and its id is stored with a compare-and-set
//      UPDATE. If a concurrent request won the race, the loser trashes the
//      folder it just created and uses the winner's.
// Nothing here moves, renames or deletes existing folders or files.

import {
  createDriveFolder,
  findChildFolder,
  getDriveFileMeta,
  trashDriveFile,
} from "./google.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";
export const FINAL_QC_FOLDER_NAME = "Final QC";

// deno-lint-ignore no-explicit-any
type Supabase = any;

export function cleanFolderName(title: string | null | undefined, fallback: string): string {
  const cleaned = (title || "").replace(/[^\w\- ]+/g, "").trim();
  return cleaned || fallback;
}

async function folderIsUsable(accessToken: string, folderId: string): Promise<boolean> {
  const meta = await getDriveFileMeta(accessToken, folderId);
  return !!meta && !meta.trashed && meta.mimeType === FOLDER_MIME;
}

async function resolveFolder(opts: {
  accessToken: string;
  parentId: string;
  name: string;
  persistedId: string | null;
  // Compare-and-set persistence: resolves to the id that ended up stored.
  persist: (newId: string, staleId: string | null) => Promise<string>;
}): Promise<string> {
  const { accessToken, parentId, name, persistedId, persist } = opts;

  if (persistedId && (await folderIsUsable(accessToken, persistedId))) {
    return persistedId;
  }

  const existing = await findChildFolder(accessToken, parentId, name);
  if (existing) {
    return await persist(existing.id, persistedId);
  }

  const created = await createDriveFolder(accessToken, name, parentId);
  const stored = await persist(created.id, persistedId);
  if (stored !== created.id) {
    // Lost a concurrent race: don't leave a duplicate folder behind.
    await trashDriveFile(accessToken, created.id);
  }
  return stored;
}

export async function ensureFinalQcFolders(
  supabase: Supabase,
  accessToken: string,
  project: { id: string; drive_folder_id: string | null; drive_final_qc_folder_id: string | null },
  shot: { id: string; title: string | null; drive_final_qc_folder_id: string | null }
): Promise<{ projectFolderId: string; cutFolderId: string }> {
  if (!project.drive_folder_id) {
    throw new Error("not_connected");
  }

  const projectFolderId = await resolveFolder({
    accessToken,
    parentId: project.drive_folder_id,
    name: FINAL_QC_FOLDER_NAME,
    persistedId: project.drive_final_qc_folder_id,
    persist: async (newId, staleId) => {
      let q = supabase.from("projects").update({ drive_final_qc_folder_id: newId }).eq("id", project.id);
      q = staleId ? q.eq("drive_final_qc_folder_id", staleId) : q.is("drive_final_qc_folder_id", null);
      const { data, error } = await q.select("drive_final_qc_folder_id");
      if (error) throw new Error(`Couldn't save the Final QC folder: ${error.message}`);
      if (data && data.length > 0) return newId;
      const { data: row } = await supabase
        .from("projects")
        .select("drive_final_qc_folder_id")
        .eq("id", project.id)
        .maybeSingle();
      return row?.drive_final_qc_folder_id || newId;
    },
  });

  const cutName = cleanFolderName(shot.title, "Cut");
  const cutFolderId = await resolveFolder({
    accessToken,
    parentId: projectFolderId,
    name: cutName,
    persistedId: shot.drive_final_qc_folder_id,
    persist: async (newId, staleId) => {
      let q = supabase.from("shots").update({ drive_final_qc_folder_id: newId }).eq("id", shot.id);
      q = staleId ? q.eq("drive_final_qc_folder_id", staleId) : q.is("drive_final_qc_folder_id", null);
      const { data, error } = await q.select("drive_final_qc_folder_id");
      if (error) throw new Error(`Couldn't save the cut's Final QC folder: ${error.message}`);
      if (data && data.length > 0) return newId;
      const { data: row } = await supabase
        .from("shots")
        .select("drive_final_qc_folder_id")
        .eq("id", shot.id)
        .maybeSingle();
      return row?.drive_final_qc_folder_id || newId;
    },
  });

  return { projectFolderId, cutFolderId };
}
