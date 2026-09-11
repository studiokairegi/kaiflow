-- Run this in the Supabase SQL Editor to let expenses carry their own
-- currency, same as projects and invoices already do.

alter table expenses add column if not exists currency text not null default '$';
