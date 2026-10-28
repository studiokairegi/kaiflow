// Notifications for the token-based portals (client and freelancer). These visitors have no account
// settings, so preferences live in this browser only. Everything here is best-effort and never throws.
import { toneById, scheduleTone, DEFAULT_MESSAGE_SOUND } from "../settings/tones.js";

const SOUND_KEY = "kf_portal_chat_sound";

export function readSoundPreference() {
  try { return window.localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; }
}
export function writeSoundPreference(on) {
  try { window.localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* optional */ }
}

// Returns the rows that are new since `seenIds` and were written by someone else.
export function findIncoming(rows, seenIds, isMine) {
  return rows.filter((row) => !seenIds.has(row.id) && !isMine(row));
}

export function previewBody(row) {
  const body = String(row?.body || "").replace(/\s+/g, " ").trim();
  if (body) return body.length > 120 ? `${body.slice(0, 117)}…` : body;
  return row?.attachments?.length ? "Sent an attachment" : "New message";
}

export function notificationPermission() {
  return typeof window !== "undefined" && "Notification" in window ? window.Notification.permission : "unsupported";
}
export async function requestNotificationPermission() {
  try { return await window.Notification.requestPermission(); } catch { return notificationPermission(); }
}

let context = null;
function audioContext() {
  const Ctor = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}
// Browsers allow audio only after a gesture; the first click/key press unlocks it for later messages.
export function unlockAudioOnGesture() {
  if (typeof window === "undefined") return () => {};
  const unlock = () => { try { audioContext()?.resume?.(); } catch { /* ignore */ } };
  const types = ["pointerdown", "keydown", "touchstart"];
  types.forEach((type) => window.addEventListener(type, unlock, { once: true, passive: true }));
  return () => types.forEach((type) => window.removeEventListener(type, unlock));
}

export async function playIncomingTone(volume = DEFAULT_MESSAGE_SOUND.volume) {
  try {
    const ctx = audioContext();
    if (!ctx) return "blocked";
    if (ctx.state === "suspended") { await ctx.resume(); if (ctx.state !== "running") return "blocked"; }
    scheduleTone(ctx, toneById(DEFAULT_MESSAGE_SOUND.id), volume);
    return "played";
  } catch { return "blocked"; }
}

export function showDesktopNotification(title, body, onClick) {
  if (notificationPermission() !== "granted") return null;
  try {
    const n = new window.Notification(title, { body, tag: "kf-portal-chat", icon: "/icon-512.png", silent: true });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
    window.setTimeout(() => n.close(), 15000);
    return n;
  } catch { return null; }
}
