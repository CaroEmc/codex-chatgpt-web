# Packages the built Windows launcher installer into the friendly release zip consumed by
# scripts/install-friendly.ps1, and optionally uploads it to a GitHub Release.
#
# The zip contains the NSIS installer, its checksums.txt, install-friendly.ps1, and INSTALL.txt.
# A separate friendly-checksums.txt covers the zip itself.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-friendly-release.ps1 [-Build]
#   powershell -ExecutionPolicy Bypass -File scripts\package-friendly-release.ps1 -Publish -Repository owner/repo -Tag v5.0.7-friendly.1
#
#   -Build      run `bun run package:win` in launcher/ first
#   -Publish    upload with gh (creates the release when the tag does not exist yet); nothing is
#               uploaded without this switch

param(
  [switch]$Build,
  [switch]$Publish,
  [string]$Repository,
  [string]$Tag,
  [string]$OutputDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$FriendlyAsset = "codex-web-gpt-friendly-win-x64.zip"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LauncherDir = Join-Path $Root "launcher"
$Version = [string](Get-Content (Join-Path $LauncherDir "package.json") -Raw | ConvertFrom-Json).version
if (-not $Version) { throw "Could not read version from launcher/package.json" }
if (-not $OutputDir) { $OutputDir = Join-Path $LauncherDir "artifacts\friendly" }

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
  $Installer = Join-Path $LauncherDir "artifacts\$InstallerName"
  if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer (rerun with -Build)" }
  $Built = (Get-Item $Installer).LastWriteTime

  $Stage = Join-Path ([IO.Path]::GetTempPath()) "codex-web-gpt-friendly-stage-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $Stage | Out-Null
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  try {
    Copy-Item $Installer (Join-Path $Stage $InstallerName)
    Copy-Item (Join-Path $ScriptDir "install-friendly.ps1") (Join-Path $Stage "install-friendly.ps1")
    $InstallerHash = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
    $Utf8 = New-Object Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $Stage "checksums.txt"), "$InstallerHash  $InstallerName`n", $Utf8)
    $Commit = (& git -C $Root rev-parse --short HEAD 2>$null)
    $Notes = @(
      "Codex Web GPT $Version - friendly Windows package",
      "Built: $($Built.ToString('yyyy-MM-dd HH:mm')) from commit $Commit",
      "",
      "1. Quit Codex Web GPT if it is running (tray icon > Quit).",
      "2. Check this machine first (changes nothing):",
      "     powershell -ExecutionPolicy Bypass -File install-friendly.ps1",
      "3. Install from this folder's zip, applying safe fixes:",
      "     powershell -ExecutionPolicy Bypass -File install-friendly.ps1 -ZipPath <path to this zip> -Fix",
      "4. Fully restart Codex afterwards.",
      "",
      "$InstallerName SHA-256: $InstallerHash"
    )
    [IO.File]::WriteAllText((Join-Path $Stage "INSTALL.txt"), (($Notes -join "`r`n") + "`r`n"), $Utf8)

    $Zip = Join-Path $OutputDir $FriendlyAsset
    Remove-Item $Zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip -CompressionLevel Optimal
  } finally {
    Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
  }

  $ZipHash = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLowerInvariant()
  $Checksums = Join-Path $OutputDir "friendly-checksums.txt"
  [IO.File]::WriteAllText($Checksums, "$ZipHash  $FriendlyAsset`n", (New-Object Text.UTF8Encoding $false))
  $SizeMb = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
  Write-Host "Created $Zip ($SizeMb MB)" -ForegroundColor Green
  Write-Host "  SHA-256 $ZipHash"
  if ((Get-Item $Zip).Length -ge 2GB) { throw "The zip exceeds the 2 GB GitHub release asset limit" }

  if (-not $Publish) {
    Write-Host "Not published. Rerun with -Publish -Repository owner/repo -Tag <tag> to upload." -ForegroundColor DarkGray
    exit 0
  }
  if (-not $Repository -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Publish requires -Repository owner/repo" }
  if (-not $Tag) { throw "-Publish requires -Tag" }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "-Publish requires the GitHub CLI (gh)" }

  & gh release view $Tag -R $Repository *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating release $Tag in $Repository ..." -ForegroundColor Cyan
    & gh release create $Tag -R $Repository --title "Codex Web GPT $Version (friendly Windows package)" --notes "Friendly Windows package: installer, install-friendly.ps1, and checksums. See INSTALL.txt inside the zip." $Zip $Checksums
  } else {
    Write-Host "Uploading to existing release $Tag in $Repository ..." -ForegroundColor Cyan
    & gh release upload $Tag -R $Repository $Zip $Checksums --clobber
  }
  if ($LASTEXITCODE -ne 0) { throw "gh failed with code $LASTEXITCODE" }
  Write-Host "Published $FriendlyAsset to https://github.com/$Repository/releases/tag/$Tag" -ForegroundColor Green
} catch {
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
