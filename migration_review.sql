-- Run this in the Supabase SQL Editor to add client review tracking to shots.
-- Safe to run alongside your existing schema.

alter table shots add column if not exists review_status text not null default 'waiting';
alter table shots add column if not exists revisions jsonb not null default '[]'::jsonb;
alter table shots add column if not exists revision_version integer not null default 1;
