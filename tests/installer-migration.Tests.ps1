[CmdletBinding()]
param([switch]$CompileNsis)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '..\build\session-migration.ps1'
if (-not (Test-Path -LiteralPath $helper)) { throw 'Missing session migration helper.' }
$script:passed = 0
$profileNames = @('study-pilot', ([string][char]0x5b66 + [char]0x4e60 + [char]0x901a + [char]0x7b54 + [char]0x9898 + [char]0x8f85 + [char]0x52a9 + [char]0x5de5 + [char]0x5177), 'com.studypilot.desktop')

function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Unsafe migration was accepted.'
}
function New-Fixture {
    $path = Join-Path ([IO.Path]::GetTempPath()) ('StudyPilotMigrationTests-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($path) | Out-Null
    return $path
}
function Get-ProfileRoots([string]$Workspace) {
    foreach ($base in @('AppData', 'LocalAppData')) {
        foreach ($name in $profileNames) { Join-Path (Join-Path $Workspace $base) $name }
    }
}
function Seed-Profiles([string]$Workspace) {
    foreach ($root in @(Get-ProfileRoots $Workspace)) {
        foreach ($relative in @('Local State', 'Cookies', 'Partitions\persist-study\Network\Cookies', 'IndexedDB\data.leveldb\000003.log')) {
            $file = Join-Path $root $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
            [IO.File]::WriteAllBytes($file, [byte[]](0, 1, 2, 127, 128, 254, 255))
        }
        [IO.Directory]::CreateDirectory((Join-Path $root 'empty')) | Out-Null
        [IO.File]::SetAttributes((Join-Path $root 'Local State'), [IO.FileAttributes]::Hidden)
    }
}
function Get-Backup([string]$Workspace, [string]$Id) {
    Join-Path (Join-Path (Join-Path $Workspace 'LocalAppData') 'StudyPilotUpgradeBackup') $Id
}
function Remove-FakeProfiles([string]$Workspace) {
    foreach ($root in @(Get-ProfileRoots $Workspace)) {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    }
}
function Read-Manifest([string]$Backup) {
    Get-Content -LiteralPath (Join-Path $Backup 'manifest.json') -Raw | ConvertFrom-Json
}
function Write-Manifest([string]$Backup, $Manifest) {
    [IO.File]::WriteAllText((Join-Path $Backup 'manifest.json'), ($Manifest | ConvertTo-Json -Depth 12))
}
function Assert-RecoveryInstructions([string]$Backup, [string]$Id) {
    $path = Join-Path $Backup 'recovery.txt'
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) 'Recovery instructions missing.'
    $instructions = [IO.File]::ReadAllText($path)
    Assert-True ($instructions.Contains('Migration ID: ' + $Id)) 'Recovery instructions have the wrong ID.'
    Assert-True ($instructions.Contains('same Windows account')) 'Current-user recovery guidance missing.'
    Assert-True ($instructions.Contains('Do not launch StudyPilot until restoration succeeds.')) 'Launch protection guidance missing.'
    $command = [regex]::Match($instructions, '(?m)^& .+$').Value.TrimEnd("`r")
    Assert-True ($command.StartsWith('& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ')) 'Recovery must use Windows PowerShell 5.1.'
    Assert-True ($command.Contains("(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'StudyPilotUpgradeBackup\" + $Id + "\session-migration.ps1')")) 'Recovery helper path is not fixed to the current user.'
    Assert-True ($command.EndsWith("-Action Restore -MigrationId '" + $Id + "'")) 'Recovery command has the wrong action or ID.'
    Assert-True (-not $command.Contains('TestWorkspace')) 'Production instructions contain a test override.'
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors) | Out-Null
    Assert-True ($errors.Count -eq 0) 'Recovery command is not valid PowerShell.'
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    $workspace = New-Fixture
    try {
        & $Body $workspace
        $script:passed++
        Write-Output ('PASS ' + $Name)
    } finally {
        # The fixture is generated directly under TEMP; never remove caller-provided paths.
        $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if (([IO.Path]::GetDirectoryName($workspace) -eq $expectedParent) -and ([IO.Path]::GetFileName($workspace) -match '^StudyPilotMigrationTests-[a-f0-9]{32}$')) {
            Remove-Item -LiteralPath $workspace -Recurse -Force
        }
    }
}

Test-Case 'all six profiles and complete Chromium state survive the old uninstaller' {
    param($workspace)
    Seed-Profiles $workspace
    $id = & $helper -Action Backup -TestWorkspace $workspace
    Assert-True ($id -match '^[a-f0-9]{32}$') 'Backup did not return a safe migration ID.'
    $backup = Get-Backup $workspace $id
    $manifest = Read-Manifest $backup
    Assert-True ($manifest.Roots.Count -eq 6) 'Manifest must enumerate six fixed roots.'
    Assert-True (Test-Path -LiteralPath (Join-Path $backup 'session-migration.ps1')) 'Recovery helper missing.'
    Assert-RecoveryInstructions $backup $id
    Remove-FakeProfiles $workspace
    & (Join-Path $backup 'session-migration.ps1') -Action Restore -MigrationId $id -TestWorkspace $workspace
    foreach ($root in @(Get-ProfileRoots $workspace)) {
        foreach ($relative in @('Local State', 'Cookies', 'Partitions\persist-study\Network\Cookies', 'IndexedDB\data.leveldb\000003.log')) {
            Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root $relative))) -eq 'AAECf4D+/w==') 'Profile bytes changed.'
        }
        Assert-True (Test-Path -LiteralPath (Join-Path $root 'empty') -PathType Container) 'Empty directory missing.'
    }
    Assert-True (-not (Test-Path -LiteralPath $backup)) 'Verified credential backup was not pruned.'
    Assert-True (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($backup)) ('completed\' + $id + '.json'))) 'Verified restore was not recorded.'
}

