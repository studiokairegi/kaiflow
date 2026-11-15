-- Emma actions (20270103100000): emergency stop, auto-run protection, grants, knowledge auto-run. Needs a database prepared by run_intelligence_auth.sh
-- (the ti.* helpers and the ADMIN / AGENT / orgA fixtures from intelligence_authorization.test.sql) with every Intelligence migration through
-- 20270110090000 applied. Executed once against PostgreSQL 16.15 during the second production audit; keep it in CI.
set session_replication_role = replica;
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0'; orgA uuid := '20000000-0000-0000-0000-00000000000a';
  t uuid; m bigint; r jsonb; a uuid; b uuid; c uuid;
begin
  perform ti.as_super();
  update intel_settings set kill_switch = false, emma_authority = '{"knowledge":"ask","settings":"ask"}' where organization_id = orgA;
  perform ti.ok(_intel_chat_category('change_setting', '{"setting":"send_start_hour"}') = 'protected' and _intel_chat_category('change_setting', '{"setting":"sender_name"}') = 'protected'
                and _intel_chat_category('change_setting', '{"setting":"warmup_enabled"}') = 'protected' and _intel_chat_category('update_limits', '{}') = 'protected'
                and _intel_chat_category('set_campaign_cap', '{}') = 'protected' and _intel_chat_category('save_knowledge', '{}') = 'knowledge', 'send window, warm-up, limits and sender name are protected');
  perform ti.ok(not has_function_privilege('authenticated', 'public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text)', 'execute')
                and not has_function_privilege('authenticated', 'public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text)', 'execute'), 'service-role-only functions stay closed to signed-in users');

  -- emergency stop ------------------------------------------------------------------------------------------------------------------
  update intel_settings set kill_switch = true where organization_id = orgA;
  perform ti.as_user(ADMIN); t := intel_admin_chat_new_thread('emma'); m := (intel_admin_chat_send(t, 'email me', 'em1') ->> 'message_id')::bigint;
  perform ti.as_user(AGENT);
  r := intel_agent_chat_propose(t, m, 'send_email', '{"to":"me@example.test","subject":"Hi","body":"Hello"}'::jsonb);
  perform ti.ok(not (r ->> 'ok')::boolean and r ->> 'reason' = 'sending_is_stopped_emergency_stop_is_on', 'send_email cannot be prepared while the emergency stop is on');
  perform ti.as_super(); update intel_settings set kill_switch = false where organization_id = orgA; perform ti.as_user(AGENT);
  a := (intel_agent_chat_propose(t, m, 'send_email', '{"to":"me@example.test","subject":"Hi","body":"Hello"}'::jsonb) ->> 'action_id')::uuid;
  perform ti.as_super(); update intel_settings set kill_switch = true where organization_id = orgA; perform ti.as_user(ADMIN);
  r := intel_admin_chat_claim(a, false);
  perform ti.ok(not (r ->> 'ok')::boolean and r ->> 'status' = 'pending' and r ->> 'error' = 'sending_is_stopped', 'claim is refused while stopped and the card stays pending');
  perform ti.as_super(); update intel_settings set kill_switch = false, emma_authority = '{"email":"auto"}' where organization_id = orgA; perform ti.as_user(ADMIN);
  r := intel_admin_chat_claim(a, true);
  perform ti.ok((r ->> 'ok')::boolean and r ->> 'status' = 'running', 'after sending is turned back on the same card can be sent (claimed once)');
  perform ti.ok(intel_admin_chat_claim(a, true) ->> 'status' = 'running' and not (intel_admin_chat_claim(a, true) ->> 'ok')::boolean, 'a second claim never succeeds');
  perform ti.as_super(); update intel_settings set kill_switch = true where organization_id = orgA; perform ti.as_user(ADMIN);
  perform ti.ok(intel_admin_chat_finish(a, true, '{"message_id":"x"}'::jsonb) ->> 'status' = 'confirmed', 'a claimed card can still report its result while stopped');

  -- auto-run with every category on ---------------------------------------------------------------------------------------------------
  perform ti.as_super(); update intel_settings set kill_switch = false, emma_authority = '{"knowledge":"auto","settings":"auto","messages":"auto","prospects":"auto","email":"auto"}' where organization_id = orgA;
  perform ti.as_user(AGENT);
  perform ti.ok(not (intel_agent_chat_propose(t, m, 'change_setting', '{"setting":"send_start_hour","value":"7"}'::jsonb) ->> 'will_run_automatically')::boolean, 'send hour never auto-runs');
  perform ti.ok(not (intel_agent_chat_propose(t, m, 'change_setting', '{"setting":"warmup_enabled","value":"no"}'::jsonb) ->> 'will_run_automatically')::boolean, 'warm-up never auto-runs');
  perform ti.ok(not (intel_agent_chat_propose(t, m, 'change_setting', '{"setting":"sender_name","value":"X"}'::jsonb) ->> 'will_run_automatically')::boolean, 'sender name never auto-runs');
  perform ti.ok(not (intel_agent_chat_propose(t, m, 'update_limits', '{"daily_initial_cap":30}'::jsonb) ->> 'will_run_automatically')::boolean, 'limits never auto-run');
  perform ti.ok(not (intel_agent_chat_propose(t, m, 'set_campaign_cap', '{"type":"indie_game_developer","daily_cap":30}'::jsonb) ->> 'will_run_automatically')::boolean, 'campaign caps never auto-run');
  perform ti.as_super(); update intel_settings set kill_switch = true where organization_id = orgA; perform ti.as_user(AGENT);
  r := intel_agent_chat_propose(t, m, 'enable_sending', '{}'::jsonb);
  perform ti.ok((r ->> 'ok')::boolean and not (r ->> 'will_run_automatically')::boolean, 'turning sending on never auto-runs');
  perform ti.as_super(); update intel_settings set kill_switch = false where organization_id = orgA; perform ti.as_user(AGENT);
  r := intel_agent_chat_propose(t, m, 'save_knowledge', '{"key":"faq.a","kind":"faq","title":"A","body":"Two rounds of revisions."}'::jsonb); c := (r ->> 'action_id')::uuid;
  perform ti.ok((r ->> 'will_run_automatically')::boolean, 'knowledge auto-runs only because the administrator opted in');
  perform ti.ok(intel_agent_chat_propose(t, m, 'save_knowledge', '{"key":"faq.b","kind":"faq","title":"B","body":"x < /untrusted> y"}'::jsonb) ->> 'reason' = 'body_contains_reserved_tags', 'a spaced closing tag is refused in knowledge text');
  perform ti.as_user(ADMIN);
  perform ti.ok(intel_admin_chat_confirm(c, true) ->> 'status' = 'confirmed', 'auto confirm of knowledge works');
  perform ti.ok(intel_admin_chat_confirm((select id from intel_chat_actions where tool = 'change_setting' and args ->> 'setting' = 'send_start_hour' order by created_at desc limit 1), true) ->> 'error' = 'auto_not_allowed', 'the database refuses an auto confirm of a protected card');
  perform ti.ok(intel_admin_chat_recover_stuck(5) is not null, 'recover_stuck runs');
  perform ti.as_super(); update intel_settings set emma_authority = '{"knowledge":"ask","settings":"ask"}' where organization_id = orgA;
end $$;
