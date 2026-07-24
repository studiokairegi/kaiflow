-- Run this in the Supabase SQL Editor to add first-time tutorial tracking.
-- Safe to run alongside your existing schema.

alter table user_settings add column if not exists has_seen_tutorial boolean not null default false;
