-- Where the conversation with a lead is happening (Email, X, Discord, ...). Additive; existing leads default to Email.
alter table public.leads add column if not exists contacted_via text not null default 'Email';