Test-Case 'missing profiles remain absent and empty manifests use arrays' {
    param($workspace)
    $id = & $helper -Action Backup -TestWorkspace $workspace
    $manifest = Read-Manifest (Get-Backup $workspace $id)
    foreach ($root in $manifest.Roots) {
        Assert-True (-not $root.Exists) 'Missing root marked present.'
        Assert-True ($root.Entries -is [array]) 'Entries must always be arrays.'
    }
    & $helper -Action Restore -MigrationId $id -TestWorkspace $workspace
    foreach ($root in @(Get-ProfileRoots $workspace)) { Assert-True (-not (Test-Path -LiteralPath $root)) 'Absent profile created.' }
}

Test-Case 'corrupt backup fails verification before writing any profile' {
    param($workspace)
    Seed-Profiles $workspace
    $id = & $helper -Action Backup -TestWorkspace $workspace
    $backup = Get-Backup $workspace $id
    $file = Get-ChildItem -LiteralPath (Join-Path $backup 'data') -Recurse -File -Force | Select-Object -Last 1
    [IO.File]::WriteAllText($file.FullName, 'damaged')
    Remove-FakeProfiles $workspace
    Assert-Rejected { & $helper -Action Restore -MigrationId $id -TestWorkspace $workspace }
    foreach ($root in @(Get-ProfileRoots $workspace)) { Assert-True (-not (Test-Path -LiteralPath $root)) 'Partial restore occurred before verification.' }
    Assert-True (Test-Path -LiteralPath $backup) 'Backup lost on failure.'
    Assert-RecoveryInstructions $backup $id
    Assert-True (Test-Path -LiteralPath (Join-Path $backup 'session-migration.ps1')) 'Recovery helper lost on failure.'
    Assert-True (Test-Path -LiteralPath (Join-Path $backup 'manifest.json')) 'Manifest lost on failure.'
}

foreach ($attack in @('Traversal', 'UnknownRoot', 'DuplicateEntry', 'ExtraPayload', 'HelperTampering')) {
    Test-Case ('reject ' + $attack) {
        param($workspace)
        Seed-Profiles $workspace
        $id = & $helper -Action Backup -TestWorkspace $workspace
        $backup = Get-Backup $workspace $id
        $manifest = Read-Manifest $backup
        switch ($attack) {
            'Traversal' { $manifest.Roots[0].Entries[0].Path = '..\escaped' }
            'UnknownRoot' { $manifest.Roots[0].Id = 'arbitrary-output-directory' }
            'DuplicateEntry' { $manifest.Roots[0].Entries += $manifest.Roots[0].Entries[0] }
            'ExtraPayload' { [IO.File]::WriteAllText((Join-Path $backup 'data\unexpected'), 'extra') }
            'HelperTampering' { [IO.File]::AppendAllText((Join-Path $backup 'session-migration.ps1'), '#changed') }
        }
        Write-Manifest $backup $manifest
        Remove-FakeProfiles $workspace
        Assert-Rejected { & $helper -Action Restore -MigrationId $id -TestWorkspace $workspace }
        foreach ($root in @(Get-ProfileRoots $workspace)) { Assert-True (-not (Test-Path -LiteralPath $root)) 'Unsafe restore wrote a profile.' }
    }
}

Test-Case 'unfinished restore recovers before the next backup and restore is idempotent' {
    param($workspace)
    Seed-Profiles $workspace
    $first = & $helper -Action Backup -TestWorkspace $workspace
    Remove-FakeProfiles $workspace
    $second = & $helper -Action Backup -TestWorkspace $workspace
    Assert-True ($first -ne $second) 'New backup reused a prior migration.'
    Assert-True (-not (Test-Path -LiteralPath (Get-Backup $workspace $first))) 'Recovered credential backup was not pruned.'
    & $helper -Action Restore -MigrationId $second -TestWorkspace $workspace
    $cookie = Join-Path (@(Get-ProfileRoots $workspace)[0]) 'Cookies'
    [IO.File]::WriteAllText($cookie, 'new login after installation')
    & $helper -Action Restore -MigrationId $second -TestWorkspace $workspace
    Assert-True ([IO.File]::ReadAllText($cookie) -eq 'new login after installation') 'Repeated restore overwrote newer state.'
}

