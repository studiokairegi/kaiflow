-- Run this in the Supabase SQL Editor to fix a real bug: every public
-- share-link function and policy was granted to the `anon` Postgres role
-- only. That's correct for a visitor with no session at all (which is why
-- incognito always worked), but if the same browser has ANY active
-- Supabase session, even from an unrelated login, the Supabase client
-- automatically attaches it, and the request runs as `authenticated`
-- instead of `anon`. Since `authenticated` was never granted access,
-- Postgres rejected the call outright, surfacing as "This link isn't
-- valid" even though the token itself was perfectly fine.
--
-- These functions are all SECURITY DEFINER and already validate the exact
-- token before returning anything, so extending access to `authenticated`
-- doesn't loosen security, it just stops rejecting legitimate requests
-- that happen to carry a session.

grant execute on function get_shared_project(text) to authenticated;
grant execute on function get_shared_shot(text) to authenticated;
grant execute on function is_valid_shot_token(text) to authenticated;
grant execute on function add_shot_deliverable(text, text, text, text) to authenticated;

alter policy "Freelancer upload via share token" on storage.objects to anon, authenticated;
