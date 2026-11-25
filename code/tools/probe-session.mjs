// Dev probe: decode all concatenated zstd frames of a DSH session log.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const target = process.argv[2] ?? process.env.DSH_SESSION_ID
const file = join(DSH_HOME, 'sessions', '--E-testPlatform--', target, 'session.v3.jsonl.zstd')
const buf = readFileSync(file)
const { frames, tornStart } = scanZstdFrames(buf)
console.log('bytes:', buf.length, 'frames:', frames.length, 'tornStart:', tornStart)

const events = []
for (const { start, end } of frames) {
  const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { console.log('BAD:', line.slice(0, 120)) }
  }
}
console.log('events:', events.length)
const types = new Map()
for (const e of events) types.set(e.type ?? '?', (types.get(e.type ?? '?') ?? 0) + 1)
for (const [k, v] of types) console.log(String(v).padStart(4), k)
console.log('--- sample per type ---')
const seen = new Set()
for (const e of events) {
  if (seen.has(e.type)) continue
  seen.add(e.type)
  console.log('###', e.type, '=>', JSON.stringify(e).slice(0, 1200), '\n')
}
