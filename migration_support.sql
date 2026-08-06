-- Run this in the Supabase SQL Editor to add in-app support messages.
-- Safe to run alongside your existing schema.

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null default '',
  message text not null,
  page_context text default '',
  status text not null default 'open',
  created_at timestamptz default now()
);

alter table support_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'support_messages' and policyname = 'Users send and view their own support messages'
  ) then
    create policy "Users send and view their own support messages"
      on support_messages for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Lets your own admin account see every message, not just its own, so
-- there's a real path to reviewing what's come in without needing a
-- separate admin dashboard yet.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'support_messages' and policyname = 'Admins view all support messages'
  ) then
    create policy "Admins view all support messages"
      on support_messages for select
      using (
        exists (
          select 1 from user_settings
          where user_settings.user_id = auth.uid() and user_settings.is_admin = true
        )
      );
  end if;
end $$;

create index if not exists support_messages_created_at_idx on support_messages(created_at desc);
