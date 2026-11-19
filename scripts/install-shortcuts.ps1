#requires -Version 5.1
<#
  Creates the one-click shortcut.

  Usage (from the plugin directory):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcuts.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcuts.ps1 -AutoStart
#>
[CmdletBinding()]
param(
    [switch]$AutoStart,
    [string]$Name = 'AI Bridge Chrome'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repoRoot 'Start-Browser-Bridge.cmd'
$startScript = Join-Path $PSScriptRoot 'start-chrome.ps1'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

$shell = New-Object -ComObject WScript.Shell
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'

$desktop = [Environment]::GetFolderPath('Desktop')
$desktopLink = Join-Path $desktop ($Name + '.lnk')
$shortcut = $shell.CreateShortcut($desktopLink)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'Start Chrome with the remote debugging port used by DSH browser_bridge'
if (Test-Path -LiteralPath $chrome) { $shortcut.IconLocation = "$chrome,0" }
$shortcut.Save()
Write-Host "[bridge] Desktop shortcut created: $desktopLink" -ForegroundColor Green

if ($AutoStart) {
    $startup = [Environment]::GetFolderPath('Startup')
    $startupLink = Join-Path $startup ($Name + ' (autostart).lnk')
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $autostart = $shell.CreateShortcut($startupLink)
    $autostart.TargetPath = $powershell
    $autostart.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '" -NoOpen'
    $autostart.WorkingDirectory = $repoRoot
    $autostart.Description = 'Start the AI bridge Chrome silently at sign-in'
    if (Test-Path -LiteralPath $chrome) { $autostart.IconLocation = "$chrome,0" }
    $autostart.Save()
    Write-Host "[bridge] Autostart installed: $startupLink" -ForegroundColor Green
    Write-Host '[bridge] Remove that shortcut to disable autostart.' -ForegroundColor Cyan
}
