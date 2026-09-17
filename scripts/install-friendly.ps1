# Friendly installer for Codex Web GPT on Windows.
#
# By default this only inspects the machine and prints a report; nothing is changed.
#   -Fix       apply the safe, reversible fixes the report offers (user-level settings only)
#   -Install   download the Windows installer from a GitHub Release, verify it, and install it
#   -InstallerPath install a local codex-web-gpt-*-win-x64.exe (verified against checksums.txt beside it)
#   -Workspace also check a Codex project folder for settings that override the model picker
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File scripts\install-friendly.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-friendly.ps1 -Fix -Workspace D:\work\myproject
#   powershell -ExecutionPolicy Bypass -File scripts\install-friendly.ps1 -Install -Repository owner/repo [-Tag tag]

param(
  [switch]$Fix,
  [switch]$Install,
  [string]$InstallerPath,
  [string]$Repository = $env:CODEX_WEB_GPT_REPOSITORY,
  [string]$Tag = $env:CODEX_WEB_GPT_FRIENDLY_TAG,
  [string]$Workspace,
  [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$InstallerPattern = "codex-web-gpt-*-win-x64.exe"
$InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
$ExpectedBunVersion = "1.4.0"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptRoot
$RepoManifest = Join-Path $RepoRoot "package.json"
if (Test-Path $RepoManifest) {
  $Manifest = Get-Content $RepoManifest -Raw | ConvertFrom-Json
  if ([string]$Manifest.packageManager -match '^bun@(.+)$') { $ExpectedBunVersion = $Matches[1] }
}
$CoreHome = if ($env:CODEX_CHATGPT_WEB_HOME) { $env:CODEX_CHATGPT_WEB_HOME } else { Join-Path $env:USERPROFILE ".codex-chatgpt-web" }
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }

$Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Area,
    [string]$Name,
    [ValidateSet("OK", "WARN", "FAIL", "INFO", "FIXED")][string]$Status,
    [string]$Detail,
    [string]$Hint = ""
  )
  $Results.Add([pscustomobject]@{ Area = $Area; Name = $Name; Status = $Status; Detail = $Detail; Hint = $Hint })
}

function Invoke-NativeCapture {
  # Runs a native command with stdin closed and a hard timeout, so a tool that waits on the
  # console (seen with bun.exe under a nested, non-interactive PowerShell) cannot hang the report.
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [int]$TimeoutSeconds = 60,
    [hashtable]$Environment = @{}
  )
  $Info = New-Object Diagnostics.ProcessStartInfo
  $Info.FileName = $FilePath
  $Info.Arguments = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
  $Info.UseShellExecute = $false
  $Info.RedirectStandardInput = $true
  $Info.RedirectStandardOutput = $true
  $Info.RedirectStandardError = $true
  $Info.CreateNoWindow = $true
  foreach ($Key in $Environment.Keys) {
    if ($null -eq $Environment[$Key]) {
      if ($Info.EnvironmentVariables.ContainsKey($Key)) { $Info.EnvironmentVariables.Remove($Key) }
    } else {
      $Info.EnvironmentVariables[$Key] = [string]$Environment[$Key]
    }
  }
  $Process = [Diagnostics.Process]::Start($Info)
  $Process.StandardInput.Close()
  $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
  $StderrTask = $Process.StandardError.ReadToEndAsync()
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $Process.Kill() } catch { }
    return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Stdout = ""; Stderr = "" }
  }
  return [pscustomobject]@{
    TimedOut = $false
    ExitCode = $Process.ExitCode
    Stdout = $StdoutTask.Result
    Stderr = $StderrTask.Result
  }
}

function Get-UserEnv {
  param([string]$Name)
  return [Environment]::GetEnvironmentVariable($Name, "User")
}

function Find-Bun {
  $Command = Get-Command bun -ErrorAction SilentlyContinue
  if ($Command) { return $Command.Source }
  $Bundled = Get-ChildItem (Join-Path $CoreHome "versions") -Recurse -Filter bun.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\.(tmp|previous)-' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($Bundled) { return $Bundled.FullName }
  return $null
}

# ---------------------------------------------------------------- system

