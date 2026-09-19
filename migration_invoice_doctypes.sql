-- Run this in the Supabase SQL Editor to add Proforma/Invoice/Receipt
-- document types, per-line items, and document-series linking to invoices.
-- Safe to run alongside your existing schema; all existing rows default
-- to doc_type 'invoice' and amount_mode 'manual', so nothing already
-- saved changes behavior.

alter table invoices add column if not exists doc_type text not null default 'invoice';
alter table invoices add column if not exists line_items jsonb not null default '[]';
alter table invoices add column if not exists amount_mode text not null default 'manual';

-- Links a receipt/invoice back to the proforma (or receipt) it was
-- generated from, so the app can tell a document's series has already
-- progressed to the next stage (and skip offering to generate it again).
alter table invoices add column if not exists converted_from_id uuid references invoices(id) on delete set null;

create index if not exists invoices_converted_from_id_idx on invoices(converted_from_id);
