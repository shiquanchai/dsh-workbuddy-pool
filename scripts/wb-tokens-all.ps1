param([int]$MinValidMinutes = 10)

# 统一按 UTF-8 输出，避免中文昵称在管道里变成乱码。
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

# 把 WorkBuddy 进程内存里所有仍然有效的 WorkBuddy JWT 都列出来（按 sub 去重，保留 exp 最大的），
# 输出 JSON 数组：[{ token, sub, phone, nickname, exp, expAt }]
# 用途：桌面端先后登录过多个账号时，一次把能看到的账号全抓出来导入账号池。

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scan = Join-Path $here 'scan_token.ps1'

function ConvertFrom-Base64Url([string]$value) {
    $v = $value.Replace('-', '+').Replace('_', '/')
    switch ($v.Length % 4) {
        2 { $v += '==' }
        3 { $v += '=' }
        1 { $v = $v.Substring(0, $v.Length - 1) }
    }
    try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) } catch { return $null }
}

$pids = @((Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Id)
if ($pids.Count -eq 0) { '[]'; exit 0 }

$hits = & $scan -PidList $pids -Pattern '(eyJ[A-Za-z0-9_\-\.]{200,4000})'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$best = @{}

foreach ($raw in $hits) {
    if ("$raw" -notlike 'eyJ*') { continue }
    $parts = "$raw".Split('.')
    if ($parts.Length -lt 2) { continue }
    $json = ConvertFrom-Base64Url $parts[1]
    if (-not $json) { continue }
    $payload = $null
    try { $payload = $json | ConvertFrom-Json } catch { continue }
    if (-not $payload.exp) { continue }
    if ("$($payload.iss)" -notmatch 'workbuddy') { continue }
    if ([int64]$payload.exp -lt ($now + $MinValidMinutes * 60)) { continue }
    $key = "$($payload.sub)"
    if ($key -eq '') { $key = "$($payload.preferred_username)" }
    if ($key -eq '') { continue }
    if (-not $best.ContainsKey($key) -or [int64]$payload.exp -gt [int64]$best[$key].exp) {
        $best[$key] = [pscustomobject]@{
            token    = "$raw"
            sub      = "$($payload.sub)"
            phone    = "$($payload.preferred_username)"
            nickname = "$($payload.nickname)"
            exp      = [int64]$payload.exp
            expAt    = ([DateTimeOffset]::FromUnixTimeSeconds([int64]$payload.exp)).ToString('o')
        }
    }
}

if ($best.Count -eq 0) { '[]'; exit 0 }
ConvertTo-Json -InputObject @($best.Values) -Depth 4 -Compress