function Test-System {
  if ([Environment]::Is64BitOperatingSystem) {
    Add-Result "System" "Windows" "OK" "64-bit $([Environment]::OSVersion.VersionString)"
  } else {
    Add-Result "System" "Windows" "FAIL" "32-bit Windows" "The packaged launcher requires 64-bit Windows"
  }
  $Ps = $PSVersionTable.PSVersion
  if ($Ps.Major -ge 5) {
    Add-Result "System" "PowerShell" "OK" "$Ps"
  } else {
    Add-Result "System" "PowerShell" "FAIL" "$Ps" "Install Windows PowerShell 5.1 or PowerShell 7"
  }
  $DriveName = (Split-Path -Qualifier $env:LOCALAPPDATA).TrimEnd(":")
  $Drive = Get-PSDrive -Name $DriveName -ErrorAction SilentlyContinue
  if ($Drive) {
    $FreeGb = [math]::Round($Drive.Free / 1GB, 1)
    if ($FreeGb -ge 2) {
      Add-Result "System" "Disk space" "OK" "$FreeGb GB free on ${DriveName}:"
    } else {
      Add-Result "System" "Disk space" "FAIL" "$FreeGb GB free on ${DriveName}:" "Free at least 2 GB (the launcher installs about 600 MB)"
    }
  }
}

# ---------------------------------------------------------------- tools

function Test-Tools {
  $Bun = Find-Bun
  if (-not $Bun) {
    Add-Result "Tools" "Bun" "WARN" "not found" "Not needed for the installed launcher (it bundles Bun). To run from source: powershell -c `"irm bun.sh/install.ps1 | iex`""
  } else {
    $Run = Invoke-NativeCapture -FilePath $Bun -Arguments @("--version") -TimeoutSeconds 20
    $Version = $Run.Stdout.Trim()
    if ($Run.TimedOut -or -not $Version) {
      Add-Result "Tools" "Bun" "WARN" "$Bun did not report a version" "Run `"$Bun --version`" manually"
    } elseif ($Version -eq $ExpectedBunVersion) {
      Add-Result "Tools" "Bun" "OK" "$Version ($Bun)"
    } else {
      Add-Result "Tools" "Bun" "WARN" "$Version ($Bun), project pins $ExpectedBunVersion" "The installed launcher bundles its own Bun, so this only matters from source: serve usually works on newer Bun, but packaging and check-version require exactly $ExpectedBunVersion"
    }
  }

  $Optional = @(
    @{ Name = "git"; Hint = "winget install --id Git.Git" },
    @{ Name = "rg"; Hint = "winget install --id BurntSushi.ripgrep.MSVC (HITL searches work much better with ripgrep)" },
    @{ Name = "codex"; Hint = "npm install -g @openai/codex (only needed for delegated codex exec sub-tasks)" },
    @{ Name = "gh"; Hint = "winget install --id GitHub.cli (only needed to download from a private repository)" }
  )
  foreach ($Tool in $Optional) {
    $Command = Get-Command $Tool.Name -ErrorAction SilentlyContinue
    if ($Command) {
      Add-Result "Tools" $Tool.Name "OK" $Command.Source
    } else {
      Add-Result "Tools" $Tool.Name "WARN" "not found" $Tool.Hint
    }
  }

  $Desktop = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue
  if ($Desktop) {
    Add-Result "Tools" "Codex desktop" "OK" "$($Desktop.Version)"
  } else {
    Add-Result "Tools" "Codex desktop" "WARN" "not installed" "Install Codex from the Microsoft Store, or use the Codex CLI or IDE extension"
  }
}

# ---------------------------------------------------------------- network and certificates

$ProbeSource = @'
const targets = ["https://chatgpt.com/", "https://api.openai.com/v1/models", "https://github.com/"];
const results = {};
for (const url of targets) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15000) });
    results[url] = { ok: true, status: response.status };
  } catch (error) {
    results[url] = { ok: false, error: String((error && error.code) || (error && error.message) || error) };
  }
}
console.log(JSON.stringify(results));
'@