Test-Case 'locked source aborts backup without a ready migration' {
    param($workspace)
    Seed-Profiles $workspace
    $cookie = Join-Path (@(Get-ProfileRoots $workspace)[0]) 'Cookies'
    $lock = [IO.File]::Open($cookie, 'Open', 'ReadWrite', 'None')
    try { Assert-Rejected { & $helper -Action Backup -TestWorkspace $workspace } } finally { $lock.Dispose() }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path (Join-Path $workspace 'LocalAppData\StudyPilotUpgradeBackup') 'pending.json'))) 'Failed backup became ready.'
}

Test-Case 'source junction is rejected without following it' {
    param($workspace)
    Seed-Profiles $workspace
    $outside = Join-Path $workspace 'outside'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $junction = Join-Path (@(Get-ProfileRoots $workspace)[0]) 'linked'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    try { Assert-Rejected { & $helper -Action Backup -TestWorkspace $workspace } } finally { [IO.Directory]::Delete($junction) }
}

Test-Case 'destination junction blocks restore and retains backup' {
    param($workspace)
    Seed-Profiles $workspace
    $id = & $helper -Action Backup -TestWorkspace $workspace
    Remove-FakeProfiles $workspace
    $outside = Join-Path $workspace 'outside'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $root = @(Get-ProfileRoots $workspace)[0]
    New-Item -ItemType Junction -Path $root -Target $outside | Out-Null
    try {
        Assert-Rejected { & $helper -Action Restore -MigrationId $id -TestWorkspace $workspace }
        Assert-True (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'Restore followed a junction.'
    } finally { [IO.Directory]::Delete($root) }
}

Assert-Rejected { & $helper -Action Backup -TestWorkspace $PSScriptRoot }
Assert-Rejected { & $helper -Action Restore -MigrationId '..\escape' }

if ($CompileNsis) {
    $compiler = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis\nsis-3.0.4.1\Bin\makensis.exe'
    $pluginFile = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis-resources-3.4.1') -Recurse -Filter StdUtils.dll | Where-Object { $_.Directory.Name -eq 'x86-unicode' } | Select-Object -First 1
    $plugins = $pluginFile.DirectoryName
    $project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $templates = Join-Path $project 'node_modules\app-builder-lib\templates\nsis'
    Assert-True (Test-Path -LiteralPath $compiler) 'Cached NSIS compiler missing.'
    Assert-True (Test-Path -LiteralPath $plugins) 'Cached NSIS plugins missing.'
    foreach ($mode in @('Installer', 'Uninstaller')) {
        Test-Case ('NSIS ' + $mode + ' macro compilation') {
            param($workspace)
            $source = @'
Unicode true
!addincludedir "@TEMPLATES@"
!addincludedir "@TEMPLATES@\include"
!addplugindir /x86-unicode "@PLUGINS@"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
!include "UAC.nsh"
!define BUILD_RESOURCES_DIR "@PROJECT@\build"
!define APP_EXECUTABLE_FILENAME "StudyPilot.exe"
!define PRODUCT_NAME "StudyPilot migration compile test"
!define APP_GUID "StudyPilotMigrationCompileTest"
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
@MODE_DEFINE@
!include "@PROJECT@\build\installer.nsh"
!include "allowOnlyOneInstallerInstance.nsh"
Name "StudyPilot migration compile test"
OutFile "@OUTPUT@"
RequestExecutionLevel user
Var installMode
LangString appRunning 1033 "App running"
LangString appCannotBeClosed 1033 "App cannot be closed"
!ifmacrodef customHeader
  !insertmacro customHeader
!endif
@SECTIONS@
'@
            if ($mode -eq 'Installer') {
                $modeDefine = ''
                $sections = @'
Function .onInit
  !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
  !insertmacro customInit
FunctionEnd
Section
  InitPluginsDir
  !insertmacro CHECK_APP_RUNNING
  !insertmacro customInstall
SectionEnd
'@
            } else {
                $modeDefine = "!define BUILD_UNINSTALLER`r`n!define DELETE_APP_DATA_ON_UNINSTALL"
                $sections = @'
Function un.onInit
  !insertmacro customUnInit
FunctionEnd
Section
  WriteUninstaller "$TEMP\StudyPilotMigrationCompileTest.exe"
SectionEnd
Section "Uninstall"
  !insertmacro CHECK_APP_RUNNING
  !insertmacro customRemoveFiles
  !insertmacro customUnInstall
SectionEnd
!ifdef DELETE_APP_DATA_ON_UNINSTALL
  !error "Default data cleanup bypasses the retention guard."
!endif
'@
            }
            $source = $source.Replace('@TEMPLATES@', $templates).Replace('@PLUGINS@', $plugins).Replace('@PROJECT@', $project).Replace('@MODE_DEFINE@', $modeDefine).Replace('@SECTIONS@', $sections).Replace('@OUTPUT@', (Join-Path $workspace 'compile-only.exe'))
            $scriptPath = Join-Path $workspace 'compile-only.nsi'
            [IO.File]::WriteAllText($scriptPath, $source, (New-Object Text.UTF8Encoding($false)))
            $output = & $compiler /V2 /INPUTCHARSET UTF8 $scriptPath 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
        }
    }
}
Write-Output ('Passed ' + $script:passed + ' migration cases plus argument guards.')
