-- Agent Chat propose/confirm (20261109160000). Runs after intelligence_v1.test.sql (reuses its fixture, including the pending follow-up draft
-- with idempotency key 'v1-fu-1'). NOT EXECUTED where it was written (no PostgreSQL there): run it before trusting the migration.
set session_replication_role = replica;
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  orgA uuid := '20000000-0000-0000-0000-00000000000a';
  t uuid; m bigint; msg uuid; res jsonb; a1 uuid; a2 uuid; a3 uuid; a4 uuid; a5 uuid; admins_before int;
begin
  perform ti.as_super();
  select id into msg from intel_messages where idempotency_key = 'v1-fu-1';
  perform ti.ok(msg is not null and (select state from intel_messages where id = msg) = 'pending_approval', 'fixture: a draft is waiting for approval');
  select count(*) into admins_before from user_settings where is_admin;

  perform ti.as_user(ADMIN);
  t := intel_admin_chat_new_thread('Actions');
  m := (intel_admin_chat_send(t, 'Approve the follow-up to Due', 'ca1') ->> 'message_id')::bigint;

  -- the agent can only propose --------------------------------------------------------------------------------------------------
  perform ti.as_user(AGENT);
  res := intel_agent_chat_propose(t, m, 'approve_messages', jsonb_build_object('message_ids', jsonb_build_array(msg)));
  perform ti.ok((res ->> 'ok')::boolean and res ->> 'status' = 'pending', 'approval can be proposed');
  perform ti.ok(res ->> 'summary' like '%due@v1due.test%' and res ->> 'summary' like '%Following up%', 'the summary names the recipient and subject, built by the database');
  a1 := (res ->> 'action_id')::uuid;
  perform ti.as_super();
  perform ti.ok((select state from intel_messages where id = msg) = 'pending_approval', 'proposing changed nothing');
  perform ti.as_user(AGENT);
  perform ti.ok((intel_agent_chat_propose(t, m, 'approve_messages', jsonb_build_object('message_ids', jsonb_build_array(msg))) ->> 'action_id')::uuid = a1, 'proposing the same thing twice gives the same card');
  perform ti.throws(format($q$select intel_admin_chat_confirm(%L)$q$, a1), 'restricted', 'the agent cannot confirm');
  perform ti.throws(format($q$select intel_admin_chat_cancel(%L)$q$, a1), 'restricted', 'the agent cannot cancel');
  perform ti.throws(format($q$select _intel_chat_exec(%L, 'enable_sending', '{}')$q$, orgA), 'permission denied', 'the agent cannot call the executor directly');
  perform ti.ok((select count(*) from intel_chat_actions) = 0, 'the agent cannot read actions');
  perform ti.ok(intel_agent_chat_propose(t, m, 'remove_suppression', '{}'::jsonb) ->> 'reason' = 'unknown_tool', 'removing a suppression is not proposable');
  perform ti.ok(intel_agent_chat_propose(t, m, 'grant_admin', '{"user":"x"}'::jsonb) ->> 'reason' = 'unknown_tool', 'changing roles is not proposable');
  perform ti.ok(intel_agent_chat_propose(t, m, 'register_agent', '{}'::jsonb) ->> 'reason' = 'unknown_tool', 'agent registration is not proposable');
  perform ti.ok(intel_agent_chat_tool(t, m, 'approve_messages', '{}'::jsonb) ->> 'reason' = 'unknown_tool', 'a proposal name is refused by the immediate-tool function');
  perform ti.ok(intel_agent_chat_propose(t, m, 'approve_messages', '{"message_ids":["not-a-uuid"]}'::jsonb) ->> 'reason' = 'no_valid_message_ids', 'bad ids are refused');
  perform ti.ok(intel_agent_chat_propose(t, m, 'set_autonomy', '{"autonomy":"yolo"}'::jsonb) ->> 'reason' like 'autonomy_must_be%', 'bad autonomy is refused');

  -- only the signed-in administrator confirms ---------------------------------------------------------------------------------------
  perform ti.as_user(MASTER);
  perform ti.throws(format($q$select intel_admin_chat_confirm(%L)$q$, a1), 'restricted', 'a Master User who is not admin cannot confirm');
  perform ti.ok((select count(*) from intel_chat_actions) = 0, 'and cannot read the cards');
  perform ti.as_user(ADMIN);
  res := intel_admin_chat_confirm(a1);
  perform ti.ok((res ->> 'ok')::boolean and res ->> 'status' = 'confirmed', 'the administrator can confirm');
  perform ti.as_super();
  perform ti.ok((select state from intel_messages where id = msg) = 'approved', 'confirming approved the message through the existing function');
  perform ti.ok((select count(*) from intel_actions where action in ('chat_proposed','chat_action_confirmed')) >= 2, 'both steps are audited');
  perform ti.as_user(ADMIN);
  perform ti.ok(intel_admin_chat_confirm(a1) ->> 'status' = 'confirmed', 'confirming twice does nothing the second time');
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_chat_propose(t, m, 'approve_messages', jsonb_build_object('message_ids', jsonb_build_array(msg))) ->> 'reason' = 'some_messages_not_in_a_valid_state', 'an already-approved message cannot be proposed again');

  -- existing guards still apply at confirmation time ---------------------------------------------------------------------------------
  perform ti.as_super(); update intel_settings set kill_switch = true where organization_id = orgA; perform ti.as_user(AGENT);
  res := intel_agent_chat_propose(t, m, 'enable_sending', '{}'::jsonb); a2 := (res ->> 'action_id')::uuid;
  perform ti.ok((res ->> 'ok')::boolean, 'turning sending on can be proposed');
  perform ti.as_user(ADMIN);
  res := intel_admin_chat_confirm(a2);
  perform ti.ok(res ->> 'status' = 'failed' and res ->> 'error' like '%mailbox%', 'but the existing rule (a connected mailbox is required) still blocks it');
  perform ti.as_super();
  perform ti.ok((select kill_switch from intel_settings where organization_id = orgA), 'sending stayed off');

  -- cancel, expiry, and a requester who loses access ----------------------------------------------------------------------------------------
  perform ti.as_user(AGENT);
  a3 := (intel_agent_chat_propose(t, m, 'add_suppression', '{"value":"BadGuy@Example.test","reason":"asked"}'::jsonb) ->> 'action_id')::uuid;
  perform ti.as_user(ADMIN);
  perform ti.ok(intel_admin_chat_cancel(a3) ->> 'status' = 'cancelled', 'a card can be cancelled');
  perform ti.ok(intel_admin_chat_confirm(a3) ->> 'status' = 'cancelled' and not (intel_admin_chat_confirm(a3) ->> 'ok')::boolean, 'a cancelled card can never run');
  perform ti.as_super();
  perform ti.ok(not exists (select 1 from intel_suppressions where value = 'badguy@example.test'), 'nothing was suppressed');

  perform ti.as_user(AGENT);
  a4 := (intel_agent_chat_propose(t, m, 'update_limits', '{"max_followups":2}'::jsonb) ->> 'action_id')::uuid;
  perform ti.as_super(); update intel_chat_actions set expires_at = now() - interval '1 minute' where id = a4;
  perform ti.as_user(ADMIN);
  perform ti.ok(intel_admin_chat_confirm(a4) ->> 'status' = 'expired', 'an old card expires');

  perform ti.as_user(AGENT);
  a5 := (intel_agent_chat_propose(t, m, 'add_suppression', '{"value":"nope@example.test"}'::jsonb) ->> 'action_id')::uuid;
  perform ti.as_super(); update user_settings set is_admin = false where user_id = ADMIN; perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_chat_propose(t, m, 'set_autonomy', '{"autonomy":"assisted"}'::jsonb) ->> 'reason' = 'requester_not_authorized', 'a requester who is no longer admin cannot get new cards prepared');
  perform ti.as_super(); update user_settings set is_admin = true where user_id = ADMIN;
  perform ti.as_user(ADMIN);
  res := intel_admin_chat_confirm(a5);
  perform ti.ok(res ->> 'status' = 'confirmed', 'a valid card still confirms once access is back');
  perform ti.as_super();
  perform ti.ok(exists (select 1 from intel_suppressions where value = 'nope@example.test' and source = 'admin'), 'the suppression was added through the admin function');

  perform ti.ok((select count(*) from user_settings where is_admin) = admins_before and not (select is_admin from user_settings where user_id = MASTER), 'no admin role changed anywhere');
end $$;
