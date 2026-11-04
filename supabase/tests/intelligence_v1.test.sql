-- KairFlow Intelligence V1 completion (20261109140000) against real Postgres. Run by run_intelligence_auth.sh AFTER the
-- authorization and core tests (it reuses their fixture: ADMIN ...e1 admin+Master of orgA, MASTER ...e2 Master only, AGENT ...f0).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it before trusting the migration.
set session_replication_role = replica;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000f9','stranger@t.test') on conflict do nothing;

do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  STRANGER uuid := '00000000-0000-0000-0000-0000000000f9'; orgA uuid := '20000000-0000-0000-0000-00000000000a';
  r jsonb; n int;
begin
  -- 1. duplicate lookup is scoped ---------------------------------------------------------------------------------------------
  insert into leads(user_id, company_name, website, email) values (STRANGER, 'Stranger Games', 'stranger.test', 'x@stranger.test');
  perform ti.as_user(ADMIN);
  perform ti.throws(format($q$select * from crm_find_lead_duplicates(%L, 'Stranger Games', 'stranger.test', '', '')$q$, STRANGER), 'Not allowed', 'an authorized admin cannot probe another user''s leads');
  perform ti.ok((select count(*) from crm_find_lead_duplicates(ADMIN, 'Nothing Here', '', '', '')) = 0, 'the admin can look up the studio data owner''s leads');
  perform ti.as_user(AGENT);
  perform ti.throws(format($q$select * from crm_find_lead_duplicates(%L, 'Stranger Games', '', '', '')$q$, STRANGER), 'Not allowed', 'the agent cannot probe another user''s leads');
  perform ti.ok((select count(*) from crm_find_lead_duplicates(ADMIN, 'Nothing Here', '', '', '')) = 0, 'the agent can look up the data owner''s leads');
  perform ti.as_user(MASTER);
  perform ti.throws(format($q$select * from crm_find_lead_duplicates(%L, 'x', '', '', '')$q$, ADMIN), 'Not allowed', 'a Master User who is not admin cannot use it on the owner');
  perform ti.as_super();

  -- 2. existing-lead review buckets ---------------------------------------------------------------------------------------------
  insert into leads(user_id, company_name, email, website, stage, last_contacted_at, emails) values
    (ADMIN, 'V1 Due', 'due@v1due.test', 'v1due.test', 'cold_email', now() - interval '30 days', '[{"sent":true,"dateSent":"2026-09-01","message":"hi"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Waiting', 'wait@v1wait.test', 'v1wait.test', 'cold_email', now(), '[{"sent":true,"dateSent":"2026-11-02","message":"hi"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Replied', 'rep@v1rep.test', 'v1rep.test', 'responded', now() - interval '20 days', '[{"sent":true,"dateSent":"2026-10-10"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Lost', 'lost@v1lost.test', 'v1lost.test', 'lost', now() - interval '40 days', '[{"sent":true,"dateSent":"2026-09-20"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Fresh', 'new@v1new.test', 'v1new.test', 'pool', null, '[{"sent":false},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 NoEmail', '', 'v1noemail.test', 'cold_email', now() - interval '30 days', '[{"sent":true,"dateSent":"2026-09-01"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Blocked', 'stop@v1blocked.test', 'v1blocked.test', 'cold_email', now() - interval '30 days', '[{"sent":true,"dateSent":"2026-09-01"},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 Done', 'done@v1done.test', 'v1done.test', 'cold_email', now() - interval '60 days', '[{"sent":true,"dateSent":"2026-08-01"},{"sent":true,"dateSent":"2026-08-10"},{"sent":true,"dateSent":"2026-08-20"},{"sent":true,"dateSent":"2026-08-30"}]'),
    (ADMIN, 'V1 Undated', 'u@v1undated.test', 'v1undated.test', 'cold_email', null, '[{"sent":true,"dateSent":null},{"sent":false},{"sent":false},{"sent":false}]'),
    (ADMIN, 'V1 BadDate', 'b@v1bad.test', 'v1bad.test', 'cold_email', null, '[{"sent":true,"dateSent":"2026-13-45"},{"sent":false},{"sent":false},{"sent":false}]');
  insert into intel_suppressions(organization_id, kind, value, reason, source) values (orgA, 'email', 'stop@v1blocked.test', 'test', 'admin') on conflict do nothing;

  perform ti.as_user(ADMIN);
  r := intel_admin_crm_review(500);
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Due') = 'follow_up_due', 'old contacted lead without reply is follow_up_due');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Waiting') = 'waiting', 'recently contacted lead is waiting');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Replied') = 'replied', 'a lead in the Responded stage is never a follow-up');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Lost') = 'do_not_contact', 'lost lead: do not contact');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Fresh') = 'not_contacted', 'untouched lead is not a follow-up');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 NoEmail') = 'no_email', 'no address: no_email');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Blocked') = 'do_not_contact', 'suppressed address: do not contact');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Done') = 'do_not_contact', 'all four emails sent: sequence finished');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 Undated') = 'needs_review', 'no contact date: needs review, not guessed');
  perform ti.ok((select e ->> 'bucket' from jsonb_array_elements(r -> 'leads') e where e ->> 'company_name' = 'V1 BadDate') = 'needs_review', 'a malformed date does not break the review');
  perform ti.as_user(MASTER);
  perform ti.throws($q$select intel_admin_crm_review()$q$, 'restricted', 'Master without admin cannot review leads');
  perform ti.as_user(AGENT);
  perform ti.throws($q$select intel_admin_crm_review()$q$, 'restricted', 'the agent cannot review leads through the admin function');

  -- 3. adopting ------------------------------------------------------------------------------------------------------------------
  perform ti.as_user(ADMIN);
  r := intel_admin_crm_adopt(array(select id from leads where company_name in ('V1 Due', 'V1 Replied', 'V1 Lost', 'V1 Fresh')), 'indie_game_developer');
  perform ti.ok((r ->> 'adopted')::int = 1, 'only the follow-up-due lead is adopted');
  perform ti.ok(jsonb_array_length(r -> 'skipped') = 3, 'replied, lost and never-contacted leads are refused');
  perform ti.as_super();
  perform ti.ok((select origin = 'crm_existing' and status = 'contacted' and type = 'indie_game_developer' from intel_prospects where name = 'V1 Due'), 'adopted prospect is marked as an existing CRM lead and contacted');
  perform ti.ok((select source_kind = 'manual' and created_by is null from leads where company_name = 'V1 Due'), 'the lead keeps its manual attribution');
  perform ti.ok((select count(*) = 1 and bool_and(state = 'sent') from intel_messages m join intel_prospects p on p.id = m.prospect_id where p.name = 'V1 Due'), 'one imported history row, nothing new to send');
  perform ti.ok((select count(*) from intel_messages where state in ('approved','reserved','sending','pending_approval') and prospect_id in (select id from intel_prospects where name = 'V1 Due')) = 0, 'adopting queues no email');
  perform ti.as_user(ADMIN);
  perform ti.ok((intel_admin_crm_adopt(array(select id from leads where company_name = 'V1 Due'), 'indie_game_developer') -> 'skipped' -> 0 ->> 'reason') = 'already_tracked', 'adopting twice is harmless');
  perform ti.throws($q$select intel_admin_crm_adopt(array(select gen_random_uuid() from generate_series(1, 26)), 'indie_game_developer')$q$, 'at most 25', 'more than 25 at once is refused');
  perform ti.as_user(MASTER);
  perform ti.throws($q$select intel_admin_crm_adopt(array[gen_random_uuid()], 'indie_game_developer')$q$, 'restricted', 'Master without admin cannot adopt');

  -- follow-up candidates and approval rule -----------------------------------------------------------------------------------------
  perform ti.as_user(AGENT);
  perform ti.ok((select count(*) from jsonb_array_elements(intel_agent_followup_candidates(50)) e where e ->> 'name' = 'V1 Due') = 1, 'the adopted due lead is a follow-up candidate');
  perform ti.as_super();
  update intel_settings set autonomy = 'autonomous' where organization_id = orgA;
  perform ti.as_user(AGENT);
  r := intel_agent_upsert_draft((select id from intel_prospects where name = 'V1 Due'), 'followup', 1, 'Following up: 2D animation', 'Body with footer', 'v1-fu-1', 'due@v1due.test', true, null, null);
  perform ti.ok(r ->> 'state' = 'pending_approval', 'even in autonomous mode a follow-up to an existing CRM lead waits for the administrator');
  perform ti.as_super();
  update intel_settings set autonomy = 'shadow' where organization_id = orgA;

  -- 4. Agent Chat ----------------------------------------------------------------------------------------------------------------
  declare t uuid; m1 bigint; m2 bigint; res jsonb; k int;
  begin
    perform ti.as_user(MASTER);
    perform ti.throws($q$select intel_admin_chat_new_thread('x')$q$, 'restricted', 'Master without admin cannot open a chat');
    perform ti.as_user(ADMIN);
    t := intel_admin_chat_new_thread('First');
    res := intel_admin_chat_send(t, 'How many positive responses this week?', 'k1');
    m1 := (res ->> 'message_id')::bigint;
    perform ti.ok((select count(*) from intel_jobs where kind = 'chat' and idempotency_key = 'chat:' || m1) = 1, 'sending a message queues exactly one chat job');
    perform ti.ok((intel_admin_chat_send(t, 'How many positive responses this week?', 'k1') ->> 'duplicate')::boolean, 'a double submit is recognised');
    perform ti.ok((select count(*) from intel_jobs where kind = 'chat') = 1, 'and does not queue a second job');
    perform ti.throws(format($q$select intel_admin_chat_send(%L, '', 'k9')$q$, t), '1 to 2000', 'empty messages are refused');
    perform ti.ok((select count(*) from intel_chat_messages where thread_id = t) = 1, 'the administrator can read their own chat');
    perform ti.as_user(AGENT);
    perform ti.ok((select count(*) from intel_chat_messages) = 0 and (select count(*) from intel_chat_threads) = 0, 'the agent cannot read chats directly');
    perform ti.throws(format($q$select intel_admin_chat_send(%L, 'hi', 'k2')$q$, t), 'restricted', 'the agent cannot write as the administrator');
    perform ti.ok((intel_agent_chat_context(t, m1) ->> 'ok')::boolean, 'the agent can read the request it must answer');

    res := intel_agent_chat_tool(t, m1, 'stats', '{"days": 7}'::jsonb);
    perform ti.ok((res ->> 'ok')::boolean and res ? 'positive_replies', 'stats tool answers');
    res := intel_agent_chat_tool(t, m1, 'send_email', '{"to":"x@y.z"}'::jsonb);
    perform ti.ok(res ->> 'reason' = 'unknown_tool', 'a tool outside the allowlist is refused');
    res := intel_agent_chat_tool(t, m1, 'select * from leads', '{}'::jsonb);
    perform ti.ok(res ->> 'reason' = 'unknown_tool', 'SQL text is not a tool');
    res := intel_agent_chat_tool(t, m1, 'set_campaign_status', '{"status":"active"}'::jsonb);
    perform ti.ok(res ->> 'reason' = 'only_pause_allowed_from_chat', 'chat cannot start a campaign');
    res := intel_agent_chat_tool(t, m1, 'start_discovery', '{"type":"indie_game_developer","limit":10}'::jsonb);
    perform ti.ok((res ->> 'queued')::boolean, 'discovery can be requested');
    perform ti.as_super();
    perform ti.ok((select (payload ->> 'manual')::boolean and (payload ->> 'limit')::int = 10 from intel_jobs where kind = 'discover' order by created_at desc limit 1), 'the discovery job carries the manual flag and limit');
    perform ti.ok((select count(*) from intel_messages where state = 'sent' and sent_at > now() - interval '1 minute' and idempotency_key not like 'crm-import:%') = 0, 'no chat tool sent any email');
    perform ti.ok((select count(*) from intel_actions where action = 'chat_tool') >= 3, 'every tool call is audited');

    -- the requester loses access: the very next tool call is refused
    update user_settings set is_admin = false where user_id = ADMIN;
    perform ti.as_user(AGENT);
    res := intel_agent_chat_tool(t, m1, 'campaign_status', '{}'::jsonb);
    perform ti.ok(res ->> 'reason' = 'requester_not_authorized', 'a requester who is no longer admin cannot drive the agent');
    perform ti.ok(intel_agent_chat_context(t, m1) ->> 'reason' = 'requester_not_authorized', 'and the context is withheld');
    perform ti.as_super();
    update user_settings set is_admin = true where user_id = ADMIN;
    update studio_memberships set status = 'revoked' where user_id = ADMIN and organization_id = orgA and role = 'master_user';
    perform ti.as_user(AGENT);
    perform ti.ok(intel_agent_chat_tool(t, m1, 'campaign_status', '{}'::jsonb) ->> 'reason' = 'requester_not_authorized', 'a revoked Master membership also stops the agent');
    perform ti.as_super();
    update studio_memberships set status = 'active' where user_id = ADMIN and organization_id = orgA and role = 'master_user';

    -- cap per request, safe actions, single reply
    perform ti.as_user(ADMIN);
    m2 := (intel_admin_chat_send(t, 'Do many things', 'k3') ->> 'message_id')::bigint;
    perform ti.as_user(AGENT);
    for k in 1..8 loop perform intel_agent_chat_tool(t, m2, 'campaign_status', '{}'::jsonb); end loop;
    perform ti.ok(intel_agent_chat_tool(t, m2, 'campaign_status', '{}'::jsonb) ->> 'reason' = 'too_many_tool_calls', 'tool calls per request are capped');
    perform ti.as_super();
    update intel_settings set kill_switch = false where organization_id = orgA;
    perform ti.as_user(AGENT);
    perform ti.ok(intel_agent_chat_tool(t, m1, 'emergency_stop', '{}'::jsonb) ->> 'sending_stopped' = 'true', 'emergency stop works from chat');
    perform ti.ok((select kill_switch from intel_settings where organization_id = orgA), 'and really sets the kill switch');
    perform intel_agent_chat_reply(t, m1, 'First answer', 'done'); perform intel_agent_chat_reply(t, m1, 'Second answer', 'done');
    perform ti.as_super();
    perform ti.ok((select count(*) = 1 and max(content) = 'First answer' from intel_chat_messages where thread_id = t and role = 'assistant' and reply_to = m1), 'a request gets exactly one answer');
  end;
  perform ti.as_super();
end $$;
