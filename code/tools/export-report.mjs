#!/usr/bin/env node
/**
 * 导出执行报告为自包含 HTML（截图内联为 base64），可用于 CI 归档或随邮件发送。
 *
 * 用法：
 *   node tools/export-report.mjs                 # 导出最近一次执行
 *   node tools/export-report.mjs run_xxxxxxxx    # 导出指定执行
 *   node tools/export-report.mjs run_xxxxxxxx out.html
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRun, listRuns, DATA_DIR } from '../server/src/store.mjs'
import { renderReport } from '../server/src/report.mjs'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const runId = process.argv[2]
const run = runId ? readRun(runId) : listRuns({ limit: 1 })[0]

if (!run) {
  console.error(runId ? `找不到执行记录：${runId}` : '还没有任何执行记录，请先跑一次用例。')
  process.exit(1)
}

const out = resolve(process.argv[3] ?? join(DATA_DIR, 'reports', `${run.id}.html`))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, renderReport(run), 'utf8')

const s = run.summary ?? {}
console.log(`已导出报告：${out}`)
console.log(`执行：${run.name}（${run.id}）`)
console.log(`结果：共 ${s.total} · 通过 ${s.passed} · 失败 ${s.failed} · 异常 ${s.error} · 预期失败 ${s.xfail ?? 0}`)
