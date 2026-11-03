-- KairFlow Intelligence core behaviour against real Postgres. Run via run_intelligence_auth.sh (after the authorization tests,
-- which create the fixture users/orgs and the ti.* helpers). Every assertion raises on failure.
-- ADMIN = ...e1 (admin + active Master of orgA), MASTER = ...e2 (Master of orgB, NOT admin), AGENT = ...f0 (separate account).

set session_replication_role = replica;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000f0','agent@t.test') on conflict do nothing;
insert into studio_data_owners(user_id, organization_id) values ('00000000-0000-0000-0000-0000000000e1','20000000-0000-0000-0000-00000000000a') on conflict do nothing;

do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; r jsonb; v_id uuid;
begin
  -- Authorization boundaries ---------------------------------------------------------------------
  perform ti.as_user(MASTER);
  perform ti.throws($q$select intel_admin_bootstrap('A','a@s.test','1 Road','UTC')$q$, 'restricted', 'Master without admin cannot run setup');
  perform ti.throws($q$select intel_admin_overview()$q$, 'restricted', 'Master without admin cannot read the overview');
  perform ti.as_user(ADMIN);
  perform intel_admin_bootstrap('Alex', 'alex@studio.test', '1 Example Road, Nairobi', 'Africa/Nairobi');
  perform ti.ok((select count(*) from intel_campaigns where organization_id = orgA) = 2, 'bootstrap creates the two campaigns');
  perform ti.ok((select kill_switch and autonomy = 'shadow' from intel_settings where organization_id = orgA), 'defaults: sending OFF and shadow mode');
  perform ti.throws($q$select intel_admin_update_settings('{"daily_initial_cap": 31}'::jsonb)$q$, 'check|violat', 'cap above 30 is impossible');
  perform ti.throws($q$select intel_admin_register_agent('00000000-0000-0000-0000-0000000000e3')$q$, 'administrator or a studio member|must not be', 'an admin cannot be registered as the agent');
  perform ti.throws($q$select intel_admin_set_kill_switch(false)$q$, 'Zoho|agent|sender', 'cannot enable sending before setup is complete');
  perform intel_admin_register_agent(AGENT);
  perform ti.throws($q$select intel_agent_settings()$q$, 'Not the Intelligence agent', 'admin cannot call agent functions');
  perform ti.as_user(AGENT);
  perform ti.throws($q$select intel_admin_overview()$q$, 'restricted', 'the agent cannot call admin functions');
  perform ti.ok((select count(*) from intel_prospects) = 0 and (select count(*) from intel_messages) = 0, 'the agent can read no Intelligence tables directly (row level security)');
  perform ti.throws($q$insert into intel_suppressions(organization_id, kind, value) values ('20000000-0000-0000-0000-00000000000a','email','x@y.z')$q$, 'permission denied', 'the agent cannot write any table directly');
  perform ti.ok(intel_is_authorized() is false, 'the agent is never "authorized"');
  perform ti.as_super();
end $$;

-- Pipeline: prospect -> lead (create / link manual / review), attribution immutability ----------------
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0'; orgA uuid := '20000000-0000-0000-0000-00000000000a';
  r jsonb; p1 uuid; p2 uuid; p3 uuid; lead1 uuid; manual uuid;
