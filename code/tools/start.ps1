<#
一键启动「测试平台 + 示例被测软件」，并自动打开浏览器。录屏演示用这个。

用法（在 E:\testPlatform\code 下执行）：
  powershell -ExecutionPolicy Bypass -File tools\start.ps1              # 需要时自动构建前端
  powershell -ExecutionPolicy Bypass -File tools\start.ps1 -SkipBuild  # 跳过构建
  powershell -ExecutionPolicy Bypass -File tools\start.ps1 -AutoRun    # 启动后自动跑一遍全部用例
#>
param(
  [switch] $SkipBuild,
  [switch] $AutoRun
)

$ErrorActionPreference = 'Stop'
$codeRoot = Split-Path -Parent $PSScriptRoot
Set-Location $codeRoot

$node = (Get-Command node).Source
if (-not $node) { throw '找不到 node，请先安装 Node.js 20+。' }

if (-not $SkipBuild) {
  if (-not (Test-Path (Join-Path $codeRoot 'web\dist\index.html'))) {
    Write-Host '[start] 首次运行：构建前端（vite build）…'
    & $node (Join-Path $codeRoot 'node_modules\vite\bin\vite.js') build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
  } else {
    Write-Host '[start] 前端已构建（如需重建：npm run build）'
  }
}

$args = @((Join-Path $codeRoot 'tools\demo.mjs'), '--serve')
if ($AutoRun) { $args = @((Join-Path $codeRoot 'tools\demo.mjs'), '--open') }

Write-Host '[start] 启动演示环境…（Ctrl+C 结束）'
& $node @args
