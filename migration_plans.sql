-- Run this in the Supabase SQL Editor to add plan-based feature gating.
-- Safe to run alongside your existing schema.

alter table user_settings add column if not exists plan text not null default 'free';
alter table user_settings add column if not exists is_admin boolean not null default false;

-- Whitelist your own account for full access regardless of plan.
-- Replace the email below with the address you actually log into KaiFlow with,
-- then run this statement on its own.
update user_settings
set is_admin = true
where user_id = (select id from auth.users where email = 'studiokairegi@gmail.com');
