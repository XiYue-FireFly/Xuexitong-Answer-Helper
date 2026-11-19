[CmdletBinding()]
param(
  [ValidateSet('check','build','test','clippy','fmt')][string]$Action = 'check'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
if (-not (Test-Path -LiteralPath $taskCargo)) { throw 'Install Rust stable MSVC before building the Rust host.' }
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $taskVswhere)) { throw 'Visual Studio C++ Build Tools are missing.' }
$taskVs = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVs) { throw 'No Visual Studio installation with x64 C++ build tools found.' }
$taskVcvars = Join-Path $taskVs 'VC/Auxiliary/Build/vcvars64.bat'
if (-not (Test-Path -LiteralPath $taskVcvars)) { throw 'vcvars64.bat is missing.' }
$taskEnvironment = & $env:ComSpec /d /s /c ('"' + $taskVcvars + '" >nul && set')
if ($LASTEXITCODE -ne 0) { throw 'Cannot load MSVC and Windows SDK environment.' }
foreach ($taskLine in $taskEnvironment) {
  if ($taskLine -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process') }
}
$env:PATH = (Split-Path -Parent $taskCargo) + ';' + $env:PATH
Push-Location $taskRoot
try {
  if ($Action -eq 'fmt') { & $taskCargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check }
  elseif ($Action -eq 'clippy') { & $taskCargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings }
  elseif ($Action -eq 'check') { & $taskCargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets }
  else { & $taskCargo $Action --manifest-path src-tauri/Cargo.toml --locked }
  exit $LASTEXITCODE
} finally { Pop-Location }
