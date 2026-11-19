#requires -Version 5.1
<#
  One-click launcher: starts Chrome with a remote debugging port for DSH's
  browser_bridge tool.

  Behaviour:
    1. Debug port already listening -> open the chat page there, do not start
       a second browser instance.
    2. A browser using the same dedicated profile is running without the debug
       port -> ask to close it, or restart with -Force.
    3. Otherwise launch Chrome with the dedicated profile (logins persist in
       that profile directory).

  Parameters:
    -Url        Page to open after launch; default https://chatgpt.com/ ("" = none)
    -Port       Debug port, default 9222 (must match cdpEndpoint in cordis.patch.yml)
    -ProfileDir Dedicated user data dir, default %USERPROFILE%\chrome-ai-profile
    -NoOpen     Start/check only, do not open a page
    -Force      Kill browsers that hold the dedicated profile, then restart
#>
[CmdletBinding()]
param(
    [string]$Url = 'https://chatgpt.com/',
    [int]$Port = 9222,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE 'chrome-ai-profile'),
    [switch]$NoOpen,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$endpoint = "http://127.0.0.1:$Port/json/version"

function Write-Step([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "[bridge] $Message" -ForegroundColor Red }

function Get-CdpInfo {
    try {
        $response = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            return ($response.Content | ConvertFrom-Json)
        }
    } catch { }
    return $null
}

function Find-Browser {
    $candidates = @(
        (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)'
        (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)'
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Get-ProfileBrowsers {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
}

$browser = Find-Browser
if (-not $browser) {
    Write-Err 'Chrome or Edge not found. Install a Chromium browser first.'
    exit 1
}

$profileArg = '--user-data-dir="' + $ProfileDir + '"'

$info = Get-CdpInfo
if ($info) {
    Write-Step ("Debug port {0} is already listening: {1}" -f $Port, $info.Browser)
    if (-not $NoOpen -and $Url) {
        Start-Process -FilePath $browser -ArgumentList @($profileArg, $Url)
        Write-Step "Opened $Url in the existing browser."
    }
    Write-Step 'Ready: the DSH browser_bridge tool can be used now.'
    exit 0
}

$running = @(Get-ProfileBrowsers)
if ($running.Count -gt 0) {
    if (-not $Force) {
        Write-Warn 'A browser using the dedicated profile is running without the debug port.'
        Write-Warn 'Close those browser windows and run this launcher again,'
        Write-Warn 'or run it with -Force to restart them (open tabs will be lost).'
        foreach ($process in $running) {
            $commandLine = [string]$process.CommandLine
            if ($commandLine.Length -gt 110) { $commandLine = $commandLine.Substring(0, 110) + '...' }
            Write-Warn ("  PID {0}: {1}" -f $process.ProcessId, $commandLine)
        }
        exit 2
    }
    Write-Warn 'Closing browsers that hold the dedicated profile...'
    foreach ($process in $running) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

if (-not (Test-Path -LiteralPath $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

$launchArgs = @(
    "--remote-debugging-port=$Port"
    $profileArg
    '--no-first-run'
    '--no-default-browser-check'
)
if (-not $NoOpen -and $Url) { $launchArgs += $Url }

Write-Step "Starting browser: $browser"
Start-Process -FilePath $browser -ArgumentList $launchArgs

$deadline = (Get-Date).AddSeconds(25)
$info = $null
while ((Get-Date) -lt $deadline) {
    $info = Get-CdpInfo
    if ($info) { break }
    Start-Sleep -Milliseconds 500
}

if ($info) {
    Write-Step ("Debug port ready: http://127.0.0.1:{0} ({1})" -f $Port, $info.Browser)
    Write-Step 'Ready: the DSH browser_bridge tool can be used now.'
    exit 0
}

Write-Err ("Debug port {0} is still not listening after launch." -f $Port)
Write-Err 'Check whether another browser instance holds the same profile, or retry with -Force.'
exit 3