begin
  insert into leads(user_id, company_name, website, contact_person, email) values (ADMIN, 'Dup Works', 'dupworks.com', 'Kim', 'kim@dupworks.com') returning id into manual;
  insert into leads(user_id, company_name) values (ADMIN, 'Sky Studio');
  perform ti.as_user(AGENT);
  r := intel_agent_upsert_prospect('indie_game_developer', 'Pixel Moon', 'https://www.pixelmoon.com/', 'Rina', 'rina@pixelmoon.com', 'https://pixelmoon.com/contact', 'JP', 'en', '{"recent_activity": true}'::jsonb);
  p1 := (r ->> 'prospect_id')::uuid;
  perform ti.ok((r ->> 'created')::boolean, 'new prospect created');
  perform ti.ok(not ((intel_agent_upsert_prospect('indie_game_developer', 'Pixel Moon', 'pixelmoon.com', '', '', '', '', 'en') ->> 'created')::boolean), 'same site is the same prospect (canonical key)');
  perform intel_agent_add_evidence(p1, 'web', 'https://pixelmoon.com', 'style_2d', 'Hand-drawn 2D adventure', 'h1', true);
  perform ti.ok(not intel_agent_add_evidence(p1, 'web', 'https://pixelmoon.com', 'style_2d', 'Hand-drawn 2D adventure', 'h1', true), 'evidence is idempotent');
  perform intel_agent_set_score(p1, 80, '[]'::jsonb, 'qualified', '');
  r := intel_agent_resolve_lead(p1);
  perform ti.ok(r ->> 'action' = 'created', 'qualified prospect creates a lead'); lead1 := (r ->> 'lead_id')::uuid;
  perform ti.ok(intel_agent_resolve_lead(p1) ->> 'action' = 'already_linked', 'resolving twice never creates a second lead');
  perform ti.as_super();
  perform ti.ok((select source_kind = 'ai_intelligence' and user_id = ADMIN and created_by = AGENT and intel_prospect_id = p1 and stage = 'pool' and channel = 'Cold Email' from leads where id = lead1), 'AI lead: owned by the data owner, attributed to the agent, stage pool');

  perform ti.throws(format($q$insert into leads(user_id, company_name, source_kind) values (%L, 'Fake', 'ai_intelligence')$q$, ADMIN), 'only be set by KairFlow Intelligence', 'a manual insert cannot claim the AI marker');
  update leads set source_kind = 'manual', created_by = null, intel_prospect_id = null, user_id = user_id where id = lead1;
  perform ti.ok((select source_kind = 'ai_intelligence' and created_by = AGENT and intel_prospect_id = p1 from leads where id = lead1), 'editing or reassigning an AI lead cannot remove the marker or creator');
  perform ti.ok((select source_kind = 'manual' from leads where id = manual), 'manual leads stay manual');

  perform ti.as_user(AGENT);
  p2 := (intel_agent_upsert_prospect('indie_game_developer', 'Dup Works Games', 'dupworks.com', '', 'x@dupworks.com', '', '', 'en') ->> 'prospect_id')::uuid;
  perform intel_agent_set_score(p2, 90, '[]'::jsonb, 'qualified', '');
  r := intel_agent_resolve_lead(p2);
  perform ti.ok(r ->> 'action' = 'linked_manual' and (r ->> 'lead_id')::uuid = manual, 'existing manual lead is reused, not duplicated');
  p3 := (intel_agent_upsert_prospect('indie_game_developer', 'Sky Games', 'skygames-new.com', '', 'a@skygames-new.com', '', '', 'en') ->> 'prospect_id')::uuid;
  perform intel_agent_set_score(p3, 90, '[]'::jsonb, 'qualified', '');
  r := intel_agent_resolve_lead(p3);
  perform ti.ok(r ->> 'action' = 'review', 'uncertain duplicate is held for review');
  perform ti.as_super();
  perform ti.ok((select status = 'needs_review' from intel_prospects where id = p3), 'prospect waits for the administrator');
  perform ti.ok((select count(*) from activity_log where event_type = 'intel_needs_review') = 1, 'one notification for the duplicate review');
  perform ti.ok((select count(*) from leads where company_name in ('Sky Games')) = 0, 'no lead was created for the uncertain duplicate');
end $$;

-- Sending gates, caps, idempotency, replies, notifications ---------------------------------------------
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0'; orgA uuid := '20000000-0000-0000-0000-00000000000a';
  p1 uuid; lead1 uuid; d jsonb; mid uuid; r jsonb; body text; foot text := E'\n--\nAlex\n1 Example Road, Nairobi\n\nIf you would rather not hear from us, reply "unsubscribe" and we will not contact you again.\n';
  inbound jsonb; imid uuid;
