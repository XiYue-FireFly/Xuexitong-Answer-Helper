param(
  [string]$OutputPath = "",
  [int]$Days = 7
)

$ErrorActionPreference = "Stop"

$appData = Join-Path $env:APPDATA "study-pilot"
$logDir = Join-Path $appData "logs"

if (-not (Test-Path $logDir)) {
  Write-Host "No StudyPilot error log directory found: $logDir"
  exit 0
}

$cutoff = (Get-Date).AddDays(-1 * [Math]::Abs($Days))
$logs = Get-ChildItem -Path $logDir -Filter "studypilot-error-*.log" -File |
  Where-Object { $_.LastWriteTime -ge $cutoff } |
  Sort-Object LastWriteTime -Descending

if (-not $logs -or $logs.Count -eq 0) {
  Write-Host "No StudyPilot error logs found in the last $Days days."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "studypilot-error-logs-$stamp.zip"
}

$tempDir = Join-Path $env:TEMP ("studypilot-error-logs-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  foreach ($log in $logs) {
    Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $tempDir $log.Name)
  }

  $summaryPath = Join-Path $tempDir "summary.txt"
  @(
    "StudyPilot error log bundle"
    "Created: $(Get-Date -Format o)"
    "Source: $logDir"
    "Days: $Days"
    "Files:"
  ) + ($logs | ForEach-Object { "- $($_.Name) $($_.Length) bytes $($_.LastWriteTime)" }) |
    Set-Content -Path $summaryPath -Encoding UTF8

  if (Test-Path $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
  }

  Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $OutputPath -Force
  Write-Host "StudyPilot error logs exported to: $OutputPath"
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
