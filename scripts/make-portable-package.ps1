#requires -Version 5.1
<#
  Builds a portable ZIP of this plugin bundle, ready to copy to another PC.

  Usage (from the plugin directory):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-portable-package.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-portable-package.ps1 -WithNodeModules

  -WithNodeModules embeds node_modules (about 45 MB, larger ZIP) so the new PC
  needs neither network nor npm; without it the new PC runs npm install.
#>
[CmdletBinding()]
param(
    [switch]$WithNodeModules,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot 'dist' }

$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$manifest.version
$packageName = 'dsh-browser-bridge-' + $version
$suffix = if ($WithNodeModules) { '-offline' } else { '' }

$libEntry = Join-Path $repoRoot 'lib\index.js'
if (-not (Test-Path -LiteralPath $libEntry)) {
    throw "lib/index.js not found. Run 'npm run build' first."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-bridge-pkg-' + [guid]::NewGuid().ToString('N'))
$staging = Join-Path $stagingRoot $packageName
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$items = @(
    'package.json'
    'package-lock.json'
    'cordis.patch.yml'
    'README.md'
    'icon.svg'
    'lib'
    'locale'
    'src'
    'tsconfig.json'
    'Start-Browser-Bridge.cmd'
    'scripts'
    'test'
)
foreach ($item in $items) {
    $source = Join-Path $repoRoot $item
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $staging -Recurse -Force
    }
}

if ($WithNodeModules) {
    $modules = Join-Path $repoRoot 'node_modules'
    if (-not (Test-Path -LiteralPath $modules)) {
        throw 'node_modules not found. Run npm install first, or omit -WithNodeModules.'
    }
    Copy-Item -LiteralPath $modules -Destination (Join-Path $staging 'node_modules') -Recurse -Force
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$zipPath = Join-Path $OutputDir ($packageName + $suffix + '.zip')
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Compress-Archive -Path $staging -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue

$sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
Write-Host "[bridge] Portable package created: $zipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host '[bridge] On the new PC: extract it, then run:' -ForegroundColor Cyan
Write-Host '         powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1' -ForegroundColor Cyan
if ($WithNodeModules) {
    Write-Host '[bridge] This package already contains node_modules: setup-new-pc.ps1 -SkipNpmInstall works offline.' -ForegroundColor Cyan
}
