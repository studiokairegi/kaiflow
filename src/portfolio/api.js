import { supabase, functionUrl } from "../supabaseClient";
import { buildStoragePath, kindFromMime, sortItems, nextSortOrder } from "./logic.js";

const BUCKET = "portfolio";
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const unique = () => (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 16);

export async function listItems() {
  return sortItems(unwrap(await supabase.from("portfolio_items").select("*")));
}
export async function listLinks() {
  return unwrap(await supabase.from("portfolio_links").select("*").order("created_at", { ascending: false }));
}

// Owner-side previews: signed URLs for the private bucket, keyed by storage_path.
export async function previewUrls(paths) {
  if (!paths.length) return {};
  const rows = unwrap(await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600));
  return Object.fromEntries(rows.filter((r) => r.signedUrl).map((r) => [r.path, r.signedUrl]));
}

async function currentUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) throw new Error("You're signed out. Please sign in again.");
  return data.user.id;
}
async function uploadFile(userId, file) {
  const path = buildStoragePath(userId, file.name, unique());
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
  if (error) throw new Error(error.message);
  return path;
}

export async function addItem(file, existingItems) {
  const userId = await currentUserId();
  const path = await uploadFile(userId, file);
  const row = { kind: kindFromMime(file.type), title: file.name.replace(/\.[^.]+$/, "").slice(0, 120), storage_path: path, mime_type: file.type, size_bytes: file.size, sort_order: nextSortOrder(existingItems) };
  const { error } = await supabase.from("portfolio_items").insert(row);
  if (error) { await supabase.storage.from(BUCKET).remove([path]); throw new Error(error.message); }   // no orphaned files
}

// Replace the media of an existing item (keeps title, caption and position).
export async function replaceItemFile(item, file) {
  const userId = await currentUserId();
  const path = await uploadFile(userId, file);
  const { error } = await supabase.from("portfolio_items").update({ kind: kindFromMime(file.type), storage_path: path, mime_type: file.type, size_bytes: file.size, updated_at: new Date().toISOString() }).eq("id", item.id);
  if (error) { await supabase.storage.from(BUCKET).remove([path]); throw new Error(error.message); }
  await supabase.storage.from(BUCKET).remove([item.storage_path]);
}

export async function updateItem(id, patch) {
  unwrap(await supabase.from("portfolio_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("id"));
}
export async function saveOrder(items) {
  await Promise.all(items.map((i) => supabase.from("portfolio_items").update({ sort_order: i.sort_order }).eq("id", i.id).then(unwrap)));
}
export async function deleteItem(item) {
  unwrap(await supabase.from("portfolio_items").delete().eq("id", item.id).select("id"));
  await supabase.storage.from(BUCKET).remove([item.storage_path]);
}

export async function createLink(label, expiresDays) {
  const r = unwrap(await supabase.rpc("portfolio_create_link", { p_label: label || "", p_expires_days: expiresDays ?? null }));
  return Array.isArray(r) ? r[0] : r;
}
export async function revokeLink(id) { unwrap(await supabase.rpc("portfolio_revoke_link", { p_link: id })); }

// PUBLIC: what the /portfolio/{token} page calls. null => invalid, expired or revoked.
export async function fetchPublicPortfolio(token) {
  const res = await fetch(functionUrl("portfolio-view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't load the portfolio.");
  return res.json();
}
