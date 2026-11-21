param([int]$MinValidMinutes = 10, [switch]$All)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scan = Join-Path $here 'scan_token.ps1'
$cache = Join-Path $here '.wb-token'

function Get-JwtPayload([string]$jwt) {
    $parts = $jwt.Split('.')
    if ($parts.Length -lt 2) { return $null }
    $p = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } 1 { $p = $p.Substring(0, $p.Length - 1) } }
    try { return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json) } catch { return $null }
}

$pids = (Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Id
if (-not $pids) { Write-Output 'NO_PROCESS'; exit 2 }

$hits = & $scan -PidList $pids -Pattern '(Bearer eyJ[A-Za-z0-9_\-\.]{200,4000})'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$best = $null; $bestExp = 0
foreach ($h in $hits) {
    $t = ($h -replace '^Bearer\s+', '').Trim()
    $pl = Get-JwtPayload $t
    if (-not $pl -or -not $pl.exp) { continue }
    if ($pl.iss -notmatch 'workbuddy') { continue }
    if ([int]$pl.exp -lt ($now + $MinValidMinutes * 60)) { continue }
    if ([int]$pl.exp -gt $bestExp) { $bestExp = [int]$pl.exp; $best = $t }
}

if ($All) { foreach ($h in $hits) { $h -replace '^Bearer\s+', '' } ; exit 0 }

if ($best) {
    Set-Content -Path $cache -Value $best -NoNewline -Encoding ASCII
    Write-Output $best
    exit 0
}
Write-Output 'NO_VALID_TOKEN'
exit 1
