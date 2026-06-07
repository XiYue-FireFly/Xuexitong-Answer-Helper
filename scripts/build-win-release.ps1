$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseDir = Join-Path $root 'release'
$packageJsonPath = Join-Path $root 'package.json'
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageJson.version

if (-not $version) {
  throw 'package.json version is empty.'
}

$resolvedReleaseDir = $null
if (Test-Path -LiteralPath $releaseDir) {
  $resolvedReleaseDir = (Resolve-Path -LiteralPath $releaseDir).Path
  $expectedReleaseDir = Join-Path $root 'release'
  if ($resolvedReleaseDir -ne $expectedReleaseDir) {
    throw "Unexpected release directory: $resolvedReleaseDir"
  }
  Remove-Item -LiteralPath $resolvedReleaseDir -Recurse -Force
}

$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

Push-Location $root
try {
  npm run build
  npm run electron:build
  npx electron-builder --win nsis --config.win.signAndEditExecutable=false

  $installer = Get-ChildItem -LiteralPath $releaseDir -Filter "*.exe" |
    Where-Object { $_.Name -like "*Setup*$version*.exe" } |
    Select-Object -First 1

  if (-not $installer) {
    throw "Windows installer for version $version was not found in release/."
  }

  $asarPath = Join-Path $releaseDir 'win-unpacked\resources\app.asar'
  if (-not (Test-Path -LiteralPath $asarPath)) {
    throw "Packaged app.asar was not found: $asarPath"
  }

  $asarList = npx asar list $asarPath
  $requiredEntries = @(
    '\dist\index.html',
    '\dist-electron\main.js',
    '\dist-electron\preload.js',
    '\dist-electron\preload-webview.js'
  )

  foreach ($entry in $requiredEntries) {
    if ($asarList -notcontains $entry) {
      throw "Packaged app.asar is missing required entry: $entry"
    }
  }

  $releaseName = "Xuexitong-Answer-Helper-v$version-win-x64-setup.exe"
  $releaseCopyPath = Join-Path $releaseDir $releaseName
  Copy-Item -LiteralPath $installer.FullName -Destination $releaseCopyPath -Force

  Write-Host "Built installer: $($installer.FullName)"
  Write-Host "Release asset copy: $releaseCopyPath"
}
finally {
  Pop-Location
}
