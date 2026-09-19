-- Per-shot Google Drive folder destinations
-- Keeps existing project-level folder IDs for backward compatibility.
alter table public.shots add column if not exists drive_cuts_folder_id text;
alter table public.shots add column if not exists drive_deliverables_folder_id text;
alter table public.shots add column if not exists drive_attachments_folder_id text;
