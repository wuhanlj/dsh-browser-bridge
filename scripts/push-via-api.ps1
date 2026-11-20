#requires -Version 5.1
<#
  Fallback push path for networks where https://github.com:443 is blocked but
  https://api.github.com works.

  It recreates the current HEAD commit on the remote through the Git Data API
  (blobs -> tree -> commit -> ref update) and then reconciles the local refs so
  local and remote point at the same commit.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\push-via-api.ps1
#>
[CmdletBinding()]
param(
    [string]$Owner = 'wuhanlj',
    [string]$Repo = 'dsh-browser-bridge',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-ApiJson {
    param([string]$Method, [string]$Path, [string]$BodyFile, [string]$Token)
    $curlArgs = @('-s', '-X', $Method)
    $curlArgs += @('-H', 'Accept: application/vnd.github+json')
    $curlArgs += @('-H', 'User-Agent: dsh-bridge-push')
    $curlArgs += @('-H', "Authorization: Bearer $Token")
    if ($BodyFile) { $curlArgs += @('--data-binary', "@$BodyFile") }
    $curlArgs += "https://api.github.com$Path"
    $json = & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "API call failed: $Method $Path" }
    $parsed = $json | ConvertFrom-Json
    if ($parsed.message -and $parsed.status) { throw "API error on $Path : $($parsed.message)" }
    return $parsed
}

function To-GitDateFromIso([string]$Iso) {
    $dto = [System.DateTimeOffset]::Parse($Iso)
    $offset = $dto.Offset
    $sign = if ($offset -lt [TimeSpan]::Zero) { '-' } else { '+' }
    $absolute = $offset.Duration()
    $tz = '{0}{1:00}{2:00}' -f $sign, $absolute.Hours, $absolute.Minutes
    return @{ epoch = $dto.ToUnixTimeSeconds(); tz = $tz }
}

Write-Host '[push] reading git credential for github.com'
$credText = "protocol=https`nhost=github.com`n`n" | git credential fill 2>&1
$map = @{}
foreach ($line in ($credText -split "`r?`n")) {
    if ($line -match '^([^=]+)=(.*)$') { $map[$matches[1]] = $matches[2] }
}
$token = $map['password']
if (-not $token) { throw 'No stored GitHub credential; run: git credential-manager github login' }

$api = "/repos/$Owner/$Repo"
$head = (git rev-parse HEAD).Trim()
$parent = (git rev-parse HEAD^ 2>$null)
if (-not $parent) { throw 'HEAD has no parent commit; not supported by this fallback' }
$parent = $parent.Trim()
$localTree = (git rev-parse 'HEAD^{tree}').Trim()

Write-Host "[push] local HEAD $head (parent $parent)"

$ref = Invoke-ApiJson -Method GET -Path "$api/git/ref/heads/$Branch" -Token $token
$remoteHead = [string]$ref.object.sha
Write-Host "[push] remote $Branch at $remoteHead"
if ($remoteHead -eq $head) {
    Write-Host '[push] remote already matches HEAD - nothing to do'
    exit 0
}
if ($remoteHead -ne $parent) {
    throw "Remote head $remoteHead is not the parent of local HEAD $parent; manual reconciliation required."
}

$changed = @(git diff --name-only $parent $head)
Write-Host ("[push] changed files: " + ($changed -join ', '))

