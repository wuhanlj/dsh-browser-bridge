#requires -Version 5.1
<#
  One-time setup of the browser bridge on a new PC.

  Run inside the extracted plugin folder AFTER copying/extracting it:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1 -SkipNpmInstall   # offline zip
    ... -SkipBuild -SkipShortcut -LaunchChrome                                                     # optional switches

  It installs dependencies (unless skipped), ensures lib/index.js is built,
  verifies playwright-core, creates the desktop shortcut, and prints the
  remaining manual steps (bundle install in DSH + first Chrome launch).
#>
[CmdletBinding()]
param(
    [switch]$SkipNpmInstall,
    [switch]$SkipBuild,
    [switch]$SkipShortcut,
    [switch]$LaunchChrome
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Yellow }

Write-Step "Plugin folder: $repoRoot"

# 1. Dependencies -----------------------------------------------------------
if (-not $SkipNpmInstall) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Warn2 'npm was not found. Install Node.js 20+ (https://nodejs.org),'
        Write-Warn2 'or use the offline package that already contains node_modules,'
        Write-Warn2 'then rerun with -SkipNpmInstall.'
        exit 1
    }
    Write-Step 'Installing dependencies (npm install)...'
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 'npm install failed. Check the network/proxy and try again.'
        exit 1
    }
    Write-Ok 'Dependencies installed.'
} else {
    Write-Step 'Skipping npm install (-SkipNpmInstall).'
}

# 2. Build --------------------------------------------------------------
$libEntry = Join-Path $repoRoot 'lib\index.js'
if (-not $SkipBuild) {
    Write-Step 'Building lib/index.js (npm run build)...'
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'npm run build failed.'; exit 1 }
}
if (-not (Test-Path -LiteralPath $libEntry)) {
    Write-Warn2 'lib/index.js is missing. Run npm install and npm run build.'
    exit 1
}
Write-Ok "Built entry: $libEntry"

# 3. Runtime dependency check -------------------------------------------
$probe = "import('playwright-core').then(()=>{console.log('ok')}).catch(e=>{console.error(e.message);process.exit(1)})"
$probeOutput = & node -e $probe 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 'playwright-core cannot be loaded from this folder:'
    Write-Warn2 ([string]$probeOutput)
    Write-Warn2 'Run npm install (or use the offline package) and retry.'
    exit 1
}
Write-Ok 'playwright-core is available.'

# 4. Desktop shortcut ---------------------------------------------------
if (-not $SkipShortcut) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-shortcuts.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'Shortcut creation failed; you can still use Start-Browser-Bridge.cmd.' }
}

# 5. Chrome ------------------------------------------------------------
if ($LaunchChrome) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-chrome.ps1')
}

# 6. Remaining manual steps --------------------------------------------
Write-Host ''
Write-Step 'Setup finished. Remaining steps on this PC:'
Write-Host '  1) Install the bundle into DSH:' -ForegroundColor White
Write-Host '     - GUI: Settings -> Plugins -> install bundle -> choose this folder'
Write-Host ("       " + $repoRoot)
Write-Host '     - or CLI (Desktop dsh): dsh plugin install "<this folder>"'
Write-Host '  2) Restart DSH if the plugin does not appear immediately.'
Write-Host '  3) Double-click the "AI Bridge Chrome" desktop shortcut.'
Write-Host '  4) Log in to the AI chat site once in that window (the login is stored in'
Write-Host '     %USERPROFILE%\chrome-ai-profile and survives reboots).'
Write-Host '  5) Ask DSH: "use browser_bridge to ask ChatGPT: hello" to verify.'
Write-Host ''
Write-Warn2 'Note: the plugin is installed as a link to this folder - keep it in place.'
Write-Ok 'Done.'
