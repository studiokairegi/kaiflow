-- Studio contact details and payment instructions printed on invoices, proformas and receipts.
-- Additive and idempotent. The app only writes these columns once they exist or a value is entered.
alter table public.user_settings add column if not exists studio_email text not null default '';
alter table public.user_settings add column if not exists studio_phone text not null default '';
alter table public.user_settings add column if not exists studio_website text not null default '';
alter table public.user_settings add column if not exists invoice_payment_instructions text not null default '';
alter table public.user_settings add column if not exists invoice_footer_note text not null default '';
