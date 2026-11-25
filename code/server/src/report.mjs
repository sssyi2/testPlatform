/**
 * 自包含 HTML 报告：单个 .html 文件，内联样式与截图（base64），可直接分享/存档。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from './store.mjs'

const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const STATUS_LABEL = { passed: '通过', failed: '失败', error: '异常', skipped: '跳过', running: '执行中', cancelled: '已取消' }
const STATUS_CLASS = { passed: 'ok', failed: 'bad', error: 'bad', skipped: 'skip', running: 'run', cancelled: 'skip' }
const VERDICT_LABEL = { xfail: '预期失败（已知缺陷）', xpass: '意外通过（缺陷可能已修复）' }

/** 用例结论：优先用 verdict（区分预期失败/意外通过），否则回退到状态。 */
function verdictInfo(result) {
  if (result.verdict === 'xfail') return { label: VERDICT_LABEL.xfail, cls: 'skip' }
  if (result.verdict === 'xpass') return { label: VERDICT_LABEL.xpass, cls: 'warn' }
  return { label: STATUS_LABEL[result.status] ?? result.status, cls: STATUS_CLASS[result.status] ?? '' }
}

function inlineImage(runId, url) {
  const file = join(RUNS_DIR, runId, url.split('/').pop())
  if (!existsSync(file)) return null
  const ext = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
  return `data:${ext};base64,${readFileSync(file).toString('base64')}`
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '')
const fmtDuration = (ms) => (ms == null ? '-' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`)

export function renderReport(run) {
  const s = run.summary ?? {}
  const rows = []
  for (const result of run.results ?? []) {
    const stepBlocks = (result.steps ?? []).map((step) => {
      const assertions = (step.assertions ?? []).map((a) => `
        <li class="assert ${a.ok ? 'ok' : 'bad'}">
          <span class="badge">${a.ok ? 'PASS' : 'FAIL'}</span>
          <strong>${esc(a.label)}</strong>
          <div class="detail">${esc(a.message)}</div>
        </li>`).join('')
      const request = step.request ? `
        <details><summary>请求</summary><pre>${esc(step.request.method)} ${esc(step.request.url)}
${esc(JSON.stringify(step.request.headers ?? {}, null, 2))}
${esc(step.request.body ?? '')}</pre></details>` : ''
      const response = step.response ? `
        <details><summary>响应（HTTP ${esc(step.response.status)}，${esc(step.response.bodySize)} 字节）</summary><pre>${esc(step.response.bodyPreview ?? '')}</pre></details>` : ''
      const shots = (step.screenshots ?? []).map((url) => {
        const data = inlineImage(run.id, url)
        return data ? `<img class="shot" src="${data}" alt="screenshot">` : ''
      }).join('')
      const logs = (step.logs ?? []).map((l) => `<div class="log">${esc(l)}</div>`).join('')
      return `
      <div class="step ${STATUS_CLASS[step.status] ?? ''}">
        <div class="step-head"><span class="badge">${STATUS_LABEL[step.status] ?? step.status}</span> ${esc(step.name)} <span class="muted">${fmtDuration(step.durationMs)}</span></div>
        ${logs}
        ${assertions ? `<ul class="asserts">${assertions}</ul>` : ''}
        ${request}${response}${shots}
        ${step.error ? `<div class="log bad">${esc(step.error)}</div>` : ''}
      </div>`
    }).join('')

    const verdict = verdictInfo(result)
    rows.push(`
    <section class="case ${verdict.cls}">
      <h3><span class="badge">${verdict.label}</span> ${esc(result.name)} <span class="muted">${esc(result.type)} · ${fmtDuration(result.durationMs)}</span></h3>
      ${(result.logs ?? []).map((l) => `<div class="log">${esc(l)}</div>`).join('')}
      ${stepBlocks}
      ${result.error ? `<div class="log bad">${esc(result.error)}</div>` : ''}
    </section>`)
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>测试报告 · ${esc(run.name)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; margin: 0; background: #f5f7fa; color: #1f2937; }
  header { background: #0f172a; color: #fff; padding: 24px 32px; }
  header h1 { margin: 0 0 8px; font-size: 22px; }
  header .meta { opacity: .8; font-size: 13px; line-height: 1.7; }
  main { padding: 24px 32px 64px; max-width: 1080px; margin: 0 auto; }
  .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 24px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 18px; box-shadow: 0 1px 3px rgba(15,23,42,.08); min-width: 110px; }
  .card b { display: block; font-size: 24px; }
  .case { background: #fff; border-radius: 10px; padding: 16px 20px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(15,23,42,.08); border-left: 4px solid #cbd5e1; }
  .case.ok { border-left-color: #16a34a; } .case.bad { border-left-color: #dc2626; }
  .case.warn { border-left-color: #d97706; } .case.skip { border-left-color: #94a3b8; }
  .case h3 { margin: 0 0 10px; font-size: 16px; }
  .step { border-top: 1px dashed #e2e8f0; padding: 10px 0 4px; }
  .step-head { font-weight: 600; margin-bottom: 6px; }
  .badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #e2e8f0; color: #334155; vertical-align: middle; }
  .ok > .badge, .assert.ok .badge { background: #dcfce7; color: #15803d; }
  .bad > .badge, .assert.bad .badge { background: #fee2e2; color: #b91c1c; }
  .muted { color: #64748b; font-weight: 400; font-size: 12px; }
  .log { font-family: Consolas, monospace; font-size: 12px; color: #475569; padding: 2px 0; white-space: pre-wrap; }
  .log.bad { color: #b91c1c; }
  ul.asserts { list-style: none; padding: 0; margin: 8px 0; }
  .assert { padding: 6px 8px; border-radius: 6px; background: #f8fafc; margin-bottom: 4px; font-size: 13px; }
  .assert.bad { background: #fef2f2; }
  .detail { color: #475569; font-size: 12px; margin-top: 2px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: 360px; }
  img.shot { max-width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; margin-top: 8px; }
  details summary { cursor: pointer; color: #2563eb; font-size: 12px; margin: 6px 0; }
</style></head>
<body>
<header>
  <h1>测试报告：${esc(run.name)}</h1>
  <div class="meta">
    执行 ID：${esc(run.id)} · 项目：${esc(run.projectName ?? run.projectId)}<br>
    开始：${esc(fmtTime(run.startedAt))} · 结束：${esc(fmtTime(run.finishedAt))} · 总耗时：${fmtDuration(run.durationMs)}<br>
    生成时间：${esc(new Date().toLocaleString('zh-CN'))}
  </div>
</header>
<main>
  <div class="summary">
    <div class="card"><b>${s.total ?? 0}</b>用例总数</div>
    <div class="card"><b style="color:#16a34a">${s.passed ?? 0}</b>通过</div>
    <div class="card"><b style="color:#dc2626">${s.failed ?? 0}</b>失败</div>
    <div class="card"><b style="color:#d97706">${s.error ?? 0}</b>异常</div>
    ${s.xfail ? `<div class="card"><b style="color:#64748b">${s.xfail}</b>预期失败</div>` : ''}
    ${s.xpass ? `<div class="card"><b style="color:#d97706">${s.xpass}</b>意外通过</div>` : ''}
    <div class="card"><b>${fmtDuration(s.durationMs)}</b>用例耗时</div>
    <div class="card"><b>${STATUS_LABEL[run.status] ?? run.status}</b>总体结论</div>
  </div>
  ${rows.join('\n') || '<p>没有用例结果。</p>'}
</main>
</body></html>`
}
