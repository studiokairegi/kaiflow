-- Gmail provider migration (20261109150000). Runs after intelligence_v1.test.sql. NOT EXECUTED where it was written (no PostgreSQL there).
set session_replication_role = replica;
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; orgA uuid := '20000000-0000-0000-0000-00000000000a';
  r jsonb; v_def text;
begin
  perform ti.as_super();
  delete from intel_mail_account where organization_id = orgA;
  insert into intel_mail_account(organization_id, provider, data_center, account_id, mailbox, scope, refresh_token_enc, status)
  values (orgA, 'gmail', 'google', 'me', 'studio@gmail.com', 'send readonly', 'enc', 'connected');
  perform ti.ok((select provider from intel_mail_account where organization_id = orgA) = 'gmail', 'a Gmail mailbox can be stored');
  perform ti.throws($q$update intel_mail_account set provider = 'outlook' where organization_id = '20000000-0000-0000-0000-00000000000a'$q$, 'provider_check', 'no other provider value is accepted');
  insert into intel_oauth_states(organization_id, user_id, data_center, provider) values (orgA, ADMIN, 'google', 'gmail');
  perform ti.throws($q$insert into intel_oauth_states(organization_id, user_id, data_center, provider) values ('20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'mars', 'gmail')$q$, 'data_center_check', 'unknown data centres are refused');
  insert into intel_oauth_states(organization_id, user_id, data_center) values (orgA, ADMIN, 'com') returning provider into v_def;
  perform ti.ok(v_def = 'zoho', 'states default to zoho for older callers');

  perform ti.as_user(ADMIN);
  r := intel_admin_mail_status();
  perform ti.ok(r ->> 'provider' = 'gmail' and r ->> 'status' = 'connected' and r ->> 'mailbox' = 'studio@gmail.com', 'mail status reports the provider');
  perform ti.ok(not (r ? 'refresh_token_enc'), 'and never the token');
  perform ti.as_user(MASTER);
  perform ti.throws($q$select intel_admin_mail_status()$q$, 'restricted', 'Master without admin cannot read mail status');
  perform ti.as_super();
  update intel_mail_account set status = 'disconnected' where organization_id = orgA;
  perform ti.as_user(ADMIN);
  perform ti.throws($q$select intel_admin_set_kill_switch(false)$q$, 'Gmail or Zoho Mail', 'sending cannot be enabled without a connected mailbox');
  perform ti.as_super();
  delete from intel_mail_account where organization_id = orgA;
  delete from intel_oauth_states where organization_id = orgA;
end $$;
