[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Backup', 'Restore')][string]$Action,
    [string]$MigrationId,
    [string]$TestWorkspace
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Assert-SafePath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Absolute path required.' }
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while ($cursor) {
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected.' }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-RelativePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::IsPathRooted($Path)) { throw 'Invalid relative path.' }
    foreach ($part in $Path.Split('\')) {
        if (($part -eq '') -or ($part -eq '.') -or ($part -eq '..') -or ($part -match '[<>:"/|?*\x00-\x1f]') -or
            ($part -match '[. ]$') -or ($part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)')) {
            throw 'Invalid relative path.'
        }
    }
}

function Join-SafePath([string]$Root, [string]$Relative) {
    Assert-RelativePath $Relative
    $full = Assert-SafePath (Join-Path $Root $Relative)
    if (-not $full.StartsWith(($Root.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped root.' }
    return $full
}

function Get-Sha256([string]$Path) {
    Assert-SafePath $Path | Out-Null
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-AtomicJson([string]$Path, $Value) {
    Assert-SafePath $Path | Out-Null
    $temporary = Assert-SafePath ($Path + '.tmp')
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    # Immutable state records avoid replacing a verified manifest during recovery.
    [IO.File]::Move($temporary, $Path)
}

function Assert-Fields($Object, [string[]]$Fields) {
    if ($null -eq $Object) { throw 'Missing manifest object.' }
    $names = @($Object.PSObject.Properties.Name | Sort-Object)
    if (($names -join '|') -cne (($Fields | Sort-Object) -join '|')) { throw 'Invalid manifest fields.' }
}

function Get-Inventory([string]$Root) {
    $entries = New-Object 'Collections.Generic.List[object]'
    $directories = New-Object 'Collections.Generic.Queue[string]'
    Assert-SafePath $Root | Out-Null
    if (-not [IO.Directory]::Exists($Root)) { throw 'Profile root is not a directory.' }
    $directories.Enqueue($Root)
    while ($directories.Count -gt 0) {
        $directory = $directories.Dequeue()
        foreach ($item in (New-Object IO.DirectoryInfo($directory)).GetFileSystemInfos()) {
            Assert-SafePath $item.FullName | Out-Null
            $relative = $item.FullName.Substring($Root.Length + 1)
            Assert-RelativePath $relative
            if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $entries.Add([pscustomobject]@{ Kind = 'Directory'; Path = $relative; Length = 0; Sha256 = '' })
                $directories.Enqueue($item.FullName)
            } else {
                $entries.Add([pscustomobject]@{ Kind = 'File'; Path = $relative; Length = [long]$item.Length; Sha256 = (Get-Sha256 $item.FullName) })
            }
        }
    }
    return ,$entries.ToArray()
}

function Assert-Inventory($Expected, $Actual) {
    if ($Expected.Count -ne $Actual.Count) { throw 'Profile inventory changed.' }
    $index = @{}
    foreach ($entry in $Actual) { $index[$entry.Path] = $entry }
    foreach ($entry in $Expected) {
        if (-not $index.ContainsKey($entry.Path)) { throw 'Missing profile entry.' }
        $other = $index[$entry.Path]
        if (($entry.Kind -cne $other.Kind) -or ($entry.Length -ne $other.Length) -or ($entry.Sha256 -cne $other.Sha256)) {
            throw 'Profile verification failed.'
        }
    }
}

function Get-MigrationPath([string]$Id) {
    if ($Id -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid migration ID.' }
    return Join-SafePath $script:backupBase $Id
}

function Read-VerifiedManifest([string]$Id) {
    $backup = Get-MigrationPath $Id
    $manifestPath = Join-SafePath $backup 'manifest.json'
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    Assert-Fields $manifest @('SchemaVersion', 'Id', 'Status', 'HelperSha256', 'Roots')
    if (($manifest.SchemaVersion -ne 1) -or ($manifest.Id -cne $Id) -or ($manifest.Status -cne 'Ready') -or
        ($manifest.HelperSha256 -cnotmatch '^[a-f0-9]{64}$') -or ($manifest.Roots -isnot [array]) -or ($manifest.Roots.Count -ne 6)) {
        throw 'Invalid migration manifest.'
    }
    if ((Get-Sha256 (Join-SafePath $backup 'session-migration.ps1')) -cne $manifest.HelperSha256) { throw 'Recovery helper verification failed.' }
    $data = Join-SafePath $backup 'data'
    $seen = @{}
    $presentCount = 0
    foreach ($root in $manifest.Roots) {
        Assert-Fields $root @('Id', 'Exists', 'Entries')
        if (($root.Id -isnot [string]) -or (-not $script:rootPaths.ContainsKey($root.Id)) -or $seen.ContainsKey($root.Id) -or
            ($root.Exists -isnot [bool]) -or ($root.Entries -isnot [array])) { throw 'Invalid profile root.' }
        $seen[$root.Id] = $true
        $paths = @{}
        foreach ($entry in $root.Entries) {
            Assert-Fields $entry @('Kind', 'Path', 'Length', 'Sha256')
            if (($entry.Path -isnot [string]) -or ($entry.Kind -cnotin @('File', 'Directory'))) { throw 'Invalid profile entry.' }
            Assert-RelativePath $entry.Path
            if ($paths.ContainsKey($entry.Path)) { throw 'Duplicate profile entry.' }
            $paths[$entry.Path] = $entry.Kind
            if (($entry.Length -isnot [int] -and $entry.Length -isnot [long]) -or ($entry.Length -lt 0)) { throw 'Invalid file length.' }
            if ($entry.Kind -ceq 'File') {
                if ($entry.Sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid file hash.' }
            } elseif (($entry.Length -ne 0) -or ($entry.Sha256 -cne '')) { throw 'Invalid directory entry.' }
        }
        foreach ($entry in $root.Entries) {
            $parent = [IO.Path]::GetDirectoryName($entry.Path)
            if ($parent -and ((-not $paths.ContainsKey($parent)) -or ($paths[$parent] -cne 'Directory'))) { throw 'Missing parent directory.' }
        }
        $payload = Join-SafePath $data $root.Id
        if ($root.Exists) {
            $presentCount++
            Assert-Inventory $root.Entries (Get-Inventory $payload)
        } elseif (($root.Entries.Count -ne 0) -or (Test-Path -LiteralPath $payload)) { throw 'Unexpected absent root data.' }
    }
    if (@(Get-ChildItem -LiteralPath $data -Force).Count -ne $presentCount) { throw 'Unexpected backup payload.' }
    return $manifest
}

function Clear-Pending([string]$Id) {
    $path = Join-SafePath $script:backupBase 'pending.json'
    if (Test-Path -LiteralPath $path) {
        $pending = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        Assert-Fields $pending @('Id')
        if ($pending.Id -ceq $Id) { [IO.File]::Delete($path) }
    }
}

function Get-CompletionPath([string]$Id) {
    Get-MigrationPath $Id | Out-Null
    return Join-SafePath (Join-SafePath $script:backupBase 'completed') ($Id + '.json')
}

function Remove-CompletedBackup([string]$Id) {
    $backup = Get-MigrationPath $Id
    if (-not [IO.Directory]::Exists($backup)) { return }
    # Check the entire tree without following links before removing this fixed-ID child.
    $directories = New-Object 'Collections.Generic.Queue[string]'
    $directories.Enqueue($backup)
    while ($directories.Count -gt 0) {
        foreach ($item in (New-Object IO.DirectoryInfo($directories.Dequeue())).GetFileSystemInfos()) {
            Assert-SafePath $item.FullName | Out-Null
            if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { $directories.Enqueue($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $backup -Recurse -Force
}

function Restore-Profile([string]$Id) {
    $completedPath = Get-CompletionPath $Id
    if (Test-Path -LiteralPath $completedPath) {
        $completed = [IO.File]::ReadAllText($completedPath) | ConvertFrom-Json
        Assert-Fields $completed @('Id')
        if ($completed.Id -cne $Id) { throw 'Invalid completion marker.' }
        Clear-Pending $Id
        Remove-CompletedBackup $Id
        return
    }
    # Verify every backup before the first write to any live profile.
    $manifest = Read-VerifiedManifest $Id
    foreach ($root in $manifest.Roots) {
        $target = Assert-SafePath $script:rootPaths[$root.Id]
        if ((Test-Path -LiteralPath $target) -and (-not [IO.Directory]::Exists($target))) { throw 'Destination root collision.' }
        foreach ($entry in $root.Entries) {
            $path = Join-SafePath $target $entry.Path
            if (Test-Path -LiteralPath $path) {
                $item = Get-Item -LiteralPath $path -Force
                if (($entry.Kind -ceq 'Directory') -ne [bool]$item.PSIsContainer) { throw 'Destination entry collision.' }
                if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { throw 'Read-only destination.' }
            }
        }
    }
    $data = Join-SafePath (Get-MigrationPath $Id) 'data'
    foreach ($root in $manifest.Roots) {
        if (-not $root.Exists) { continue }
        $target = Assert-SafePath $script:rootPaths[$root.Id]
        [IO.Directory]::CreateDirectory($target) | Out-Null
        $source = Join-SafePath $data $root.Id
        foreach ($entry in @($root.Entries | Sort-Object { $_.Path.Length })) {
            $path = Join-SafePath $target $entry.Path
            if ($entry.Kind -ceq 'Directory') { [IO.Directory]::CreateDirectory($path) | Out-Null }
            else { [IO.File]::Copy((Join-SafePath $source $entry.Path), $path, $true) }
        }
    }
    foreach ($root in $manifest.Roots) {
        if (-not $root.Exists) { continue }
        foreach ($entry in $root.Entries) {
            $path = Join-SafePath $script:rootPaths[$root.Id] $entry.Path
            if ($entry.Kind -ceq 'File') {
                if (((Get-Item -LiteralPath $path -Force).Length -ne $entry.Length) -or ((Get-Sha256 $path) -cne $entry.Sha256)) { throw 'Restored file verification failed.' }
            } elseif (-not [IO.Directory]::Exists($path)) { throw 'Restored directory missing.' }
        }
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($completedPath)) | Out-Null
    Write-AtomicJson $completedPath ([pscustomobject]@{ Id = $Id })
    Clear-Pending $Id
    Remove-CompletedBackup $Id
}

function Backup-Profile {
    $pendingPath = Join-SafePath $script:backupBase 'pending.json'
    if (Test-Path -LiteralPath $pendingPath) {
        $pending = [IO.File]::ReadAllText($pendingPath) | ConvertFrom-Json
        Assert-Fields $pending @('Id')
        Restore-Profile $pending.Id
    }
    $id = [guid]::NewGuid().ToString('N')
    $backup = Get-MigrationPath $id
    $data = Join-SafePath $backup 'data'
    [IO.Directory]::CreateDirectory($data) | Out-Null
    $recoveryHelper = Join-SafePath $backup 'session-migration.ps1'
    [IO.File]::Copy($script:helperPath, $recoveryHelper, $false)
    $recoveryInstructions = @'
StudyPilot profile recovery
Migration ID: @ID@

Use the same Windows account that uses StudyPilot. Open Windows PowerShell as that user, not as a different administrator.
Close StudyPilot. Do not launch StudyPilot until restoration succeeds.
Keep this entire backup directory, including manifest.json and session-migration.ps1, if recovery fails.

Run this command in Windows PowerShell 5.1:
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'StudyPilotUpgradeBackup\@ID@\session-migration.ps1') -Action Restore -MigrationId '@ID@'

The command restores only StudyPilot's six fixed profile directories for the current Windows account.
If the initial backup did not complete, or restoration still fails, keep the backup and rerun the installer before launching StudyPilot.
Successful restoration verifies every restored file before removing this credential backup directory.
'@
    [IO.File]::WriteAllText((Join-SafePath $backup 'recovery.txt'), $recoveryInstructions.Replace('@ID@', $id), (New-Object Text.UTF8Encoding($false)))
    $roots = New-Object 'Collections.Generic.List[object]'
    foreach ($mapping in $script:rootMappings) {
        $source = Assert-SafePath $mapping.Path
        $exists = Test-Path -LiteralPath $source
        $entries = @()
        if ($exists) {
            $entries = Get-Inventory $source
            $destination = Join-SafePath $data $mapping.Id
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            foreach ($entry in @($entries | Sort-Object { $_.Path.Length })) {
                $path = Join-SafePath $destination $entry.Path
                if ($entry.Kind -ceq 'Directory') { [IO.Directory]::CreateDirectory($path) | Out-Null }
                else { [IO.File]::Copy((Join-SafePath $source $entry.Path), $path, $false) }
            }
            Assert-Inventory $entries (Get-Inventory $destination)
            Assert-Inventory $entries (Get-Inventory $source)
        }
        $roots.Add([pscustomobject]@{ Id = $mapping.Id; Exists = [bool]$exists; Entries = [object[]]$entries })
    }
    $manifest = [pscustomobject]@{ SchemaVersion = 1; Id = $id; Status = 'Ready'; HelperSha256 = (Get-Sha256 $recoveryHelper); Roots = [object[]]$roots.ToArray() }
    Write-AtomicJson (Join-SafePath $backup 'manifest.json') $manifest
    Read-VerifiedManifest $id | Out-Null
    # This marker is published only after all six roots and all copied bytes verify.
    Write-AtomicJson $pendingPath ([pscustomobject]@{ Id = $id })
    return $id
}

try {
    if (($Action -ceq 'Restore') -and ($MigrationId -cnotmatch '^[a-f0-9]{32}$')) { throw 'Invalid migration ID.' }
    if (($Action -ceq 'Backup') -and $MigrationId) { throw 'Backup chooses its own migration ID.' }
    $script:helperPath = Assert-SafePath $PSCommandPath
    if ($TestWorkspace) {
        $workspace = Assert-SafePath $TestWorkspace
        $tempRoot = (Assert-SafePath ([IO.Path]::GetTempPath())).TrimEnd('\')
        if (([IO.Path]::GetDirectoryName($workspace) -ine $tempRoot) -or
            ([IO.Path]::GetFileName($workspace) -cnotmatch '^StudyPilotMigrationTests-[a-f0-9]{32}$') -or (-not [IO.Directory]::Exists($workspace))) {
            throw 'Test root must be a generated TEMP fixture.'
        }
        $roaming = Join-SafePath $workspace 'AppData'
        $local = Join-SafePath $workspace 'LocalAppData'
    } else {
        $roaming = Assert-SafePath ([Environment]::GetFolderPath('ApplicationData'))
        $local = Assert-SafePath ([Environment]::GetFolderPath('LocalApplicationData'))
    }
    $legacyName = -join ([char[]]@(0x5b66, 0x4e60, 0x901a, 0x7b54, 0x9898, 0x8f85, 0x52a9, 0x5de5, 0x5177))
    $script:rootMappings = @(
        [pscustomobject]@{ Id = 'roaming-study-pilot'; Path = (Join-SafePath $roaming 'study-pilot') },
        [pscustomobject]@{ Id = 'roaming-legacy'; Path = (Join-SafePath $roaming $legacyName) },
        [pscustomobject]@{ Id = 'local-study-pilot'; Path = (Join-SafePath $local 'study-pilot') },
        [pscustomobject]@{ Id = 'local-legacy'; Path = (Join-SafePath $local $legacyName) },
        [pscustomobject]@{ Id = 'local-app-id'; Path = (Join-SafePath $local 'com.studypilot.desktop') },
        [pscustomobject]@{ Id = 'roaming-app-id'; Path = (Join-SafePath $roaming 'com.studypilot.desktop') }
    )
    $script:rootPaths = @{}
    foreach ($mapping in $script:rootMappings) { $script:rootPaths[$mapping.Id] = $mapping.Path }
    $script:backupBase = Join-SafePath $local 'StudyPilotUpgradeBackup'
    if ($Action -ceq 'Backup') {
        [IO.Directory]::CreateDirectory($script:backupBase) | Out-Null
        Backup-Profile
    } else { Restore-Profile $MigrationId }
} catch {
    # File names, cookies, database values and exception contents must never reach installer logs.
    throw 'StudyPilot profile migration failed. Close the app and retry; recovery backups are retained in LocalAppData\StudyPilotUpgradeBackup.'
}