function Invoke-BunProbe {
  param([string]$Bun, [string]$ProbeFile, [bool]$UseSystemCa)
  $SystemCa = $null
  if ($UseSystemCa) { $SystemCa = "1" }
  $Run = Invoke-NativeCapture -FilePath $Bun -Arguments @($ProbeFile) -TimeoutSeconds 90 -Environment @{
    NODE_EXTRA_CA_CERTS = $null
    NODE_USE_SYSTEM_CA = $SystemCa
  }
  if ($Run.TimedOut) { return $null }
  $Line = ($Run.Stdout -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
  if (-not $Line) { return $null }
  return ($Line | ConvertFrom-Json)
}

function Test-AllProbesOk {
  param($Probe)
  if (-not $Probe) { return $false }
  foreach ($Property in $Probe.PSObject.Properties) {
    if (-not $Property.Value.ok) { return $false }
  }
  return $true
}

function Get-RemoteChainInfo {
  param([string]$HostName)
  $Client = New-Object Net.Sockets.TcpClient
  try {
    $Client.Connect($HostName, 443)
    # Windows validates the chain (including intermediates the server sends) before this callback;
    # record its verdict instead of rebuilding a chain from the leaf alone.
    $Captured = @{}
    $Callback = [Net.Security.RemoteCertificateValidationCallback] {
      param($Sender, $Certificate, $Chain, $Errors)
      $Captured.Errors = $Errors
      $Captured.Root = ($Chain.ChainElements | Select-Object -Last 1).Certificate.Subject
      return $true
    }.GetNewClosure()
    $Stream = New-Object Net.Security.SslStream($Client.GetStream(), $false, $Callback)
    try {
      $Stream.AuthenticateAsClient($HostName)
      $Leaf = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Stream.RemoteCertificate)
      return [pscustomobject]@{
        Issuer = $Leaf.Issuer
        Root = $Captured.Root
        TrustedByWindows = ($Captured.Errors -eq [Net.Security.SslPolicyErrors]::None)
      }
    } finally {
      $Stream.Dispose()
    }
  } finally {
    $Client.Dispose()
  }
}

