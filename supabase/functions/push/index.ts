// Web Push for KairFlow: subscribe / unsubscribe, timed alerts, and the dispatcher that sends them.
// Deploy with --no-verify-jwt: portal visitors have no login, and every action authenticates itself.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL),
//          optional PORTAL_HASH_PEPPER. SUPABASE_* are provided by the platform.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import {
  buildPayload, cleanPrefs, isGone, namespacedKey, safeOpenUrl, shouldDeliver, validSubscription, validateJobs,
} from "../_shared/push_logic.js";

const HEX64 = /^[0-9a-f]{64}$/;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const fields = await req.json().catch(() => ({})) as Record<string, any>;
    const action = String(fields.action || "");
    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const privateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    const subject = Deno.env.get("VAPID_SUBJECT") || "";

    if (action === "public_key") {
      if (!publicKey) throw new HttpError(503, "push_not_configured");
      return json({ ok: true, key: publicKey });
    }

    // ---- dispatcher: called by the database (pg_net / pg_cron) with a shared secret ----
    if (action === "dispatch") {
      const presented = req.headers.get("x-push-secret") || "";
      const { data: cfg } = await admin.from("push_config").select("dispatch_secret").maybeSingle();
      if (!cfg || !presented || !safeEqual(presented, cfg.dispatch_secret)) throw new HttpError(401, "invalid_credential");
      if (!publicKey || !privateKey || !subject) throw new HttpError(503, "push_not_configured");
      return json({ ok: true, ...(await dispatchDue(admin, publicKey, privateKey, subject)) });
    }

    const forwarded = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const ipHash = await sha256Hex(`${Deno.env.get("PORTAL_HASH_PEPPER") || ""}|${forwarded}`);
    const limited = async (scope: string, subjectHash: string, limit: number, seconds: number) => {
      const { data } = await admin.rpc("portal_rate_limit", { p_scope: scope, p_subject_hash: subjectHash, p_limit: limit, p_window_seconds: seconds });
      return data !== true;
    };
    if (await limited("push_ip", ipHash, 120, 60)) throw new HttpError(429, "rate_limited");

    // ---- who is calling: a signed-in user, or a portal visitor holding a link credential ----
    let userId: string | null = null;
    const auth = req.headers.get("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      const { data } = await admin.auth.getUser(auth.slice(7).trim());
      userId = data?.user?.id ?? null;
    }
    const resolvePortalThread = async (): Promise<string> => {
      const audience = String(fields.audience || "");
      if (audience === "client" || audience === "freelancer") {
        const share = String(fields.share_token || "").trim();
        if (share.length < 16 || share.length > 200) throw new HttpError(401, "invalid_credential");
        const { data } = await admin.rpc(audience === "client" ? "portal_client_resolve" : "portal_freelancer_resolve", { p_share_token: share });
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new HttpError(401, "invalid_credential");
        return row.thread_id;
      }
      if (audience === "guest") {
        const session = String(fields.session || "").trim().toLowerCase();
        if (!HEX64.test(session)) throw new HttpError(401, "invalid_credential");
        const { data } = await admin.rpc("portal_guest_resolve", { p_session_hash: await sha256Hex(session) });
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new HttpError(401, "invalid_credential");
        return row.thread_id;
      }
      throw new HttpError(400, "invalid_request");
    };

    if (action === "subscribe") {
      const sub = validSubscription(fields.subscription);
      if (!sub) throw new HttpError(400, "invalid_request");
      const isUser = String(fields.audience || "user") === "user";
      if (isUser && !userId) throw new HttpError(401, "invalid_credential");
      const threadId = isUser ? null : await resolvePortalThread();
      const row = {
        endpoint: sub.endpoint, p256dh: sub.p256dh, auth_secret: sub.auth,
        user_id: isUser ? userId : null, portal_thread_id: threadId,
        open_url: safeOpenUrl(fields.open_url), prefs: cleanPrefs(fields.prefs),
        user_agent: String(req.headers.get("user-agent") || "").slice(0, 300), last_seen_at: new Date().toISOString(), fail_count: 0,
      };
      const { error } = await admin.from("push_subscriptions").upsert(row, { onConflict: "endpoint" });
      if (error) throw new HttpError(500, "unexpected_error");
      return json({ ok: true });
    }

    if (action === "unsubscribe") {
      const endpoint = String(fields.endpoint || "");
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048) throw new HttpError(400, "invalid_request");
      const isUser = String(fields.audience || "user") === "user";
      if (isUser) {
        if (!userId) throw new HttpError(401, "invalid_credential");
        await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", userId);
      } else {
        await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("portal_thread_id", await resolvePortalThread());
      }
      return json({ ok: true });
    }

    // ---- everything below is for signed-in users only ----
    if (!userId) throw new HttpError(401, "invalid_credential");
    if (await limited("push_user", await sha256Hex(userId), 120, 60)) throw new HttpError(429, "rate_limited");

    if (action === "schedule") {
      const jobs = validateJobs(fields.jobs);
      if (!jobs) throw new HttpError(400, "invalid_request");
      for (const job of jobs) {
        const key = namespacedKey(userId, job.key);
        if (!key) throw new HttpError(400, "invalid_request");
        const { error } = await admin.rpc("push_enqueue_user", {
          p_user_id: userId, p_category: job.category, p_title: job.title, p_body: job.body, p_tag: job.tag, p_url: job.url,
          p_due_at: job.due_at, p_dedupe_key: key,
        });
        if (error) throw new HttpError(500, "unexpected_error");
      }
      return json({ ok: true });
    }

    if (action === "cancel") {
      const keys = (Array.isArray(fields.keys) ? fields.keys : []).slice(0, 10).map((k: unknown) => namespacedKey(userId!, String(k))).filter(Boolean) as string[];
      if (!keys.length) throw new HttpError(400, "invalid_request");
      await admin.from("push_jobs").delete().eq("user_id", userId).in("dedupe_key", keys).is("sent_at", null);
      return json({ ok: true });
    }

    if (action === "test") {
      if (await limited("push_test", await sha256Hex(userId), 5, 300)) throw new HttpError(429, "rate_limited");
      const { count } = await admin.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", userId);
      if (!count) throw new HttpError(404, "no_subscription");
      const { error } = await admin.rpc("push_enqueue_user", {
        p_user_id: userId, p_category: "general", p_title: "KairFlow alerts are on", p_body: "You will get alerts like this even when KairFlow is closed.",
        p_tag: "kairflow-test", p_url: "/", p_due_at: new Date().toISOString(), p_dedupe_key: null,
      });
      if (error) throw new HttpError(500, "unexpected_error");
      return json({ ok: true });
    }

    throw new HttpError(400, "invalid_request");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    return json({ error: "unexpected_error" }, 500);
  }
});

