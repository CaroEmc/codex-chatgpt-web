# Prepares the Windows launcher release assets consumed by scripts/install-friendly.ps1 and
# optionally uploads them to a GitHub Release. No zip is produced: the release carries the NSIS
# installer itself, checksums.txt covering every asset, and install-friendly.ps1.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-friendly-release.ps1 [-Build]
#   powershell -ExecutionPolicy Bypass -File scripts\package-friendly-release.ps1 -Publish -Repository owner/repo -Tag v5.0.9-friendly.1 [-Target branch]
#
#   -Build      run `bun run package:win` in launcher/ first
#   -Publish    upload with gh (creates the release when the tag does not exist yet); nothing is
#               uploaded without this switch
#   -Target     branch or commit a newly created tag points at (default: the repository's default branch)

param(
  [switch]$Build,
  [switch]$Publish,
  [string]$Repository,
  [string]$Tag,
  [string]$Target,
  [string]$OutputDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LauncherDir = Join-Path $Root "launcher"
$Version = [string](Get-Content (Join-Path $LauncherDir "package.json") -Raw | ConvertFrom-Json).version
if (-not $Version) { throw "Could not read version from launcher/package.json" }
if (-not $OutputDir) { $OutputDir = Join-Path $LauncherDir "artifacts\release" }

try {
  if ($Build) {
    Push-Location $LauncherDir
    try {
      Write-Host "Packaging launcher $Version ..." -ForegroundColor Cyan
      & bun run package:win
      if ($LASTEXITCODE -ne 0) { throw "bun run package:win failed with code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }

  $InstallerName = "codex-web-gpt-$Version-win-x64.exe"
  $BuiltInstaller = Join-Path $LauncherDir "artifacts\$InstallerName"
  if (-not (Test-Path $BuiltInstaller)) { throw "Installer not found: $BuiltInstaller (rerun with -Build)" }
  if ((Get-Item $BuiltInstaller).Length -ge 2GB) { throw "The installer exceeds the 2 GB GitHub release asset limit" }

  Remove-Item -Recurse -Force $OutputDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $Installer = Join-Path $OutputDir $InstallerName
  $Script = Join-Path $OutputDir "install-friendly.ps1"
  $Checksums = Join-Path $OutputDir "checksums.txt"
  Copy-Item $BuiltInstaller $Installer
  Copy-Item (Join-Path $ScriptDir "install-friendly.ps1") $Script

  $Lines = @()
  foreach ($Asset in @($Installer, $Script)) {
    $Hash = (Get-FileHash -Algorithm SHA256 $Asset).Hash.ToLowerInvariant()
    $Lines += "$Hash  $(Split-Path -Leaf $Asset)"
  }
  [IO.File]::WriteAllText($Checksums, (($Lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))

  $Commit = (& git -C $Root rev-parse --short HEAD 2>$null)
  $SizeMb = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
  Write-Host "Prepared release assets in $OutputDir (commit $Commit)" -ForegroundColor Green
  Write-Host "  $InstallerName ($SizeMb MB)"
  Write-Host "  install-friendly.ps1"
  Write-Host "  checksums.txt"
  Get-Content $Checksums | ForEach-Object { Write-Host "    $_" }

  if (-not $Publish) {
    Write-Host "Not published. Rerun with -Publish -Repository owner/repo -Tag <tag> [-Target branch] to upload." -ForegroundColor DarkGray
    exit 0
  }
  if (-not $Repository -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Publish requires -Repository owner/repo" }
  if (-not $Tag) { throw "-Publish requires -Tag" }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "-Publish requires the GitHub CLI (gh)" }

  $Notes = @(
    "Codex Web GPT $Version for Windows x64 (built from commit $Commit).",
    "",
    "Check the machine first (changes nothing), then install and apply safe fixes:",
    "",
    '```powershell',
    "powershell -ExecutionPolicy Bypass -File install-friendly.ps1",
    "powershell -ExecutionPolicy Bypass -File install-friendly.ps1 -Install -Repository $Repository -Tag $Tag -Fix",
    '```',
    "",
    "Quit Codex Web GPT (tray icon > Quit) before installing, and fully restart Codex afterwards.",
    "The installer is not code-signed; verify it against checksums.txt."
  ) -join "`n"

  # Windows PowerShell 5.1 turns a native command's stderr into a terminating error under
  # ErrorActionPreference=Stop, so probe for the release with Stop relaxed.
  $SavedPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & gh release view $Tag -R $Repository *> $null
  $ReleaseExists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $SavedPreference
  if (-not $ReleaseExists) {
    Write-Host "Creating release $Tag in $Repository ..." -ForegroundColor Cyan
    $TargetArgs = @()
    if ($Target) { $TargetArgs = @("--target", $Target) }
    & gh release create $Tag -R $Repository @TargetArgs --title "Codex Web GPT $Version (Windows friendly installer)" --notes $Notes $Installer $Script $Checksums
  } else {
    Write-Host "Uploading to existing release $Tag in $Repository ..." -ForegroundColor Cyan
    & gh release upload $Tag -R $Repository $Installer $Script $Checksums --clobber
  }
  if ($LASTEXITCODE -ne 0) { throw "gh failed with code $LASTEXITCODE" }
  Write-Host "Published to https://github.com/$Repository/releases/tag/$Tag" -ForegroundColor Green
} catch {
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
