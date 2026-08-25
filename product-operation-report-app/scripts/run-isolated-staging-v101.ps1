$ErrorActionPreference = 'Stop'
$env:PRODUCT_REPORT_ALLOW_DEV_OVERRIDES = '1'
$env:PRODUCT_REPORT_DEV_AI_PROXY_BASE_URL = 'http://127.0.0.1:18796'
$env:PATH = 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
$pnpm = 'C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
& $pnpm -C (Resolve-Path (Join-Path $PSScriptRoot '..')) start