async function dispatchDue(admin: ReturnType<typeof createClient>, publicKey: string, privateKey: string, subject: string) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { data: jobs, error } = await admin.rpc("push_claim_jobs", { p_limit: 50 });
  if (error) throw new HttpError(500, "unexpected_error");
  let sent = 0, skipped = 0, dropped = 0, failed = 0;
  for (const job of jobs || []) {
    let query = admin.from("push_subscriptions").select("id, endpoint, p256dh, auth_secret, open_url, prefs");
    query = job.user_id ? query.eq("user_id", job.user_id) : query.eq("portal_thread_id", job.portal_thread_id);
    const { data: subs } = await query.limit(20);
    let retry = false;
    for (const sub of subs || []) {
      if (!shouldDeliver(sub.prefs, job.category)) { skipped++; continue; }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
          buildPayload(job, job.portal_thread_id ? sub.open_url : job.url),
          { TTL: 3600, urgency: "high", topic: job.tag ? String(job.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined : undefined },
        );
        sent++;
      } catch (err) {
        const status = Number((err as { statusCode?: number }).statusCode || 0);
        if (isGone(status)) { await admin.from("push_subscriptions").delete().eq("id", sub.id); dropped++; }
        else { failed++; retry = true; }
      }
    }
    if (!retry) await admin.rpc("push_finish_job", { p_job_id: job.id });
  }
  return { sent, skipped, dropped, failed };
}
