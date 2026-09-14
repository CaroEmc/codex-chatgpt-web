# Installs the Codex Web GPT desktop launcher from this repo checkout,
# without downloading a release asset. Mirrors install-launcher.ps1, but
# packages and installs from the local working tree instead of a GitHub
# release. Electron-builder disallows cross-packaging, so this only builds
# for Windows when run on Windows.
#
# Usage:
#   ./scripts/install-launcher-local.ps1 [-SkipBuild]

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-IsFullyQualifiedWindowsPath {
  param([AllowEmptyString()][string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The packaged Windows launcher requires 64-bit Windows"
}
$Arch = "x64"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Push-Location $Root
try {
  $LauncherManifest = Get-Content (Join-Path $Root "launcher\package.json") -Raw | ConvertFrom-Json
  $Version = [string]$LauncherManifest.version
  if (-not $Version) { throw "Could not read version from launcher/package.json" }

  $ArtifactsDir = Join-Path $Root "launcher\artifacts"
  $Asset = "codex-web-gpt-$Version-win-$Arch.exe"
  $Installer = Join-Path $ArtifactsDir $Asset

  if (-not $SkipBuild -or -not (Test-Path $Installer)) {
    Write-Host "Packaging launcher from $Root ..."
    & bun run app:package
    if ($LASTEXITCODE -ne 0) { throw "bun run app:package failed with code $LASTEXITCODE" }
  }

  if (-not (Test-Path $Installer)) {
    throw "Expected packaged artifact not found: $Installer"
  }

  if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
    throw "Quit Codex Web GPT before updating it"
  }

  $Process = Start-Process -FilePath $Installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }

  $InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
  $InstallLocation = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation")
  if (-not (Test-IsFullyQualifiedWindowsPath $InstallLocation)) {
    throw "Installer recorded an invalid InstallLocation: $InstallLocation"
  }
  $Executable = Join-Path $InstallLocation "Codex Web GPT.exe"
  if (-not (Test-Path $Executable)) { throw "Installed launcher was not found at $Executable" }
  Start-Process $Executable
  Write-Host "Installed $Executable (from local checkout, version $Version)"
} finally {
  Pop-Location
}
