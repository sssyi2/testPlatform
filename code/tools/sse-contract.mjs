// 临时验证：SSE 实时事件流是否按契约推送。用完后删除。
process.env.PORT = '4629'
const BASE = 'http://127.0.0.1:4629'

await import('file:///E:/testPlatform/code/server/src/index.mjs')

const j = async (path, init) => {
  const res = await fetch(BASE + path, init)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const post = (path, body) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const project = await post('/api/projects', { name: 'SSE 验证', baseUrl: BASE })
const c1 = await post(`/api/projects/${project.data.id}/cases`, {
  name: 'SSE 用：健康检查',
  type: 'api',
  steps: [{
    name: 'GET /api/health',
    request: { method: 'GET', url: '{{baseUrl}}/api/health' },
    assertions: [{ type: 'status', op: 'equals', expected: '200' }, { type: 'jsonPath', op: 'equals', path: '$.ok', expected: 'true' }],
  }],
})
const c2 = await post(`/api/projects/${project.data.id}/cases`, {
  name: 'SSE 用：故意失败',
  type: 'api',
  steps: [{ name: 'GET /api/health', request: { method: 'GET', url: '{{baseUrl}}/api/health' }, assertions: [{ type: 'status', op: 'equals', expected: '500' }] }],
})
console.log('cases:', c1.status, c2.status)

const run = await post('/api/runs', { projectId: project.data.id, name: 'SSE 验证执行' })
const runId = run.data.runId
console.log('runId:', runId)

const res = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { accept: 'text/event-stream' } })
console.log('SSE status:', res.status, res.headers.get('content-type'))
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const seen = new Map()
const order = []
let done = false
const deadline = Date.now() + 30000
while (!done && Date.now() < deadline) {
  const { value } = await reader.read()
  if (!value) break
  buffer += decoder.decode(value, { stream: true })
  const frames = buffer.split('\n\n')
  buffer = frames.pop() ?? ''
  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const event = JSON.parse(line.slice(6))
    if (event.type === 'snapshot') continue
    seen.set(event.type, (seen.get(event.type) ?? 0) + 1)
    order.push(event.type)
    if (event.type === 'assertion') console.log(`  assertion: ${event.result.ok ? 'PASS' : 'FAIL'} ${event.result.label}`)
    if (event.type === 'case:end') console.log(`  case:end ${event.status} ${event.name}`)
    if (event.type === 'run:end') { console.log(`  run:end ${event.status}`, JSON.stringify(event.summary)); done = true }
  }
}
console.log('事件类型统计:', JSON.stringify(Object.fromEntries(seen)))
console.log('事件顺序:', order.join(' → '))
const expect = ['run:start', 'case:start', 'step:start', 'assertion', 'step:end', 'case:end', 'run:end']
console.log('契约事件齐全:', expect.every((t) => seen.has(t)))
console.log('cleanup:', (await j(`/api/projects/${project.data.id}`, { method: 'DELETE' })).status)
console.log('delete run:', (await j(`/api/runs/${runId}`, { method: 'DELETE' })).status)
process.exit(0)
