param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'

function Get-Violations([object[]]$Entries) {
  $findings = [System.Collections.Generic.List[string]]::new()
  $privateKeyPattern = '-----BEGIN ' + '(?:RSA |EC |OPENSSH )?' + 'PRIVATE KEY-----'
  foreach ($entry in $Entries) {
    $path = ([string]$entry.Path).Replace('\', '/')
    $content = [string]$entry.Content
    if ($path -match '(^|/)\.secrets/.*\.pem$') {
      $findings.Add("${path}: private PEM files under .secrets are forbidden")
    }
    if ($content -match $privateKeyPattern) {
      $findings.Add("${path}: staged content contains a private-key marker")
    }
    if ($content -match 'sk-[A-Za-z0-9_-]{16,}') {
      $findings.Add("${path}: staged content contains a provider-key pattern")
    }
  }
  return $findings
}

if ($SelfTest) {
  $blocked = @(Get-Violations @(
      [pscustomobject]@{ Path = 'app/.secrets/update.pem'; Content = 'not-secret' },
      [pscustomobject]@{ Path = 'config.txt'; Content = ('-----BEGIN ' + 'PRIVATE KEY-----') },
      [pscustomobject]@{ Path = 'provider.txt'; Content = "sk-$('x' * 20)" }
    ))
  $allowed = @(Get-Violations @([pscustomobject]@{ Path = 'src/updateSignature.ts'; Content = 'PUBLIC KEY' }))
  if ($blocked.Count -ne 3 -or $allowed.Count -ne 0) { throw 'pre-commit secret guard self-test failed' }
  Write-Output 'pre-commit secret guard self-test passed'
  exit 0
}

$entries = [System.Collections.Generic.List[object]]::new()
$paths = @(& git diff --cached --name-only --diff-filter=ACMR)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect staged files.' }
foreach ($path in $paths) {
  if (-not $path) { continue }
  $sizeText = (& git cat-file -s ":$path" 2>$null | Out-String).Trim()
  $size = 0L
  [void][long]::TryParse($sizeText, [ref]$size)
  $content = if ($size -le 8MB) { (& git show ":$path" 2>$null | Out-String) } else { '' }
  $entries.Add([pscustomobject]@{ Path = $path; Content = $content })
}

$findings = @(Get-Violations $entries)
if ($findings.Count) {
  [Console]::Error.WriteLine("Commit blocked by secret guard:`n$($findings -join "`n")")
  exit 1
}
