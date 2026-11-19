#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Online','Offline','Both')][string]$RuntimeMode = 'Online'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVersion = '0.1.0'
$taskCli = '2.12.6'
$taskTarget = 'x86_64-pc-windows-msvc'
$taskOut = Join-Path $taskRoot "release/rust/windows-preview/$taskVersion"
$taskLog = Join-Path $taskRoot '.playwright-mcp/rust-installer'
$taskCargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
$taskOldTarget = $env:CARGO_TARGET_DIR
$taskOldPath = $env:PATH
$taskPushed = $false
$taskMsbuildEnvironment = @{}
$taskVariants = @(
  if ($RuntimeMode -in @('Online','Both')) { @{ name='online'; mode='downloadBootstrapper'; suffix=''; config=$null } }
  if ($RuntimeMode -in @('Offline','Both')) { @{ name='offline'; mode='offlineInstaller'; suffix='-offline'; config='src-tauri/tauri.offline.conf.json' } }
)
New-Item -ItemType Directory -Force -Path $taskOut,$taskLog | Out-Null
Start-Transcript -LiteralPath (Join-Path $taskLog 'build.log') -Force | Out-Null

function Invoke-PreviewCommand {
  param([string]$Command,[string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Preview command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')" }
}

function Preserve-PreviewManifest {
  param([string]$Directory,[string]$Version)
  $taskPreviousPath = Join-Path $Directory 'installer-manifest.json'
  if (-not (Test-Path -LiteralPath $taskPreviousPath)) { return }
  $taskPrevious = Get-Content -LiteralPath $taskPreviousPath -Raw | ConvertFrom-Json
  if ($taskPrevious.schemaVersion -ne 1) { return }
  $taskPreviousFile = $taskPrevious.installer.file
  if ($taskPreviousFile -notin @("WISP-RS-$Version-windows-x64-setup.exe","WISP-RS-$Version-windows-x64-offline-setup.exe")) { throw 'Legacy installer manifest contains an unexpected artifact filename.' }
  $taskPreviousInstaller = Join-Path $Directory $taskPreviousFile
  $taskPreviousSidecar = Join-Path $Directory ($taskPreviousFile + '.manifest.json')
  if (-not (Test-Path -LiteralPath $taskPreviousInstaller) -or (Test-Path -LiteralPath $taskPreviousSidecar)) { return }
  if ((Get-Item -LiteralPath $taskPreviousInstaller).Length -ne $taskPrevious.installer.bytes -or
      (Get-FileHash -LiteralPath $taskPreviousInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskPrevious.installer.sha256) { throw 'Existing installer differs from its legacy provenance; refusing to relabel it.' }
  Copy-Item -LiteralPath $taskPreviousPath -Destination $taskPreviousSidecar
}

function Get-PreviewSourceInventory {
  $taskFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'src-tauri/src') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'src-tauri/capabilities') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'src-tauri/permissions') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'src/desktop-rust') -File -Recurse
    Get-Item -LiteralPath (Join-Path $taskRoot 'src/desktop/branding.ts'),(Join-Path $taskRoot 'src/desktop/branding.css')
    Get-Item -LiteralPath (Join-Path $taskRoot '.gitattributes')
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'public'),(Join-Path $taskRoot 'src-tauri/icons') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'rust-host-poc') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'dist-rust'),(Join-Path $taskRoot 'dist-rust-bridge'),(Join-Path $taskRoot 'dist-rust-navigation'),(Join-Path $taskRoot 'dist-rust-policies') -File -Recurse
    Get-Item -LiteralPath (Join-Path $taskRoot 'package.json'),(Join-Path $taskRoot 'src-tauri/Cargo.toml'),(Join-Path $taskRoot 'src-tauri/Cargo.lock'),(Join-Path $taskRoot 'src-tauri/build.rs'),(Join-Path $taskRoot 'src-tauri/tauri.conf.json'),(Join-Path $taskRoot 'src-tauri/tauri.preview.conf.json'),(Join-Path $taskRoot 'src-tauri/tauri.offline.conf.json'),(Join-Path $taskRoot 'build/rust-host-compat-plugin.ts'),(Join-Path $taskRoot 'vite.rust.config.ts'),(Join-Path $taskRoot 'rust-index.html')
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'scripts') -File | Where-Object { $_.Name -match 'rust|freeze-core' }
  )
  @($taskFiles | Sort-Object FullName -Unique | ForEach-Object {
    [ordered]@{ path=[IO.Path]::GetRelativePath($taskRoot,$_.FullName).Replace([char]92,[char]47); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
}

try {
  Push-Location $taskRoot
  $taskPushed = $true
  if (-not (Test-Path -LiteralPath $taskCargo)) { throw 'Rust stable MSVC is required for the independent preview installer.' }
  $taskConfig = Get-Content -LiteralPath 'src-tauri/tauri.preview.conf.json' -Raw | ConvertFrom-Json
  if ($taskConfig.identifier -ne 'com.studypilot.rust-preview' -or $taskConfig.bundle.windows.webviewInstallMode.type -ne 'downloadBootstrapper') { throw 'Preview installer identity or default runtime configuration changed.' }
  $taskOfflineConfig = Get-Content -LiteralPath 'src-tauri/tauri.offline.conf.json' -Raw | ConvertFrom-Json
  if ($taskOfflineConfig.bundle.windows.webviewInstallMode.type -ne 'offlineInstaller') { throw 'Offline runtime override changed.' }
  $taskMain = Get-Content -LiteralPath 'src-tauri/src/main.rs' -Raw
  if ($taskMain -notmatch '(?s)args\(\).*--poc.*run\(\).*else\s*\{\s*studypilot_rust_host_poc::run_desktop\(\)' -or $taskMain -match 'STUDYPILOT_RUST_DESKTOP') { throw 'Preview executable must launch desktop by default and reserve --poc for explicit local QA.' }
  Preserve-PreviewManifest -Directory $taskOut -Version $taskVersion
  # All generation/build paths remain separate from Electron dist/release/APK.
  foreach ($taskScript in @('verify-core-freeze.mjs','build-rust-page-bridge.mjs','build-rust-host-policies.mjs','build-rust-media-policy.mjs','build-rust-navigation-policy.mjs','build-rust-ui.mjs')) {
    Invoke-PreviewCommand 'node.exe' @("scripts/$taskScript")
  }
  $taskSources = Get-PreviewSourceInventory
  $taskSourceFingerprint = $taskSources | ConvertTo-Json -Depth 4 -Compress
  Write-Host 'Preview source and generated assets captured; no source edits are permitted until this installer build ends.'
  # Serialize the browser integration fixture with the CPU-heavy immutable Git
  # audit. Keep its original 15-second budget and all assertions intact.
  Invoke-PreviewCommand 'npm.cmd' @('test','--','--maxWorkers=1')
  $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path -LiteralPath $taskVswhere)) { throw 'Visual Studio C++ Build Tools are missing.' }
  $taskVs = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $taskVs) { throw 'No Visual Studio x64 C++ toolchain found.' }
  $taskVcvars = Join-Path $taskVs 'VC/Auxiliary/Build/vcvars64.bat'
  $taskEnvironment = & $env:ComSpec /d /s /c ('"' + $taskVcvars + '" >nul && set')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize MSVC and Windows SDK.' }
  foreach ($taskLine in $taskEnvironment) {
    if ($taskLine -match '^([^=]+)=(.*)$') {
      if ($matches[1] -in @('HOME','home','CODEX_HOME')) { continue }
      $taskMsbuildEnvironment[$matches[1]] = [Environment]::GetEnvironmentVariable($matches[1],'Process')
      [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process')
    }
  }
  $env:PATH = (Split-Path -Parent $taskCargo) + ';' + $env:PATH
  # Use a separate target so installer patching cannot replace native QA builds.
  $env:CARGO_TARGET_DIR = Join-Path $taskRoot 'src-tauri/target-installer'
  Invoke-PreviewCommand $taskCargo @('fmt','--manifest-path','src-tauri/Cargo.toml','--all','--','--check')
  Invoke-PreviewCommand $taskCargo @('clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--','-D','warnings')
  Invoke-PreviewCommand $taskCargo @('test','--manifest-path','src-tauri/Cargo.toml','--locked')
  $taskArtifacts = @()
  foreach ($taskVariant in $taskVariants) {
    $taskBuildStarted = [DateTime]::UtcNow
    $taskArguments = @('--yes','--package',"@tauri-apps/cli@$taskCli",'tauri','build','--ci','--no-sign','--target',$taskTarget,'--bundles','nsis','--config','src-tauri/tauri.preview.conf.json')
    if ($taskVariant.config) { $taskArguments += @('--config',$taskVariant.config) }
    $taskArguments += @('--','--locked')
    Invoke-PreviewCommand 'npx.cmd' $taskArguments
    if (((Get-PreviewSourceInventory | ConvertTo-Json -Depth 4 -Compress)) -ne $taskSourceFingerprint) { throw 'Preview source changed during installer construction; rebuild from a stable worktree.' }
    $taskBundleDirectory = Join-Path $env:CARGO_TARGET_DIR "$taskTarget/release/bundle/nsis"
    $taskInstallers = @(Get-ChildItem -LiteralPath $taskBundleDirectory -Filter '*.exe' -File | Where-Object { $_.LastWriteTimeUtc -ge $taskBuildStarted.AddSeconds(-2) })
    if ($taskInstallers.Count -ne 1) { throw "Expected one fresh $($taskVariant.name) NSIS installer, found $($taskInstallers.Count)." }
    $taskNsisPath = Join-Path $env:CARGO_TARGET_DIR "$taskTarget/release/nsis/x64/installer.nsi"
    $taskNsisText = Get-Content -LiteralPath $taskNsisPath -Raw
    if (-not $taskNsisText.Contains('!define INSTALLWEBVIEW2MODE "' + $taskVariant.mode + '"')) { throw 'Generated NSIS runtime mode does not match the requested package.' }
    Copy-Item -LiteralPath $taskNsisPath -Destination (Join-Path $taskLog "installer-$($taskVariant.name).nsi") -Force
    $taskDestination = Join-Path $taskOut "WISP-RS-$taskVersion-windows-x64$($taskVariant.suffix)-setup.exe"
    Copy-Item -LiteralPath $taskInstallers[0].FullName -Destination $taskDestination -Force
    $taskHash = (Get-FileHash -LiteralPath $taskDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskArtifacts += @{ file=(Split-Path -Leaf $taskDestination); bytes=(Get-Item -LiteralPath $taskDestination).Length; sha256=$taskHash; webviewInstallMode=$taskVariant.mode; requiresInternetWhenRuntimeMissing=($taskVariant.name -eq 'online'); minimumWebview2Version=$taskConfig.bundle.windows.minimumWebview2Version; nsisScriptSha256=(Get-FileHash -LiteralPath $taskNsisPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    Write-Host "Built independent $($taskVariant.name) preview installer: $taskDestination"
  }
  Invoke-PreviewCommand 'node.exe' @('scripts/verify-core-freeze.mjs')
  $taskProvenance = @('docs/migrations/rust-host/core-manifest.json','docs/migrations/rust-host/symbol-boundary.json','docs/migrations/rust-host/api-contract.json','dist-rust-bridge/page-bridge.manifest.json','dist-rust-bridge/media-policy.manifest.json','dist-rust-navigation/navigation-policy.manifest.json','dist-rust-policies/policies.manifest.json','src-tauri/Cargo.lock','package-lock.json','src-tauri/tauri.preview.conf.json','src-tauri/tauri.offline.conf.json')
  $taskInputs = foreach ($taskFile in $taskProvenance) {
    if (-not (Test-Path -LiteralPath $taskFile)) { throw "Missing installer provenance input: $taskFile" }
    @{ path=$taskFile; sha256=(Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  foreach ($taskArtifact in $taskArtifacts) {
    @{ schemaVersion=1; status='built-not-installed-or-published'; identifier=$taskConfig.identifier; version=$taskVersion; target=$taskTarget; tauriCli=$taskCli; commit=(& git rev-parse HEAD); baselineCommit='402dd25553185f39df56ca0014a1916a58c57a8e'; builtAt=[DateTime]::UtcNow.ToString('o'); installer=$taskArtifact; inputs=@($taskInputs); hostSources=@($taskSources); validation=@{ freshInstall='pending'; upgrade='pending'; missingRuntime='pending'; offlineMachine='pending'; uninstallDataRetention='pending'; rollback='pending'; releaseAuthorized=$false } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOut ($taskArtifact.file + '.manifest.json')) -Encoding utf8
  }
  # This index lists only this successful invocation. Every installer also has
  # its own provenance, so an existing offline package is never relabeled online.
  $taskArtifacts | ForEach-Object { "$($_.sha256)  $($_.file)" } | Set-Content -LiteralPath (Join-Path $taskOut 'SHA256SUMS.txt') -Encoding utf8
  @{ schemaVersion=2; status='built-not-installed-or-published'; defaultRuntimeMode='online'; requestedRuntimeMode=$RuntimeMode; installers=@($taskArtifacts); builtAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOut 'installer-manifest.json') -Encoding utf8
} catch {
  @{ status='blocked'; action='build-independent-rust-preview-installer'; error=$_.Exception.Message; at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLog 'blocked.json') -Encoding utf8
  throw
} finally {
  foreach ($taskName in $taskMsbuildEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskName,$taskMsbuildEnvironment[$taskName],'Process') }
  $env:CARGO_TARGET_DIR = $taskOldTarget
  $env:PATH = $taskOldPath
  if ($taskPushed) { Pop-Location }
  Stop-Transcript | Out-Null
}
