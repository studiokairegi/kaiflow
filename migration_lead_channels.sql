-- Run this in the Supabase SQL Editor to add Lead Channel tracking.
-- Safe to run alongside your existing schema; only adds new columns.

-- Which channel a lead came in through (e.g. Referral, Cold Email,
-- Instagram, Website, or any custom channel added from the app).
alter table leads add column if not exists channel text default '';

-- The studio's editable list of channels, shared between the CRM board's
-- filter chips, the lead editor's "+" add-channel control, and the
-- dashboard's "Leads by channel" breakdown.
alter table user_settings
  add column if not exists lead_channels jsonb not null default '["Referral","Cold Email","Instagram","Website"]'::jsonb;

create index if not exists leads_channel_idx on leads(channel);
