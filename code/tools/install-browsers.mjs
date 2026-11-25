#!/usr/bin/env node
/**
 * 把 Playwright 的 Chromium 装进工作区内（code/.playwright-browsers），
 * 避免污染系统目录，也避免沙箱/权限问题。
 *
 * 用法：node tools/install-browsers.mjs [chromium|firefox|webkit]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(CODE_ROOT, '.playwright-browsers')
const cli = join(CODE_ROOT, 'node_modules', 'playwright', 'cli.js')
const target = process.argv[2] ?? 'chromium'

if (!existsSync(cli)) {
  console.error('找不到 playwright，请先在 code/ 目录执行依赖安装（见 readme.md）。')
  process.exit(1)
}

console.log(`[install-browsers] 安装目标：${target}`)
console.log(`[install-browsers] 安装目录：${BROWSERS_PATH}`)

const result = spawnSync(process.execPath, [cli, 'install', target], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH },
})

if (result.status !== 0) {
  console.error(`[install-browsers] 安装失败（退出码 ${result.status}）。`)
  console.error('[install-browsers] 若报 spawn EPERM / 权限错误，请改用系统自带的终端（不要用受限环境）重试。')
  process.exit(result.status ?? 1)
}

const installed = existsSync(BROWSERS_PATH) ? readdirSync(BROWSERS_PATH).filter((n) => n.startsWith('chromium')) : []
console.log(`[install-browsers] 完成，已安装：${installed.join(', ') || '(未检测到 chromium 目录)'}`)
