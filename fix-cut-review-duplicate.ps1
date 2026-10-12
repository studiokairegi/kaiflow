$ErrorActionPreference = 'Stop'

$path = 'supabase/migrations/20261012090000_cut_review_final_delivery.sql'
$backup = "$path.bak-cross-shot"

if (-not (Test-Path $path)) {
    throw "Migration not found: $path"
}
if (-not (Test-Path $backup)) {
    throw "Expected backup not found: $backup"
}

$content = [System.IO.File]::ReadAllText((Resolve-Path $path))

$pattern = '(?s)  -- Retry of the same Drive file: return the existing record, change nothing\.\s+select \* into v_existing from cut_submissions where drive_file_id = p_drive_file_id;\s+if found then\s+return jsonb_build_object\(''submissionId'', v_existing\.id, ''version'', v_existing\.version, ''duplicate'', true\);\s+end if;'

$replacement = @"
  -- A Drive file may be retried only for the shot it was originally registered to.
  select * into v_existing from cut_submissions where drive_file_id = p_drive_file_id;
  if found then
    if v_existing.shot_id <> v_shot.id then
      raise exception 'drive_file_already_registered' using errcode = 'P0001';
    end if;
    return jsonb_build_object('submissionId', v_existing.id, 'version', v_existing.version, 'duplicate', true);
  end if;
"@

$updated = [regex]::Replace($content, $pattern, $replacement)

if ($updated -eq $content) {
    throw 'Expected original block was not found. Migration was not changed.'
}
if ([regex]::Matches($updated, 'drive_file_already_registered').Count -ne 1) {
    throw 'Verification failed: expected exactly one cross-shot guard.'
}

[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location) $path),
    $updated,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Output 'Local migration updated.'
Select-String -Path $path -Pattern 'Drive file may be retried|drive_file_already_registered'