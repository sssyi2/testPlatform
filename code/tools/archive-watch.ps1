<#
归档守护进程：盯着本工作区的 DSH 会话日志，只要一有写入就立刻归档到 prompt/。

为什么需要它：助手的一条回复是在「本轮最后一次工具调用之后」才生成的，所以
回合内跑的归档永远抓不到最后那条回复；两回合之间又没人跑归档，于是用户会看到
「最后一句话之后的内容没归档」。这个守护进程把那段空档补上——日志一变就归档，
通常 10 秒内完成，不依赖重启 GUI。

用法：
  powershell -ExecutionPolicy Bypass -File code\tools\archive-watch.ps1
  powershell -ExecutionPolicy Bypass -File code\tools\archive-watch.ps1 -IntervalSeconds 5 -MaxHours 2

参数：
  -IntervalSeconds  检查间隔（默认 10 秒）
  -MaxHours         最长运行时长（默认 12 小时，到点自动退出）
  -Workspace        工作区路径（默认从脚本位置推断）

说明：日志写在 prompt\.archive-watch.log（自动限长）。归档脚本本身是幂等的，
没有变化时几乎不做事，所以常驻运行的开销可以忽略。
#>
param(
  [int] $IntervalSeconds = 10,
  [int] $MaxHours = 12,
  [string] $Workspace = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'SilentlyContinue'

$promptDir = Join-Path $Workspace 'prompt'
$logFile = Join-Path $promptDir '.archive-watch.log'
$archiver = Join-Path $Workspace 'code\tools\dsh-archive.mjs'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$sessionsRoot = Join-Path $dshHome 'sessions'

if (-not (Test-Path $archiver)) { Write-Error "找不到归档脚本：$archiver"; exit 1 }
if (-not (Test-Path $promptDir)) { New-Item -ItemType Directory -Force -Path $promptDir | Out-Null }

function Write-Log([string] $message) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    if ((Get-Item $logFile).Length -gt 512KB) {
      $keep = Get-Content $logFile -Encoding UTF8 -Tail 500
      Set-Content -Path $logFile -Value $keep -Encoding UTF8
    }
  } catch { }
}

function Get-LatestSessionStamp {
  try {
    $latest = Get-ChildItem -Path $sessionsRoot -Recurse -File -Filter 'session*' |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { return $latest.LastWriteTime.Ticks }
  } catch { }
  return $null
}

Write-Log "watcher 启动：间隔 ${IntervalSeconds}s，最长 ${MaxHours}h，工作区 $Workspace"

# 启动先归档一次，把上一轮尾巴补上
& node $archiver --quiet
Write-Log "初次归档完成"

$lastStamp = Get-LatestSessionStamp
$deadline = (Get-Date).AddHours($MaxHours)
$count = 0

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $IntervalSeconds
  $stamp = Get-LatestSessionStamp
  if ($stamp -and $stamp -ne $lastStamp) {
    $lastStamp = $stamp
    & node $archiver --quiet
    $count++
    Write-Log "检测到会话日志变化，已归档（第 $count 次）"
  }
}

Write-Log "watcher 退出（达到最长运行时间 ${MaxHours}h，共归档 $count 次）"
