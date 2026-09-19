-- Run this in the Supabase SQL Editor to add the client/studio billing
-- details needed on proforma, invoice, and receipt documents (legal name,
-- address, tax ID/VAT). Safe to run alongside your existing schema.

-- Client billing details, captured once on the lead and carried over to
-- the project when a lead is marked Won (see handleMarkWon in App.jsx),
-- so they don't have to be retyped for every invoice.
alter table leads add column if not exists billing_address text default '';
alter table leads add column if not exists tax_id text default '';

alter table projects add column if not exists client_address text default '';
alter table projects add column if not exists client_tax_id text default '';

-- Studio's own registered/tax details for the invoice header. studio_name
-- (added in migration_settings_dashboard.sql) is the studio's brand name;
-- studio_legal_name is separate because a sole proprietor's registered
-- legal name for invoicing purposes can differ from that brand name.
alter table user_settings add column if not exists studio_legal_name text default '';
alter table user_settings add column if not exists studio_address text default '';
alter table user_settings add column if not exists studio_tax_id text default '';
alter table user_settings add column if not exists studio_vat_status text default '';
alter table user_settings add column if not exists studio_etims_number text default '';