$tmpDir = Join-Path $repoRoot '.push-api-tmp'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
try {
    $entries = @()
    foreach ($file in $changed) {
        $full = Join-Path $repoRoot $file
        if (-not (Test-Path -LiteralPath $full)) { throw "Missing changed file: $file" }
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $body = @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' } | ConvertTo-Json -Compress
        $bodyFile = Join-Path $tmpDir 'blob.json'
        [System.IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))
        $blob = Invoke-ApiJson -Method POST -Path "$api/git/blobs" -BodyFile $bodyFile -Token $token
        $entries += @{ path = ($file -replace '\\', '/'); mode = '100644'; type = 'blob'; sha = $blob.sha }
        Write-Host "[push] blob $($blob.sha.Substring(0,8)) $file"
    }

    $parentTree = (Invoke-ApiJson -Method GET -Path "$api/git/commits/$parent" -Token $token).tree.sha
    $treeBody = @{ base_tree = $parentTree; tree = $entries } | ConvertTo-Json -Depth 8 -Compress
    $treeFile = Join-Path $tmpDir 'tree.json'
    [System.IO.File]::WriteAllText($treeFile, $treeBody, (New-Object System.Text.UTF8Encoding($false)))
    $tree = Invoke-ApiJson -Method POST -Path "$api/git/trees" -BodyFile $treeFile -Token $token
    Write-Host "[push] tree $($tree.sha)"

    # Reuse the local commit metadata so the remote commit is byte-identical when possible.
    $meta = @(git log -1 --format='%an%n%ae%n%at%n%aI%n%cn%n%ce%n%ct%n%cI%n%B')
    if ($meta.Count -lt 10) { throw "Unexpected git log output ($($meta.Count) lines)" }
    $anName = $meta[0]; $anEmail = $meta[1]; $atEpoch = $meta[2]; $atIso = $meta[3]
    $cnName = $meta[4]; $cnEmail = $meta[5]; $ctEpoch = $meta[6]; $ctIso = $meta[7]
    $message = ($meta[8..($meta.Count - 1)] -join "`n")

    $commitBody = @{
        message = $message
        tree = $tree.sha
        parents = @([string]$parent)
        author = @{ name = $anName; email = $anEmail; date = $atIso }
        committer = @{ name = $cnName; email = $cnEmail; date = $ctIso }
    } | ConvertTo-Json -Depth 8 -Compress
    $commitFile = Join-Path $tmpDir 'commit.json'
    [System.IO.File]::WriteAllText($commitFile, $commitBody, (New-Object System.Text.UTF8Encoding($false)))
    $remoteCommit = Invoke-ApiJson -Method POST -Path "$api/git/commits" -BodyFile $commitFile -Token $token
    Write-Host "[push] remote commit $($remoteCommit.sha)"

    $refBody = @{ sha = $remoteCommit.sha; force = $false } | ConvertTo-Json -Compress
    $refFile = Join-Path $tmpDir 'ref.json'
    [System.IO.File]::WriteAllText($refFile, $refBody, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-ApiJson -Method PATCH -Path "$api/git/refs/heads/$Branch" -BodyFile $refFile -Token $token | Out-Null
    Write-Host "[push] ref $Branch updated to $($remoteCommit.sha)"

    if ($remoteCommit.sha -eq $head) {
        Write-Host '[push] commit SHA matches local HEAD - local and remote are in sync'
        git update-ref "refs/remotes/origin/$Branch" $head
        exit 0
    }

    # Different SHA (API normalizes metadata): materialize the remote commit locally.
    Write-Host '[push] remote SHA differs; materializing it locally'
    $info = Invoke-ApiJson -Method GET -Path "$api/git/commits/$($remoteCommit.sha)" -Token $token
    $a = To-GitDateFromIso $info.author.date
    $c = To-GitDateFromIso $info.committer.date
    $lines = @(
        "tree $($info.tree.sha)"
        "parent $($info.parents[0].sha)"
        "author $($info.author.name) <$($info.author.email)> $($a.epoch) $($a.tz)"
        "committer $($info.committer.name) <$($info.committer.email)> $($c.epoch) $($c.tz)"
        ''
    ) + ($info.message -split "`n")
    $rawCommit = ($lines -join "`n") + "`n"
    $sha = ($rawCommit | git hash-object -t commit -w --stdin).Trim()
    if ($sha -ne $remoteCommit.sha) {
        $rawCommit2 = $rawCommit.TrimEnd("`n")
        $sha = ($rawCommit2 | git hash-object -t commit -w --stdin).Trim()
    }
    if ($sha -ne $remoteCommit.sha) { throw "Could not reproduce remote commit object locally ($sha vs $($remoteCommit.sha))" }
    git update-ref "refs/heads/$Branch" $remoteCommit.sha
    git update-ref "refs/remotes/origin/$Branch" $remoteCommit.sha
    Write-Host "[push] local $Branch moved to $($remoteCommit.sha); working tree unchanged"
}
finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
