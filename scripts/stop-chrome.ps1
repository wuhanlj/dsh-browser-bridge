#requires -Version 5.1
<#
  Closes the dedicated bridge browser (use when the debug port is missing or busy).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-chrome.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE 'chrome-ai-profile')
)

$ErrorActionPreference = 'Stop'

$targets = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })

if ($targets.Count -eq 0) {
    Write-Host "[bridge] No browser process is using $ProfileDir." -ForegroundColor Yellow
    exit 0
}

foreach ($process in $targets) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host ("[bridge] Closed {0} bridge browser process(es)." -f $targets.Count) -ForegroundColor Green
Write-Host "[bridge] Port $Port released; double-click Start-Browser-Bridge.cmd to relaunch with debugging."
