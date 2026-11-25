<#
启动带「自动归档」能力的 DSH Web GUI（项目级，不改动全局配置）。

用法：
  powershell -ExecutionPolicy Bypass -File code\tools\start-dsh-web.ps1
  # 追加的其它参数会原样透传给 dsh web

原理：dsh web --patch <本项目的 profile 补丁>，补丁里挂载 Claude Code hook 桥，
      由 .dsh/hooks.json 在「每轮结束(Stop)」和「收到新消息(UserPromptSubmit)」时
      调用 code/tools/dsh-archive.mjs，把会话日志写进 prompt/。
#>
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Passthrough
)

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$patch = Join-Path $repoRoot '.dsh\profile-patch.yml'

if (-not (Test-Path $patch)) {
  Write-Error "找不到补丁文件：$patch"
  exit 1
}

Write-Host "[start-dsh-web] 工作区：$repoRoot"
Write-Host "[start-dsh-web] 补丁：$patch"
Write-Host "[start-dsh-web] 启动：dsh web --patch <patch>"

& dsh web --patch $patch @Passthrough
exit $LASTEXITCODE