begin
  select id, lead_id into p1, lead1 from intel_prospects where name = 'Pixel Moon';
  insert into intel_mail_account(organization_id, status, mailbox) values (orgA, 'connected', 'alex@studio.test') on conflict (organization_id) do update set status = 'connected';
  perform ti.as_user(ADMIN);
  perform ti.ok((intel_admin_set_kill_switch(false) ->> 'kill_switch')::boolean is false, 'sending can be enabled once identity, Zoho and agent are set');
  perform intel_admin_update_campaign('indie_game_developer', '{"status":"active"}'::jsonb);
  perform intel_admin_update_settings('{"daily_initial_cap": 1}'::jsonb);

  perform ti.as_user(AGENT);
  d := intel_agent_upsert_draft(p1, 'initial', 0, 'Hello Pixel Moon', 'Hello Rina, intro.' || foot, 'draft:p1:initial', 'rina@pixelmoon.com');
  mid := (d ->> 'message_id')::uuid;
  perform ti.ok(d ->> 'state' = 'pending_approval', 'shadow mode: introduction waits for approval');
  perform ti.ok(intel_agent_upsert_draft(p1, 'initial', 0, 'x', 'y' || foot, 'draft:p1:initial', 'rina@pixelmoon.com') ->> 'created' = 'false', 'same idempotency key returns the same draft');
  perform ti.ok(intel_agent_upsert_draft(p1, 'initial', 0, 'x', 'y' || foot, 'another-key', 'rina@pixelmoon.com') ->> 'reason' = 'already_introduced', 'a second live introduction to the same prospect is refused');
  perform ti.ok(intel_agent_upsert_draft(p1, 'initial', 0, 'x', 'y', 'k3', 'someone-else@evil.test') ->> 'reason' = 'recipient_not_allowed', 'the agent cannot address an arbitrary recipient');
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'reason' = 'not_approved', 'unapproved message cannot be reserved');

  perform ti.as_user(ADMIN);
  perform intel_admin_review_message(mid, 'edit', 'Hello Pixel Moon', 'Hello Rina, intro without footer');
  perform intel_admin_review_message(mid, 'approve');
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'reason' = 'missing_compliance_footer', 'sending is refused without the opt-out line and postal address');
  perform ti.as_user(ADMIN);
  perform intel_admin_review_message(mid, 'edit', 'Hello Pixel Moon', 'Hello Rina, intro.' || foot); perform intel_admin_review_message(mid, 'approve');
  perform intel_admin_set_kill_switch(true);
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'reason' = 'kill_switch', 'emergency stop blocks sending inside the database');
  perform ti.as_user(ADMIN); perform intel_admin_set_kill_switch(false);
  perform ti.as_user(AGENT);
  r := intel_agent_reserve_send(mid);
  perform ti.ok((r ->> 'ok')::boolean and (r -> 'message' ->> 'token') like 'kf%', 'approved, compliant message is reserved with a token');
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'resumed' = 'true', 'a crash after reserve resumes the same reservation');
  perform ti.ok(intel_agent_mark_sending(mid), 'marked sending');
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'reason' = 'needs_reconcile', 'a message in flight is never reserved again');
  perform intel_agent_confirm_send(mid, 'z-1', '<m1@zoho>', 't1');
  perform ti.ok(intel_agent_confirm_send(mid, 'z-1', '<m1@zoho>', 't1') ->> 'idempotent' = 'true', 'confirm is idempotent');
  perform ti.ok(intel_agent_reserve_send(mid) ->> 'reason' = 'already_sent', 'a sent message cannot be sent again');
  perform ti.as_super();
  perform ti.ok((select stage = 'cold_email' and (emails -> 0 ->> 'sent')::boolean and last_contacted_at is not null from leads where id = lead1), 'lead moved to cold_email with the first email marked sent (existing CRM conventions)');
  perform ti.ok((select status = 'contacted' from intel_prospects where id = p1), 'prospect is contacted');

  -- daily cap of 1 and warm-up --------------------------------------------------------------------
  perform ti.as_user(AGENT);
  d := intel_agent_upsert_prospect('indie_game_developer', 'Second Game', 'second.com', '', 's@second.com', '', '', 'en');
  perform intel_agent_set_score((d ->> 'prospect_id')::uuid, 90, '[]'::jsonb, 'qualified', ''); perform intel_agent_resolve_lead((d ->> 'prospect_id')::uuid);
  d := intel_agent_upsert_draft((d ->> 'prospect_id')::uuid, 'initial', 0, 'Hi', 'Hi.' || foot, 'draft:second', 's@second.com');
  perform ti.as_user(ADMIN); perform intel_admin_review_message((d ->> 'message_id')::uuid, 'approve');
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_reserve_send((d ->> 'message_id')::uuid) ->> 'reason' = 'daily_cap', 'the daily introduction limit is enforced atomically');

  -- inbound reply: matched, de-duplicated, classified, suppressed, notified once ---------------------------
  inbound := intel_agent_record_inbound('z-in-1', '<r1@x>', '<m1@zoho>', '<m1@zoho>', 'Rina@PixelMoon.com', 'Re: Hello Pixel Moon', 'Please unsubscribe me', now(), 't1', null);
  imid := (inbound ->> 'message_id')::uuid;
  perform ti.ok((inbound ->> 'matched')::boolean and not (inbound ->> 'duplicate')::boolean, 'reply matched to the prospect by threading headers');
  perform ti.ok((intel_agent_record_inbound('z-in-1', '<r1@x>', '<m1@zoho>', '<m1@zoho>', 'rina@pixelmoon.com', 'again', 'again', now(), 't1', null) ->> 'duplicate')::boolean, 'syncing the same email again is a no-op');
  perform intel_agent_classify_inbound(imid, 'unsubscribe', 1, false, 'Asked not to be contacted');
  perform intel_agent_classify_inbound(imid, 'unsubscribe', 1, false, 'Asked not to be contacted');
  perform ti.as_super();
  perform ti.ok((select count(*) from activity_log where event_type = 'intel_unsubscribe') = 1, 'one notification however many times the reply is processed');
  perform ti.ok((select (meta ->> 'leadId')::uuid = lead1 and meta ? 'conversationId' and user_id = ADMIN from activity_log where event_type = 'intel_unsubscribe'), 'notification links to the lead and conversation and goes to the data owner');
  perform ti.ok(exists (select 1 from intel_suppressions where value = 'rina@pixelmoon.com'), 'unsubscribe adds the sender to the suppression list');
  perform ti.ok((select status = 'closed' from intel_prospects where id = p1), 'no further outreach to that prospect');
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_upsert_draft(p1, 'followup', 1, 'Re', 'x' || foot, 'fu1', 'rina@pixelmoon.com') ->> 'reason' = 'prospect_not_contactable', 'no follow-up after an opt-out');

  -- audit trail is append-only -----------------------------------------------------------------------
  perform ti.as_super();
  perform ti.throws($q$update intel_actions set action = 'x'$q$, 'append-only', 'the activity log cannot be edited');
  perform ti.throws($q$delete from intel_actions$q$, 'append-only', 'the activity log cannot be deleted');
