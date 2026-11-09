import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rateLimitIpHash } from "../../supabase/functions/_shared/rate_limit_identity.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("Edge Function CORS never enables credentialed cross-origin cookies", () => {
  const cors = read("supabase/functions/_shared/cors.ts");
  assert.match(cors, /Access-Control-Allow-Origin.*\*/);
  assert.match(cors, /Access-Control-Allow-Headers.*authorization.*apikey.*content-type/i);
  assert.doesNotMatch(cors, /Access-Control-Allow-Credentials/i);
});

test("JWT bypass is explicit only for capability, webhook and one-time OAuth endpoints", () => {
  const config = read("supabase/config.toml");
  const expected = [
    "google-drive-connect", "google-drive-callback", "patreon-connect", "patreon-callback",
    "patreon-webhook", "paystack-checkout", "paystack-webhook", "resend-webhook",
    "intel-resend-webhook", "intel-gmail-callback", "intel-zoho-callback",
    "intel-provider-callback", "studio-invite-accept", "freelancer-drive-upload",
    "client-final-download", "portfolio-view", "portfolio-media", "portal-chat", "push",
  ];
  for (const name of expected) {
    assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s*\\nverify_jwt = false`), name);
  }
  for (const name of ["intel-provider-connect", "intel-provider-smtp-connect", "intel-provider-token", "account-manage", "email-send", "portfolio-drive", "chat-attachments"]) {
    assert.doesNotMatch(config, new RegExp(`\\[functions\\.${name}\\]\\s*\\nverify_jwt = false`), name);
  }
});

test("privileged user fields are guarded in the ordered migration chain", () => {
  const migration = read("supabase/migrations/20261201090000_intelligence_phase11_privileged_user_guard.sql");
  assert.match(migration, /create or replace function public\.protect_privileged_user_settings/);
  assert.match(migration, /auth\.role\(\).*service_role/s);
  assert.match(migration, /new\.is_admin := old\.is_admin/);
  assert.match(migration, /new\.plan := old\.plan/);
  assert.match(migration, /before insert or update on public\.user_settings/);
  assert.match(migration, /tgenabled in \('O', 'A'\)/);
  const baseAuthorization = read("supabase/migrations/20261108130000_intelligence_authorization.sql");
  const canonicalAuthorization = read("supabase/migrations/20261109090000_intelligence_authorization.sql");
  for (const source of [baseAuthorization, canonicalAuthorization]) {
    assert.ok(source.indexOf("create or replace function public.protect_privileged_user_settings") < source.indexOf("create or replace function public.intel_is_authorized"), "guard precedes authorization functions");
    assert.match(source, /before insert or update on public\.user_settings/);
  }
  const runner = read("supabase/tests/run_intelligence_auth.sh");
  assert.match(runner, /20261201090000_intelligence_phase11_privileged_user_guard\.sql/);
  const sqlTests = read("supabase/tests/intelligence_authorization.test.sql");
  assert.match(sqlTests, /privileged-user trigger blocks self-grant of admin and Pro/);
});

test("API discovery transport pins the DNS address validated by the allowlist check", () => {
  const api = read("intelligence-worker/kairflow_intel/apis.py");
  assert.match(api, /assert_public_url\(url, self\.resolver\)/);
  assert.match(api, /_PinnedAdapter\(addresses\[0\]\)/);
  assert.match(api, /owner\.trust_env = False/);
  assert.match(api, /allow_redirects=False/);
});

test("anonymous portfolio share lookup is body-bounded and rate-limited before token lookup", () => {
  const source = read("supabase/functions/portfolio-view/index.ts");
  assert.match(source, /MAX_BODY_BYTES = 4096/);
  assert.match(source, /getReader\(\)/);
  assert.match(source, /reader\.cancel\(\)/);
  assert.match(source, /portal_rate_limit/);
  assert.ok(source.indexOf("portal_rate_limit") < source.indexOf('.rpc("portfolio_public_get"'));
  assert.match(source, /p_scope: "portfolio_view_ip"/);
  assert.match(source, /p_scope: "portfolio_view_token"/);
  assert.match(source, /p_limit: 120, p_window_seconds: 60/);
  assert.match(source, /rateError.*503/s);
  assert.match(source, /tokenRateError.*503/s);
});

test("Intelligence service-role entry points authenticate the real caller before privileged work", () => {
  const auth = read("supabase/functions/_shared/intel_auth.ts");
  assert.match(auth, /auth\.getUser\(match\[1\]\)/);
  assert.match(auth, /userClient\.rpc\("intel_is_authorized"\)/);
  assert.match(auth, /anonKey/);
  assert.doesNotMatch(auth, /SUPABASE_SERVICE_ROLE_KEY/);
  const migration = read("supabase/migrations/20261109090000_intelligence_authorization.sql");
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /s\.is_admin is true/);
  assert.match(migration, /m\.role = 'master_user'/);
  assert.match(migration, /m\.status = 'active'/);
  assert.match(migration, /revoke all on function public\.intel_is_authorized\(\) from public, anon/);
});

test("Windows worker installers reference a checked-in, non-secret environment template", () => {
  const template = read("intelligence-worker/.env.example");
  assert.match(template, /KAIRFLOW_SUPABASE_URL=https:\/\/YOUR_PROJECT_REF/);
  assert.match(template, /KAIRFLOW_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY/);
  assert.match(template, /KAIRFLOW_AGENT_PASSWORD=$/m);
  assert.match(template, /KAIRFLOW_MAIL_PROVIDER=none/);
  for (const script of ["intelligence-worker/windows/install-controller.ps1", "intelligence-worker/windows/install-task.ps1"]) {
    assert.match(read(script), /\.env\.example/);
  }
});


test("rate-limit identity ignores spoofed forwarding headers and fails closed without trusted inputs", async () => {
  const pepper = "a".repeat(48);
  const spoofOnly = new Request("https://example.test", { headers: { "x-forwarded-for": "198.51.100.77" } });
  assert.equal(await rateLimitIpHash(spoofOnly, pepper), null);

  const trusted = new Request("https://example.test", { headers: {
    "cf-connecting-ip": "203.0.113.12",
    "x-forwarded-for": "198.51.100.77",
  } });
  const hash = await rateLimitIpHash(trusted, pepper);
  assert.match(hash || "", /^[0-9a-f]{64}$/);
  assert.equal(await rateLimitIpHash(trusted, "short"), null);
  assert.equal(await rateLimitIpHash(trusted, undefined), null);

  const malformedChain = new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.12, 198.51.100.77" } });
  assert.equal(await rateLimitIpHash(malformedChain, pepper), null);
});

test("anonymous rate limits trust only Cloudflare client IP and require a strong pepper", () => {
  const helper = read("supabase/functions/_shared/rate_limit_identity.ts");
  assert.match(helper, /cf-connecting-ip/);
  assert.doesNotMatch(helper, /req\.headers\.get\("x-forwarded-for"\)/i);
  assert.match(helper, /secret\.length < 32/);
  assert.match(helper, /return null/);
  for (const fn of ["portfolio-view", "portal-chat", "push"]) {
    const source = read(`supabase/functions/${fn}/index.ts`);
    assert.match(source, /rateLimitIpHash\(req, Deno\.env\.get\("PORTAL_HASH_PEPPER"\)\)/, fn);
    assert.doesNotMatch(source, /x-forwarded-for/i, fn);
    assert.match(source, /if \(!ipHash\)/, fn);
  }
});

test("portal sliding-window rate limiter serializes each bucket before counting and inserting", () => {
  const migration = read("supabase/migrations/20261201100000_intelligence_phase11_atomic_portal_rate_limit.sql");
  const lock = migration.indexOf("pg_advisory_xact_lock(v_lock_key)");
  const count = migration.indexOf("select count(*) into v_count");
  const insert = migration.indexOf("insert into public.portal_access_events(scope, subject_hash)");
  assert.ok(lock >= 0 && count > lock && insert > count);
  assert.match(migration, /hashtextextended\('portal_rate_limit:'/);
  assert.match(migration, /revoke all on function public\.portal_rate_limit\(text,text,integer,integer\)/);
  assert.match(migration, /grant execute on function public\.portal_rate_limit\(text,text,integer,integer\) to service_role/);
  const runner = read("supabase/tests/run_access_chat.sh");
  assert.match(runner, /20261201100000_intelligence_phase11_atomic_portal_rate_limit/);
  assert.match(runner, /concurrent rate-limit requests admitted exactly 5 of 20/);
});
