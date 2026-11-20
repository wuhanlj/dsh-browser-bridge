#requires -Version 5.1
<#
  Starts the 360 Secure Browser with a remote debugging port so DSH's
  browser_bridge can drive the sites assigned to it (for example
  www.qianwen.com and chat.deepseek.com).

  Behaviour mirrors start-chrome.ps1:
    1. Debug port already listening -> open the page there, no second instance.
    2. Same profile running without the port -> ask to close it, or use -Force.
    3. Otherwise launch the browser with the dedicated profile.

  Parameters:
    -Url        Page to open after launch; default https://www.qianwen.com/
    -Port       Debug port, default 9223 (match cdpEndpoint in cordis.patch.yml)
    -ProfileDir Dedicated user data dir, default %USERPROFILE%\360-ai-profile
    -NoOpen     Start/check only, do not open a page
    -Force      Kill browsers holding the dedicated profile, then restart
#>
[CmdletBinding()]
param(
    [string]$Url = 'https://www.qianwen.com/',
    [int]$Port = 9223,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '360-ai-profile'),
    [switch]$NoOpen,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$endpoint = "http://127.0.0.1:$Port/json/version"

function Write-Step([string]$Message) { Write-Host "[bridge-360] $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "[bridge-360] $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "[bridge-360] $Message" -ForegroundColor Red }

function Get-CdpInfo {
    try {
        $response = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { return ($response.Content | ConvertFrom-Json) }
    } catch { }
    return $null
}

function Find-360Browser {
    $candidates = @()

    # Prefer the registry: it records the real install location, wherever it is.
    $uninstallKeys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entries = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like '360*' -and $_.InstallLocation }
    foreach ($entry in $entries) {
        $candidates += (Join-Path $entry.InstallLocation 'new_360se.exe')
        $candidates += (Join-Path $entry.InstallLocation '360se.exe')
        $candidates += (Join-Path (Split-Path -Parent $entry.InstallLocation) 'Application\new_360se.exe')
    }

    $candidates += @(
        (Join-Path $env:ProgramFiles '360\360se6\Application\new_360se.exe')
        (Join-Path ${env:ProgramFiles(x86)} '360\360se6\Application\new_360se.exe')
        (Join-Path $env:LOCALAPPDATA '360se6\Application\new_360se.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }

    # Last resort: look for new_360se.exe under the root of each fixed drive.
    foreach ($drive in Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue) {
        if ($drive.Root -notmatch '^[A-Za-z]:\\$') { continue }
        $found = Get-ChildItem -LiteralPath $drive.Root -Filter 'new_360se.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
        if ($found) { return $found }
    }
    return $null
}

function Get-ProfileBrowsers {
    Get-CimInstance Win32_Process -Filter "Name='new_360se.exe' OR Name='360se.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
}

$browser = Find-360Browser
if (-not $browser) {
    Write-Err '360 browser not found. Install 360 Secure Browser first.'
    exit 1
}
Write-Step "Browser executable: $browser"

$profileArg = '--user-data-dir="' + $ProfileDir + '"'

$info = Get-CdpInfo
if ($info) {
    Write-Step ("Debug port {0} is already listening: {1}" -f $Port, $info.Browser)
    if (-not $NoOpen -and $Url) {
        Start-Process -FilePath $browser -ArgumentList @($profileArg, $Url)
        Write-Step "Opened $Url in the existing 360 window."
    }
    Write-Step 'Ready: sites routed to this endpoint can be driven now.'
    exit 0
}

$running = @(Get-ProfileBrowsers)
if ($running.Count -gt 0) {
    if (-not $Force) {
        Write-Warn 'A 360 browser using the dedicated profile is running without the debug port.'
        Write-Warn 'Close it and run this launcher again, or rerun with -Force (open tabs will be lost).'
        foreach ($process in $running) {
            Write-Warn ("  PID {0}" -f $process.ProcessId)
        }
        exit 2
    }
    Write-Warn 'Closing 360 browsers that hold the dedicated profile...'
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

Write-Step "Starting 360 browser..."
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
    Write-Step 'Ready: sites routed to this endpoint can be driven now.'
    exit 0
}

Write-Err ("Debug port {0} is still not listening after launch." -f $Port)
Write-Err 'Check whether another 360 instance holds the profile, or retry with -Force.'
exit 3