function Test-Network {
  try {
    $Chain = Get-RemoteChainInfo "chatgpt.com"
    if ($Chain.TrustedByWindows) {
      Add-Result "Network" "Windows trust (chatgpt.com)" "OK" "root: $($Chain.Root)"
    } else {
      Add-Result "Network" "Windows trust (chatgpt.com)" "FAIL" "root not trusted: $($Chain.Root)" "Ask IT to deploy the corporate root CA to the Windows certificate store"
    }
    if ($Chain.Issuer -notmatch "Google Trust Services|DigiCert|Let's Encrypt|Cloudflare|Sectigo|GlobalSign") {
      Add-Result "Network" "TLS inspection" "INFO" "chatgpt.com is issued by $($Chain.Issuer); HTTPS appears to be intercepted"
    }
  } catch {
    Add-Result "Network" "Reach chatgpt.com" "FAIL" $_.Exception.Message "Check the network, VPN, or firewall"
  }

  $Bun = Find-Bun
  if (-not $Bun) {
    Add-Result "Network" "Bun TLS" "WARN" "skipped: Bun not found"
    return
  }
  $ProbeFile = Join-Path ([IO.Path]::GetTempPath()) "codex-web-gpt-probe-$([guid]::NewGuid().ToString('N')).mjs"
  [IO.File]::WriteAllText($ProbeFile, $ProbeSource, (New-Object Text.UTF8Encoding $false))
  try {
    $Default = Invoke-BunProbe -Bun $Bun -ProbeFile $ProbeFile -UseSystemCa $false
    $System = Invoke-BunProbe -Bun $Bun -ProbeFile $ProbeFile -UseSystemCa $true
  } finally {
    Remove-Item $ProbeFile -Force -ErrorAction SilentlyContinue
  }
  $UserSystemCa = Get-UserEnv "NODE_USE_SYSTEM_CA"
  $UserExtraCa = Get-UserEnv "NODE_EXTRA_CA_CERTS"
  if (Test-AllProbesOk $Default) {
    Add-Result "Network" "Bun TLS" "OK" "Bun reaches chatgpt.com, api.openai.com, and github.com with its bundled roots"
  } elseif (Test-AllProbesOk $System) {
    if ($UserSystemCa -eq "1") {
      Add-Result "Network" "Bun TLS" "OK" "TLS inspection detected; NODE_USE_SYSTEM_CA=1 is set for this user"
    } elseif ($Fix) {
      [Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")
      Add-Result "Network" "Bun TLS" "FIXED" "set user environment variable NODE_USE_SYSTEM_CA=1" "Reopen terminals, the launcher, and Codex so they inherit it"
    } else {
      Add-Result "Network" "Bun TLS" "FAIL" "TLS inspection detected; Bun rejects the corporate certificate" "Rerun with -Fix to set NODE_USE_SYSTEM_CA=1 for this user"
    }
  } else {
    $Failures = @()
    foreach ($Property in $System.PSObject.Properties) {
      if (-not $Property.Value.ok) { $Failures += "$($Property.Name): $($Property.Value.error)" }
    }
    $Hint = "Check proxy/firewall rules"
    if ($UserExtraCa) { $Hint = "$Hint; NODE_EXTRA_CA_CERTS is set to $UserExtraCa - confirm the PEM contains the corporate root CA" }
    Add-Result "Network" "Bun TLS" "FAIL" ($Failures -join "; ") $Hint
  }
  if ($UserExtraCa -and -not (Test-Path $UserExtraCa)) {
    Add-Result "Network" "NODE_EXTRA_CA_CERTS" "FAIL" "points to a missing file: $UserExtraCa" "Fix the path or remove the variable"
  }
}

# ---------------------------------------------------------------- runtime

function Read-CoreConfig {
  $Path = Join-Path $CoreHome "config.json"
  if (-not (Test-Path $Path)) { return $null }
  return (Get-Content $Path -Raw | ConvertFrom-Json)
}

function Get-LauncherInstall {
  $Location = $null
  try {
    $Location = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation" -ErrorAction Stop)
  } catch {
    $Location = Join-Path $env:LOCALAPPDATA "Programs\Codex Web GPT"
  }
  $Executable = Join-Path $Location "Codex Web GPT.exe"
  if (-not (Test-Path $Executable)) { return $null }
  return [pscustomobject]@{
    Location = $Location
    Executable = $Executable
    Version = (Get-Item $Executable).VersionInfo.ProductVersion
  }
}

function Test-Runtime {
  $Config = Read-CoreConfig
  if (-not $Config) {
    Add-Result "Runtime" "config.json" "WARN" "not found in $CoreHome" "Open the launcher and complete setup"
  } else {
    $Detail = "mode=$($Config.mode), browserHost=$($Config.browserHost), hitlEnabled=$($Config.hitlEnabled), port=$($Config.port)"
    Add-Result "Runtime" "config.json" "OK" $Detail
    if ($Port -eq 0 -and $Config.port) { $script:Port = [int]$Config.port }
  }
  if ($Port -eq 0) { $script:Port = 17841 }

  $Launcher = Get-LauncherInstall
  if ($Launcher) {
    Add-Result "Runtime" "Launcher" "OK" "$($Launcher.Version) at $($Launcher.Location)"
  } else {
    Add-Result "Runtime" "Launcher" "FAIL" "not installed" "Rerun with -Install -Repository <owner/repo> (or -InstallerPath <exe>)"
  }
  if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
    Add-Result "Runtime" "Launcher process" "OK" "running"
  } else {
    Add-Result "Runtime" "Launcher process" "WARN" "not running" "Start Codex Web GPT; ChatGPT turns need its browser"
  }

  $Listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $Listener) {
    if ($Config -and $Config.hitlEnabled -eq $true -and $Config.mode -eq "browser-only") {
      $ServeHint = "Terminal HITL mode is on, so the launcher does not start the server. Run: codex-chatgpt-web serve --hitl --workspace <project folder> --hitl-auto-approve"
    } else {
      $ServeHint = "Start Codex Web GPT; it starts the server in the background"
    }
    Add-Result "Runtime" "Port $Port" "WARN" "nothing is listening" $ServeHint
  } else {
    $Owner = Get-Process -Id $Listener.OwningProcess -ErrorAction SilentlyContinue
    try {
      $Health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
      if ($Health.service -eq "codex-chatgpt-web") {
        Add-Result "Runtime" "Port $Port" "OK" "codex-chatgpt-web $($Health.version) ($($Health.mode)), pid $($Health.pid)"
      } else {
        Add-Result "Runtime" "Port $Port" "FAIL" "used by $($Owner.ProcessName) (pid $($Listener.OwningProcess))" "Stop that process or choose another port in setup"
      }
    } catch {
      Add-Result "Runtime" "Port $Port" "FAIL" "used by $($Owner.ProcessName) (pid $($Listener.OwningProcess))" "Stop that process or choose another port in setup"
    }
  }

  $WhereRun = Invoke-NativeCapture -FilePath "where.exe" -Arguments @("codex-chatgpt-web") -TimeoutSeconds 15
  $Wrappers = @($WhereRun.Stdout -split "`r?`n" | Where-Object { $_ -match '\.cmd$' })
  $WrapperCount = ($Wrappers | Measure-Object).Count
  if ($WrapperCount -eq 0) {
    Add-Result "Runtime" "CLI wrapper" "WARN" "codex-chatgpt-web is not on PATH" "Only needed for terminal commands such as serve --hitl"
    return
  }
  $Hashes = @($Wrappers | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash } | Select-Object -Unique)
  if (($Hashes | Measure-Object).Count -gt 1) {
    Add-Result "Runtime" "CLI wrappers" "WARN" "$WrapperCount copies differ: $($Wrappers -join ', ')" "PATH uses the first one; keep them identical"
  } else {
    Add-Result "Runtime" "CLI wrappers" "OK" ($Wrappers -join ", ")
  }
  if ((Get-UserEnv "NODE_USE_SYSTEM_CA") -ne "1") { return }
  foreach ($Wrapper in $Wrappers) {
    $Text = [IO.File]::ReadAllText($Wrapper)
    if ($Text -match 'NODE_USE_SYSTEM_CA=1') { continue }
    if ($Fix) {
      $Line = "set `"NODE_USE_SYSTEM_CA=1`""
      if ($Text -match '(?m)^chcp 65001 >nul\r?$') {
        $Updated = [regex]::Replace($Text, '(?m)^(chcp 65001 >nul)(\r?)$', "`$1`$2`n$Line`$2", 1)
      } else {
        $Updated = [regex]::Replace($Text, '(?m)^(setlocal)(\r?)$', "`$1`$2`n$Line`$2", 1)
      }
      Copy-Item $Wrapper "$Wrapper.bak" -Force
      [IO.File]::WriteAllText($Wrapper, $Updated, (New-Object Text.UTF8Encoding $false))
      Add-Result "Runtime" "Wrapper CA setting" "FIXED" "added NODE_USE_SYSTEM_CA=1 to $Wrapper (backup: .bak)"
    } else {
      Add-Result "Runtime" "Wrapper CA setting" "WARN" "$Wrapper does not set NODE_USE_SYSTEM_CA=1" "Rerun with -Fix"
    }
  }
}

# ---------------------------------------------------------------- Codex configuration

function Get-TomlString {
  param([string]$Text, [string]$Key)
  $Match = [regex]::Match($Text, "(?m)^\s*$([regex]::Escape($Key))\s*=\s*`"([^`"]*)`"")
  if ($Match.Success) { return $Match.Groups[1].Value }
  return $null
}

function Test-CodexConfig {
  $Path = Join-Path $CodexHome "config.toml"
  if (-not (Test-Path $Path)) {
    Add-Result "Codex" "config.toml" "WARN" "not found at $Path" "Open the launcher and connect Codex"
    return
  }
  $Text = [IO.File]::ReadAllText($Path)
  $BaseUrl = Get-TomlString $Text "openai_base_url"
  $Expected = "http://127.0.0.1:$Port/v1"
  if ($BaseUrl -eq $Expected) {
    Add-Result "Codex" "Model route" "OK" "openai_base_url = $BaseUrl"
  } elseif ($BaseUrl) {
    Add-Result "Codex" "Model route" "FAIL" "openai_base_url = $BaseUrl (expected $Expected)" "Reconnect Codex from the launcher"
  } else {
    Add-Result "Codex" "Model route" "FAIL" "openai_base_url is not set" "Connect Codex from the launcher, then fully restart Codex"
  }
  $Model = Get-TomlString $Text "model"
  if ($Model) { Add-Result "Codex" "Default model" "INFO" $Model }

  if (-not $Workspace) { return }
  if (-not (Test-Path $Workspace -PathType Container)) {
    Add-Result "Codex" "Workspace" "FAIL" "not a folder: $Workspace"
    return
  }
  $Directory = (Resolve-Path $Workspace).Path
  $Pinned = $false
  while ($Directory) {
    $ProjectConfig = Join-Path $Directory ".codex\config.toml"
    if (Test-Path $ProjectConfig) {
      $ProjectModel = Get-TomlString ([IO.File]::ReadAllText($ProjectConfig)) "model"
      if ($ProjectModel) {
        $Pinned = $true
        Add-Result "Codex" "Project model pin" "WARN" "$ProjectConfig sets model = $ProjectModel" "Codex desktop snaps the picker back to it; comment out the model lines to choose chatgpt-web/* models"
      }
    }
    $Parent = Split-Path -Parent $Directory
    if (-not $Parent -or $Parent -eq $Directory) { break }
    $Directory = $Parent
  }
  if (-not $Pinned) { Add-Result "Codex" "Project model pin" "OK" "no project-level model override under $Workspace" }
}

# ---------------------------------------------------------------- install

function Invoke-WithRetry {
  param([scriptblock]$Operation, [string]$Label)
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try { return & $Operation } catch {
      if ($Attempt -eq 3) { throw "$Label failed after $Attempt attempts: $($_.Exception.Message)" }
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
}

function Get-ExpectedHash {
  param([string]$ChecksumFile, [string]$FileName)
  $Line = Get-Content $ChecksumFile | Where-Object { $_ -match "\s\*?$([regex]::Escape($FileName))$" } | Select-Object -First 1
  if (-not $Line) { throw "$ChecksumFile has no entry for $FileName" }
  return ($Line -split "\s+")[0].ToLowerInvariant()
}

function Install-Friendly {
  $Temp = Join-Path ([IO.Path]::GetTempPath()) "codex-web-gpt-friendly-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $Temp | Out-Null
  try {
    if ($InstallerPath) {
      $InstallerFile = Get-Item (Resolve-Path $InstallerPath).Path
      Write-Host "Using local installer $($InstallerFile.FullName)"
      $Checksums = Join-Path $InstallerFile.DirectoryName "checksums.txt"
      if (Test-Path $Checksums) {
        $Expected = Get-ExpectedHash $Checksums $InstallerFile.Name
        $Actual = (Get-FileHash -Algorithm SHA256 $InstallerFile.FullName).Hash.ToLowerInvariant()
        if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $($InstallerFile.Name)" }
        Write-Host "Verified $($InstallerFile.Name) against checksums.txt"
      } else {
        Write-Host "No checksums.txt next to the installer; skipping SHA-256 verification" -ForegroundColor Yellow
      }
    } else {
      if (-not $Repository -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw "Pass -Repository owner/name (or set CODEX_WEB_GPT_REPOSITORY) to download the release"
      }
      $Checksums = Join-Path $Temp "checksums.txt"
      if (Get-Command gh -ErrorAction SilentlyContinue) {
        # gh also works for private repositories.
        $TagArgs = @()
        if ($Tag) { $TagArgs = @($Tag) }
        Write-Host "Downloading the Windows installer from $Repository with gh ..."
        & gh release download @TagArgs -R $Repository -p $InstallerPattern -p "checksums.txt" -D $Temp --clobber
        if ($LASTEXITCODE -ne 0) { throw "gh release download failed with code $LASTEXITCODE" }
      } else {
        if ($Tag) { $ReleaseApi = "https://api.github.com/repos/$Repository/releases/tags/$Tag" } else { $ReleaseApi = "https://api.github.com/repos/$Repository/releases/latest" }
        $Release = Invoke-WithRetry -Label "Resolving the release" -Operation { Invoke-RestMethod $ReleaseApi -TimeoutSec 60 }
        $Assets = @($Release.assets | Where-Object { $_.name -like $InstallerPattern -or $_.name -eq "checksums.txt" })
        if (($Assets | Measure-Object).Count -lt 2) { throw "Release $($Release.tag_name) has no Windows installer and checksums.txt" }
        foreach ($Asset in $Assets) {
          $Destination = Join-Path $Temp $Asset.name
          Write-Host "Downloading $($Asset.name) ..."
          $null = Invoke-WithRetry -Label "Downloading $($Asset.name)" -Operation {
            Invoke-WebRequest $Asset.browser_download_url -OutFile $Destination -TimeoutSec 1800 -UseBasicParsing
          }
        }
      }
      $InstallerFile = Get-ChildItem $Temp -Filter $InstallerPattern | Select-Object -First 1
      if (-not $InstallerFile) { throw "The release has no $InstallerPattern installer" }
      if (-not (Test-Path $Checksums)) { throw "The release has no checksums.txt" }
      $Expected = Get-ExpectedHash $Checksums $InstallerFile.Name
      $Actual = (Get-FileHash -Algorithm SHA256 $InstallerFile.FullName).Hash.ToLowerInvariant()
      if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $($InstallerFile.Name)" }
      Write-Host "Verified $($InstallerFile.Name) ($Actual)"
    }
    $Installer = $InstallerFile

    if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
      throw "Quit Codex Web GPT (tray icon > Quit) before installing, then rerun this script"
    }
    Write-Host "Installing $($Installer.Name) ..."
    $Process = Start-Process -FilePath $Installer.FullName -ArgumentList "/S", "/currentuser" -Wait -PassThru
    if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
    $Launcher = Get-LauncherInstall
    if (-not $Launcher) { throw "The installer finished but the launcher was not found" }
    # Inherited from Electron hosts such as VS Code; it would make the launcher run as plain Node
    # and exit immediately without opening a window.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process $Launcher.Executable
    Start-Sleep -Seconds 5
    if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
      Write-Host "Installed and started $($Launcher.Executable) ($($Launcher.Version))"
    } else {
      Write-Host "Installed $($Launcher.Executable) ($($Launcher.Version)), but it did not stay running; start Codex Web GPT from the Start menu" -ForegroundColor Yellow
    }
  } finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- report

function Write-Report {
  $Colors = @{ OK = "Green"; FIXED = "Cyan"; INFO = "Gray"; WARN = "Yellow"; FAIL = "Red" }
  $CurrentArea = ""
  foreach ($Result in $Results) {
    if ($Result.Area -ne $CurrentArea) {
      Write-Host ""
      Write-Host "[$($Result.Area)]" -ForegroundColor White
      $CurrentArea = $Result.Area
    }
    $Label = ("{0,-6}" -f $Result.Status)
    Write-Host "  $Label " -ForegroundColor $Colors[$Result.Status] -NoNewline
    Write-Host "$($Result.Name): $($Result.Detail)"
    if ($Result.Hint) { Write-Host "         -> $($Result.Hint)" -ForegroundColor DarkGray }
  }
  $Failures = ($Results | Where-Object Status -eq "FAIL" | Measure-Object).Count
  $Warnings = ($Results | Where-Object Status -eq "WARN" | Measure-Object).Count
  $Fixed = ($Results | Where-Object Status -eq "FIXED" | Measure-Object).Count
  Write-Host ""
  Write-Host "Summary: $Failures failed, $Warnings warnings, $Fixed fixed"
  if (-not $Fix -and $Failures -gt 0) {
    Write-Host "Rerun with -Fix to apply the safe fixes marked above." -ForegroundColor DarkGray
  }
  return $Failures
}

try {
  Write-Host "Codex Web GPT friendly installer" -ForegroundColor Cyan
  if ($Install -or $InstallerPath) {
    Install-Friendly
  }
  Test-System
  Test-Tools
  Test-Network
  Test-Runtime
  Test-CodexConfig
  $FailureCount = Write-Report
  if ($FailureCount -gt 0) { exit 1 }
} catch {
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
