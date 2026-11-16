-- Phase 3 chat provenance (20270102090000) against real Postgres. Same fixture as intelligence_v1.test.sql (ADMIN ...e1, AGENT ...f0, orgA).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it, after the full migration chain, before trusting the migration.
-- It is not yet wired into run_intelligence_auth.sh.
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  t uuid; m bigint; r record;
begin
  perform ti.as_user(ADMIN);
  t := intel_admin_chat_new_thread('Provenance');
  m := (intel_admin_chat_send(t, 'hello', 'prov1') ->> 'message_id')::bigint;
  perform ti.as_user(AGENT);
  perform intel_agent_chat_reply(t, m, 'Answer', 'done',
    '{"provider":"gemini","model":"gemini-3.8-flash","route_reason":null,"latency_ms":1234,"mode":"ai","kb_keys":["studio.about","pricing.principles"],"prompt":"must not be stored"}'::jsonb);
  perform ti.as_super();
  select * into r from intel_chat_messages where thread_id = t and role = 'assistant' and reply_to = m;
  perform ti.ok(r.ai_provider = 'gemini' and r.ai_model = 'gemini-3.8-flash' and r.ai_latency_ms = 1234 and r.ai_mode = 'ai', 'provenance is stored on the assistant row');
  perform ti.ok(r.kb_keys = array['studio.about', 'pricing.principles'], 'knowledge keys are stored');

  -- bad values are dropped, not stored and not an error; the old 4-argument call still works
  perform ti.as_user(ADMIN);
  m := (intel_admin_chat_send(t, 'again', 'prov2') ->> 'message_id')::bigint;
  perform ti.as_user(AGENT);
  perform intel_agent_chat_reply(t, m, 'Answer 2', 'done', '{"provider":"openai","mode":"bogus","latency_ms":"abc","kb_keys":"notalist"}'::jsonb);
  perform ti.as_super();
  select * into r from intel_chat_messages where thread_id = t and role = 'assistant' and reply_to = m;
  perform ti.ok(r.ai_provider is null and r.ai_mode is null and r.ai_latency_ms is null and r.kb_keys is null, 'unknown provider/mode, non-numeric latency and a non-array key list are dropped');
  perform ti.as_user(ADMIN);
  m := (intel_admin_chat_send(t, 'third', 'prov3') ->> 'message_id')::bigint;
  perform ti.as_user(AGENT);
  perform intel_agent_chat_reply(t, m, 'Answer 3', 'done');
  perform ti.as_super();
  perform ti.ok((select count(*) = 1 from intel_chat_messages where thread_id = t and role = 'assistant' and reply_to = m), 'the 4-argument call still works');

  -- one answer per request is unchanged
  perform ti.as_user(AGENT);
  perform intel_agent_chat_reply(t, m, 'Duplicate', 'done', '{"provider":"ollama","mode":"ai"}'::jsonb);
  perform ti.as_super();
  perform ti.ok((select count(*) = 1 and max(content) = 'Answer 3' from intel_chat_messages where thread_id = t and role = 'assistant' and reply_to = m), 'a second reply does not overwrite the first');
end $$;