end $$;

-- Jobs: lease, expiry, idempotent enqueue ---------------------------------------------------------------
do $$
declare AGENT uuid := '00000000-0000-0000-0000-0000000000f0'; j jsonb; j2 jsonb;
begin
  perform ti.as_user(AGENT);
  perform ti.ok(intel_agent_enqueue_job('sync_mail', '{}'::jsonb, 'sync:1') is not null and intel_agent_enqueue_job('sync_mail', '{}'::jsonb, 'sync:1') is null, 'enqueue is idempotent');
  perform ti.throws($q$select intel_agent_enqueue_job('drop_tables', '{}'::jsonb, 'x')$q$, 'check|violat', 'only allowlisted job kinds exist');
  j := intel_agent_claim_job('w1', null, 60);
  perform ti.ok(j ->> 'state' = 'running' and (j ->> 'attempts')::int = 1, 'claim leases the job');
  perform ti.as_super(); update intel_jobs set lease_until = now() - interval '1 minute' where id = (j ->> 'id')::uuid;
  perform ti.as_user(AGENT);
  j2 := intel_agent_claim_job('w2', null, 60);
  perform ti.ok(j2 ->> 'id' = j ->> 'id' and (j2 ->> 'attempts')::int = 2 and j2 ->> 'locked_by' = 'w2', 'an expired lease returns the job to the queue after a crash');
  perform ti.ok(not intel_agent_complete_job((j ->> 'id')::uuid, 'w1', '{}'::jsonb), 'a worker that lost its lease cannot complete the job');
  perform ti.ok(intel_agent_complete_job((j2 ->> 'id')::uuid, 'w2', '{}'::jsonb), 'the current owner completes it');
  perform ti.as_super();
end $$;
