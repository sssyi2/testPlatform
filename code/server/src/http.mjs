/**
 * 极简 HTTP 层：路由、JSON 解析、静态文件、SSE。不依赖任何框架。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export function createRouter() {
  const routes = []

  function add(method, pattern, handler) {
    routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler })
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean)
      for (const item of routes) {
        if (item.method !== method) continue
        if (item.segments.length !== parts.length) continue
        const params = {}
        let matched = true
        for (let i = 0; i < parts.length; i++) {
          const segment = item.segments[i]
          if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i])
          else if (segment !== parts[i]) { matched = false; break }
        }
        if (matched) return { handler: item.handler, params, pattern: item.pattern }
      }
      return null
    },
  }
}

export async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400 })
  }
}

export function sendJson(res, status, data) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(data ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

export async function sendFile(res, filePath, { download = false } = {}) {
  if (res.headersSent || res.writableEnded) return false
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const data = await readFile(filePath)
    const headers = { 'content-type': type, 'content-length': data.length }
    if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(filePath.split(/[\\/]/).pop())}"`
    res.writeHead(200, headers)
    res.end(data)
    return true
  } catch {
    return false
  }
}

/** 静态目录：目录穿越会被拒绝；可选 SPA 回退到 index.html。 */
export async function serveStatic(res, rootDir, urlPath, { spaFallback = false } = {}) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  const target = resolve(rootDir, `.${clean.startsWith('/') ? clean : `/${clean}`}`)
  if (!target.startsWith(resolve(rootDir))) {
    sendText(res, 403, '403 路径非法')
    return
  }
  if (await sendFile(res, target)) return
  if (spaFallback) {
    const index = join(rootDir, 'index.html')
    if (await sendFile(res, index)) return
  }
  sendText(res, 404, '404 未找到')
}

/** SSE：向客户端推送执行事件。 */
export function openSse(req, res, { onClose } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { /* 连接已断 */ }
  }, 15000)
  const close = () => {
    clearInterval(heartbeat)
    onClose?.()
    try { res.end() } catch { /* ignore */ }
  }
  req.on('close', close)
  return {
    send(payload) {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      } catch { /* ignore */ }
    },
    close,
  }
}

export function startServer({ port, host = '127.0.0.1', handler }) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      const status = error?.statusCode ?? 500
      if (!res.headersSent) sendJson(res, status, { error: error?.message ?? String(error) })
      else res.end()
      if (status >= 500) console.error('[server] 处理请求失败：', error)
    })
  })
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => resolvePromise(server))
  })
}

export { MIME }
