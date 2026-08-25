$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'ProductOperationReport v1.0.1 Isolated Staging Deploy'

$archive = Join-Path $PSScriptRoot 'ProductOperationReport-staging-v101.tar.gz'
$scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$server = 'root@124.174.46.12'
$remoteArchive = '/tmp/ProductOperationReport-staging-v101.tar.gz'

if (-not (Test-Path -LiteralPath $archive)) { throw "Archive not found: $archive" }
Write-Host 'STEP 1/2: Uploading isolated staging package.' -ForegroundColor Cyan
Write-Host 'Enter the existing root password when prompted.' -ForegroundColor Yellow
& $scp -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new $archive "${server}:${remoteArchive}"
if ($LASTEXITCODE -ne 0) { throw "Upload failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'STEP 2/2: Installing only 127.0.0.1:8796.' -ForegroundColor Cyan
Write-Host 'Enter the same root password once more.' -ForegroundColor Yellow
$remote = "set -e; work=/tmp/por-staging-v101; rm -rf `$work; mkdir -p `$work; tar -xzf $remoteArchive -C `$work; cd `$work; bash staging-v101-install.sh; cd /; rm -rf `$work; rm -f $remoteArchive"
& $ssh -tt -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new $server $remote
if ($LASTEXITCODE -ne 0) { throw "Remote install failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'ISOLATED STAGING DEPLOYMENT COMPLETE.' -ForegroundColor Green
Write-Host 'Formal port 8794 and Nginx were not changed.' -ForegroundColor Green
Read-Host 'Press Enter to close'
