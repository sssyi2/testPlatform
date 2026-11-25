#!/usr/bin/env node
/**
 * 开发模式：同时启动后端 API 服务（4519）与 Vite 开发服务器（4518，带 /api 代理）。
 * 用法：node tools/dev.mjs   （或 npm run dev）
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: CODE_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  child.on('exit', (code) => {
    console.log(`[dev] ${name} 退出（code=${code}）`)
    shutdown()
  })
  children.push(child)
  return child
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run('api', process.execPath, [join(CODE_ROOT, 'server', 'src', 'index.mjs')], { PORT: process.env.PORT ?? '4519' })
run('web', process.execPath, [join(CODE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')])

console.log('[dev] 前端（开发）：http://127.0.0.1:4518')
console.log('[dev] 后端 API      ：http://127.0.0.1:4519')
console.log('[dev] 按 Ctrl+C 结束')
