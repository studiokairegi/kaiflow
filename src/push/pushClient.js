// Browser side of Web Push. Everything is best-effort: a failure here must never break the app.
import { functionUrl, supabase } from "../supabaseClient";

const ENABLED_KEY = "kf_push_enabled";
const FUNCTION = "push";

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const pushEnabledLocally = () => { try { return window.localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; } };
const rememberEnabled = (on) => { try { if (on) window.localStorage.setItem(ENABLED_KEY, "1"); else window.localStorage.removeItem(ENABLED_KEY); } catch { /* optional */ } };

async function accessToken() {
  try { const { data } = await supabase.auth.getSession(); return data?.session?.access_token || null; } catch { return null; }
}

async function call(payload, { withUser = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (withUser) { const token = await accessToken(); if (token) headers.Authorization = `Bearer ${token}`; }
  const response = await fetch(functionUrl(FUNCTION), { method: "POST", headers, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) { const error = new Error(result.error || `http_${response.status}`); error.code = result.error; throw error; }
  return result;
}

// "user" for signed-in staff; { audience: "client"|"freelancer", share_token } or { audience: "guest", session } for portals.
const identity = (who) => (who && who.audience && who.audience !== "user" ? who : { audience: "user" });
const isUser = (who) => identity(who).audience === "user";

async function registration() {
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  try { const reg = await navigator.serviceWorker.getRegistration("/") || await registration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}

// Must be called from a click: the permission prompt needs a user gesture.
export async function enablePush(who, prefs) {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };
  try {
    const { key } = await call({ action: "public_key" });
    await registration();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await call({ action: "subscribe", ...identity(who), subscription: sub.toJSON(), open_url: `${window.location.pathname}${window.location.search}`, prefs }, { withUser: isUser(who) });
    if (isUser(who)) rememberEnabled(true);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.code === "push_not_configured" ? "not_configured" : "failed" };
  }
}

export async function disablePush(who) {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await call({ action: "unsubscribe", ...identity(who), endpoint: sub.endpoint }, { withUser: isUser(who) }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } finally { if (isUser(who)) rememberEnabled(false); }
}

// Re-posts the subscription with the latest Settings switches. Called when they change.
export async function syncPushPrefs(prefs) {
  if (!pushEnabledLocally()) return;
  try {
    const sub = await currentSubscription();
    if (sub) await call({ action: "subscribe", audience: "user", subscription: sub.toJSON(), open_url: "/", prefs }, { withUser: true });
  } catch { /* retried at the next change */ }
}

export async function schedulePush(jobs) {
  if (!pushEnabledLocally() || !jobs?.length) return;
  try { await call({ action: "schedule", jobs }, { withUser: true }); } catch { /* the in-page alert still works */ }
}
export async function cancelPush(keys) {
  if (!pushEnabledLocally() || !keys?.length) return;
  try { await call({ action: "cancel", keys }, { withUser: true }); } catch { /* ignore */ }
}
export async function sendTestPush() {
  try { await call({ action: "test" }, { withUser: true }); return { ok: true }; } catch (e) { return { ok: false, reason: e?.code || "failed" }; }
}
