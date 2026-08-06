param(
  [string]$ArtifactsDir = "",
  [string]$Version = "",
  [string]$NotesFile = "",
  [string]$MinSupportedVersion = "",
  [switch]$Force,
  [string]$ServerHost = "124.174.46.12",
  [string]$ServerUser = "root",
  [int]$ServerPort = 22
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if (-not $ArtifactsDir) { $ArtifactsDir = Join-Path $projectRoot 'dist' }
if (-not $NotesFile) { $NotesFile = Join-Path $projectRoot 'release-notes.txt' }

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Invalid version: $Version"
}

$workingRoot = Join-Path $projectRoot '.update-staging'
$releaseStage = Join-Path $workingRoot $Version
$manifestPath = Join-Path $projectRoot 'dist\update-release\latest.json'
$archivePath = Join-Path $workingRoot "ProductOperationReport-update-$Version.zip"
$remoteArchive = "/tmp/ProductOperationReport-update-$Version.zip"
$remoteStage = "/tmp/ProductOperationReport-update-$Version"
$scp = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"

if (-not (Test-Path -LiteralPath $scp) -or -not (Test-Path -LiteralPath $ssh)) {
  throw 'Windows OpenSSH is required to upload the update release.'
}

try {
  if (Test-Path -LiteralPath $workingRoot) {
    $resolvedWorking = (Resolve-Path $workingRoot).Path
    if (-not $resolvedWorking.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean a path outside the project: $resolvedWorking"
    }
    Remove-Item -LiteralPath $workingRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $releaseStage -Force | Out-Null

  $prepareArgs = @(
    (Join-Path $projectRoot 'scripts\prepare-update-release.cjs'),
    '--version', $Version,
    '--artifacts-dir', (Resolve-Path $ArtifactsDir).Path,
    '--notes-file', (Resolve-Path $NotesFile).Path,
    '--output', $manifestPath
  )
  if ($MinSupportedVersion) { $prepareArgs += @('--min-supported-version', $MinSupportedVersion) }
  if ($Force) { $prepareArgs += '--force' }

  & node @prepareArgs
  if ($LASTEXITCODE -ne 0) { throw "Update manifest preparation failed with exit code $LASTEXITCODE" }

  $files = @(
    "Product-Operation-Report-Windows-$Version-x64-Setup.exe",
    "Product-Operation-Report-macOS-$Version-arm64.dmg",
    "Product-Operation-Report-macOS-$Version-x64.dmg"
  )
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $releaseStage 'latest.json')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\deploy-update-release.sh') -Destination $releaseStage
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path (Resolve-Path $ArtifactsDir).Path $file) -Destination $releaseStage
  }

  Compress-Archive -Path (Join-Path $releaseStage '*') -DestinationPath $archivePath -CompressionLevel Optimal

  Write-Host 'STEP 1/2: Uploading three installers. Enter the server password.' -ForegroundColor Cyan
  & $scp -P $ServerPort $archivePath "${ServerUser}@${ServerHost}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "Upload failed with exit code $LASTEXITCODE" }

  Write-Host 'STEP 2/2: Verifying SHA256 and publishing atomically. Enter the password again.' -ForegroundColor Yellow
  $remoteCommand = "set +e; rm -rf -- '$remoteStage'; mkdir -p -- '$remoteStage'; unzip -q '$remoteArchive' -d '$remoteStage'; rc=`$?; if [ `$rc -eq 0 ]; then bash '$remoteStage/deploy-update-release.sh'; rc=`$?; fi; rm -f -- '$remoteArchive'; rm -rf -- '$remoteStage'; exit `$rc"
  & $ssh -tt -p $ServerPort "${ServerUser}@${ServerHost}" $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw "Server deployment failed with exit code $LASTEXITCODE" }

  $endpoint = "https://update.dadaozixun.com/api/update/latest?app_name=ProductOperationReport"
  $published = Invoke-RestMethod -Uri $endpoint -Method Get -TimeoutSec 30
  if ([string]$published.app_name -ne 'ProductOperationReport' -or [string]$published.version -ne $Version) {
    throw 'The public update endpoint returned an unexpected app_name or version.'
  }

  Write-Host "Update published: ProductOperationReport $Version" -ForegroundColor Green
  Write-Host "Public config: $endpoint"
  Write-Host "Local manifest: $manifestPath"
} finally {
  if (Test-Path -LiteralPath $workingRoot) {
    $resolvedWorking = (Resolve-Path $workingRoot).Path
    if ($resolvedWorking.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $workingRoot -Recurse -Force
    }
  }
}
