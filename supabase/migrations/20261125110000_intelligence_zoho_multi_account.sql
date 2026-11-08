-- Phase 2.7: promote Zoho to the account-scoped OAuth adapter.
-- Existing legacy intel_mail_account rows are preserved; Phase 2.1 already copied
-- their encrypted credentials into intel_provider_accounts.
begin;
update public.intel_email_provider_registry
   set adapter_key='zoho', display_name='Zoho Mail', adapter_version='2.0.0',
       manifest='{"capabilities":["send","receive","threading","sent-reconciliation","connection-test"],"auth_methods":["oauth2"],"supports_multiple_accounts":true,"account_selection_required":true,"message_purposes":["business_correspondence"],"data_centers":["com","eu","in","com.au","jp","ca","sa","com.cn"]}'::jsonb,
       enabled=true, sending_enabled=false, updated_at=now()
 where provider_key='zoho';
update public.intel_provider_accounts
   set data_center=coalesce(nullif(data_center,''),'com'),
       scopes=coalesce(nullif(scopes,''),'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE'),
       updated_at=now()
 where provider_key='zoho';
commit;
