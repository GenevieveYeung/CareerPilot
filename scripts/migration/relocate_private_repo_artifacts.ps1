$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$parent = Split-Path -Parent $repo
$archiveRoot = Join-Path $parent 'archive'
New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null

function Move-Safely([string]$source, [string]$target) {
  if (-not (Test-Path -LiteralPath $source)) { return $false }
  if (Test-Path -LiteralPath $target) { throw "Target already exists: $target" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Move-Item -LiteralPath $source -Destination $target
  return $true
}

$moved = [ordered]@{}
$moved['private_data'] = Move-Safely (Join-Path $repo 'data\private') (Join-Path $archiveRoot 'careerpilot_private_data_before_portability_20260824')
$moved['logs'] = Move-Safely (Join-Path $repo 'logs') (Join-Path $archiveRoot 'careerpilot_logs_before_portability_20260824')
$moved['exports'] = Move-Safely (Join-Path $repo 'exports') (Join-Path $archiveRoot 'careerpilot_exports_before_portability_20260824')
$moved['application_previews'] = Move-Safely (Join-Path $repo 'application_previews') (Join-Path $archiveRoot 'careerpilot_application_previews_before_portability_20260824')
$moved['audit'] = Move-Safely (Join-Path $repo 'audit') (Join-Path $archiveRoot 'careerpilot_audit_before_portability_20260824')
$moved['dashboard_audit'] = Move-Safely (Join-Path $repo 'dashboard\audit') (Join-Path $archiveRoot 'careerpilot_dashboard_audit_before_portability_20260824')
$moved['_archive'] = Move-Safely (Join-Path $repo '_archive') (Join-Path $archiveRoot 'careerpilot_legacy_archive_before_portability_20260824')
$moved['archive'] = Move-Safely (Join-Path $repo 'archive') (Join-Path $archiveRoot 'careerpilot_checkpoints_before_portability_20260824')
$moved['trash'] = Move-Safely (Join-Path $repo 'trash') (Join-Path $archiveRoot 'careerpilot_trash_before_portability_20260824')

$controlTarget = Join-Path $env:LOCALAPPDATA 'CareerPilot\legacy-control-before-portability-20260824'
$moved['control'] = Move-Safely (Join-Path $repo '_control') $controlTarget

$csvTarget = Join-Path $archiveRoot 'careerpilot_dashboard_data_before_portability_20260824'
$dashboardFiles = Get-ChildItem -LiteralPath (Join-Path $repo 'dashboard') -File | Where-Object { $_.Extension -in @('.csv','.md','.log') }
foreach ($file in $dashboardFiles) {
  Move-Safely $file.FullName (Join-Path $csvTarget $file.Name) | Out-Null
}
$moved['dashboard_generated_files'] = @($dashboardFiles).Count

$manifest = [ordered]@{
  moved_at = (Get-Date).ToUniversalTime().ToString('o')
  repository = $repo
  archive_root = $archiveRoot
  moved = $moved
  dashboard_generated_files = @($dashboardFiles | ForEach-Object Name)
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $archiveRoot 'careerpilot_portability_relocation_manifest_20260824.json') -Encoding UTF8
$manifest | ConvertTo-Json -Depth 6
