-- user_settings.user_prefs only accepted four keys (user_settings_prefs_keys_chk). The app now also stores
-- messageSound (message tones) and displayName (dashboard greeting), so saving Settings was rejected.
-- Widen the whitelist; unknown keys are still refused. Safe to re-run.
alter table public.user_settings drop constraint if exists user_settings_prefs_keys_chk;
alter table public.user_settings add constraint user_settings_prefs_keys_chk
  check (
    jsonb_typeof(user_prefs) = 'object'
    and (user_prefs - array['dashboardPeriod','notifyCategories','sound','messageSound','focusTimer','displayName']) = '{}'::jsonb
  ) not valid;
