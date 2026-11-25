/**
 * 数据层：JSON 文件持久化（零外部依赖）。
 *
 * 数据布局（都在 code/data/ 下，方便整体拷贝/清理）：
 *   data/db.json              项目与用例
 *   data/runs/<runId>.json    每次执行的完整结果
 *   data/runs/<runId>/        该次执行的截图等产物
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
export const CODE_ROOT = resolve(SERVER_DIR, '..', '..')   // code/
// 数据目录可用 TESTPLATFORM_DATA_DIR 覆盖：CI、演示录屏、多实例并行时各自用独立数据，
// 互不干扰（默认仍是 code/data）。
export const DATA_DIR = process.env.TESTPLATFORM_DATA_DIR
  ? resolve(process.env.TESTPLATFORM_DATA_DIR)
  : join(CODE_ROOT, 'data')
export const RUNS_DIR = join(DATA_DIR, 'runs')

const DB_FILE = join(DATA_DIR, 'db.json')

const EMPTY_DB = { version: 1, projects: [], cases: [] }

function ensureDirs() {
  for (const dir of [DATA_DIR, RUNS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export function readDb() {
  ensureDirs()
  if (!existsSync(DB_FILE)) return structuredClone(EMPTY_DB)
  try {
    // 容忍 BOM：Windows 上用 PowerShell 的 Set-Content -Encoding utf8 写过文件就会带 BOM
    const raw = readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '')
    const db = JSON.parse(raw)
    return {
      version: db.version ?? 1,
      projects: Array.isArray(db.projects) ? db.projects : [],
      cases: Array.isArray(db.cases) ? db.cases : [],
    }
  } catch (error) {
    throw new Error(`数据库文件损坏：${DB_FILE}（${error.message}）。可删除该文件重新开始（会丢失已保存的项目与用例）。`)
  }
}

let writeLock = Promise.resolve()

/** 串行化写操作：即使上一次失败，也不阻断后续写入。 */
const enqueue = (task) => {
  writeLock = writeLock.catch(() => {}).then(task)
  return writeLock
}

/** 原子写（先写 .tmp 再 rename），并用 Promise 串行化，避免并发写坏文件。 */
export function writeDb(db) {
  return enqueue(() => {
    ensureDirs()
    const tmp = `${DB_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, DB_FILE)
  })
}

/** 读-改-写，避免并发覆盖。 */
export function updateDb(mutator) {
  let result
  return enqueue(() => {
    ensureDirs()
    const db = existsSync(DB_FILE) ? readDb() : structuredClone(EMPTY_DB)
    result = mutator(db)
    const tmp = `${DB_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, DB_FILE)
  }).then(() => result)
}

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`

// ---------------------------------------------------------------- 执行记录

export function saveRun(run) {
  ensureDirs()
  const file = join(RUNS_DIR, `${run.id}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8')
  renameSync(tmp, file)
  return file
}

export function readRun(id) {
  const file = join(RUNS_DIR, `${id}.json`)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listRuns({ projectId, limit = 50 } = {}) {
  ensureDirs()
  const runs = []
  for (const name of readdirSync(RUNS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const run = JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'))
      if (projectId && run.projectId !== projectId) continue
      runs.push(run)
    } catch { /* 跳过损坏文件 */ }
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return runs.slice(0, limit)
}

/** 列表视图：去掉 results 明细，减小体积。 */
export function runSummary(run) {
  const { results, ...rest } = run
  return {
    ...rest,
    cases: (results ?? []).map((r) => ({
      caseId: r.caseId,
      name: r.name,
      type: r.type,
      status: r.status,
      verdict: r.verdict,
      expectedFailure: Boolean(r.expectedFailure),
      durationMs: r.durationMs,
      failedAssertions: (r.steps ?? []).flatMap((s) => (s.assertions ?? []).filter((a) => !a.ok)).length,
      screenshots: r.screenshots ?? [],
    })),
  }
}

export function runArtifactDir(runId) {
  const dir = join(RUNS_DIR, runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function deleteRun(id) {
  const file = join(RUNS_DIR, `${id}.json`)
  if (existsSync(file)) rmSync(file)
  const dir = join(RUNS_DIR, id)
  if (existsSync(dir) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true })
}

export { DB_FILE }
