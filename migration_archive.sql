-- Run this in the Supabase SQL Editor to add project archiving.
-- Safe to run alongside your existing schema.

alter table projects add column if not exists archived boolean not null default false;
