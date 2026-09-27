import * as Y from 'yjs'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { WebSocket } from 'ws'

const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR ?? '/data/snapshots'
const SNAPSHOT_INTERVAL_MS = 10_000
const DOC_TTL_MS = 60_000

// Message type constants (y-protocols wire format)
const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_SYNC_STEP1 = 0
const MSG_SYNC_STEP2 = 1
const MSG_SYNC_UPDATE = 2

interface DocEntry {
  doc: Y.Doc
  clients: Set<WebSocket>
  dirty: boolean
  awareness: Map<number, Record<string, unknown>>
  snapshotTimer: ReturnType<typeof setInterval> | null
  evictTimer: ReturnType<typeof setTimeout> | null
}

const docs = new Map<string, DocEntry>()

async function loadSnapshot(featureId: string): Promise<Uint8Array | null> {
  const path = join(SNAPSHOTS_DIR, `${featureId}.ydoc`)
  if (!existsSync(path)) return null
  try {
    const buf = await readFile(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch { return null }
}

async function saveSnapshot(featureId: string, doc: Y.Doc): Promise<void> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true })
  const tmp = join(SNAPSHOTS_DIR, `${featureId}.ydoc.tmp`)
  const final = join(SNAPSHOTS_DIR, `${featureId}.ydoc`)
  const update = Y.encodeStateAsUpdate(doc)
  await writeFile(tmp, update)
  await rename(tmp, final)
}

function encodeVarUint(n: number): Uint8Array {
  const buf: number[] = []
  while (n > 0x7f) { buf.push((n & 0x7f) | 0x80); n >>>= 7 }
  buf.push(n)
  return new Uint8Array(buf)
}

function decodeVarUint(buf: Uint8Array, offset: number): [number, number] {
  let r = 0, s = 0, i = offset
  while (i < buf.length) {
    const b = buf[i++]
    r |= (b & 0x7f) << s; s += 7
    if (!(b & 0x80)) break
  }
  return [r, i]
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(len); let offset = 0
  for (const a of arrs) { out.set(a, offset); offset += a.length }
  return out
}

function makeSyncStep1Msg(doc: Y.Doc): Uint8Array {
  const sv = Y.encodeStateVector(doc)
  return concat(new Uint8Array([MSG_SYNC, MSG_SYNC_STEP1]), encodeVarUint(sv.length), sv)
}

function makeSyncStep2Msg(doc: Y.Doc, sv: Uint8Array): Uint8Array {
  const update = Y.encodeStateAsUpdate(doc, sv)
  return concat(new Uint8Array([MSG_SYNC, MSG_SYNC_STEP2]), encodeVarUint(update.length), update)
}

async function getOrCreate(featureId: string): Promise<DocEntry> {
  const existing = docs.get(featureId)
  if (existing) return existing

  const doc = new Y.Doc()
  const snapshot = await loadSnapshot(featureId)
  if (snapshot) { Y.applyUpdate(doc, snapshot) }

  const entry: DocEntry = {
    doc, clients: new Set(), dirty: false,
    awareness: new Map(), snapshotTimer: null, evictTimer: null,
  }

  doc.on('update', (_update: Uint8Array, _origin: unknown) => { entry.dirty = true })

  entry.snapshotTimer = setInterval(async () => {
    if (entry.dirty) {
      entry.dirty = false
      await saveSnapshot(featureId, doc).catch((e) =>
        console.warn(`[yjs] snapshot failed for ${featureId}:`, e),
      )
    }
  }, SNAPSHOT_INTERVAL_MS)

  docs.set(featureId, entry)
  return entry
}

function scheduleEvict(featureId: string): void {
  const entry = docs.get(featureId)
  if (!entry) return
  if (entry.evictTimer) clearTimeout(entry.evictTimer)
  entry.evictTimer = setTimeout(async () => {
    const e = docs.get(featureId)
    if (!e || e.clients.size > 0) return
    if (e.dirty) await saveSnapshot(featureId, e.doc).catch(() => {})
    if (e.snapshotTimer) clearInterval(e.snapshotTimer)
    docs.delete(featureId)
  }, DOC_TTL_MS)
}

function broadcast(entry: DocEntry, msg: Uint8Array, exclude: WebSocket | null): void {
  for (const client of entry.clients) {
    if (client !== exclude && client.readyState === 1) client.send(msg)
  }
}

export async function handleYjsConnection(featureId: string, ws: WebSocket): Promise<void> {
  const entry = await getOrCreate(featureId)
  entry.clients.add(ws)
  if (entry.evictTimer) { clearTimeout(entry.evictTimer); entry.evictTimer = null }

  // Send sync step 1
  ws.send(makeSyncStep1Msg(entry.doc))

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const data = raw instanceof Buffer ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : new Uint8Array(Buffer.concat(raw as Buffer[]))

      if (data.length === 0) return
      const msgType = data[0]
      const payload = data.slice(1)

      if (msgType === MSG_SYNC) {
        const syncMsgType = payload[0]
        const rest = payload.slice(1)

        if (syncMsgType === MSG_SYNC_STEP1) {
          // Client sent its state vector; reply with step 2
          const [svLen, svOffset] = decodeVarUint(rest, 0)
          const sv = rest.slice(svOffset, svOffset + svLen)
          ws.send(makeSyncStep2Msg(entry.doc, sv))
        } else if (syncMsgType === MSG_SYNC_STEP2 || syncMsgType === MSG_SYNC_UPDATE) {
          // Apply update to doc
          const [updateLen, updateOffset] = decodeVarUint(rest, 0)
          const update = rest.slice(updateOffset, updateOffset + updateLen)
          Y.applyUpdate(entry.doc, update)
          entry.dirty = true
          // Broadcast to other clients
          broadcast(entry, data, ws)
        }
      } else if (msgType === MSG_AWARENESS) {
        // Store and broadcast awareness
        broadcast(entry, data, ws)
      }
    } catch (e) {
      console.warn('[yjs] message error:', e)
    }
  })

  ws.on('close', () => {
    entry.clients.delete(ws)
    if (entry.clients.size === 0) scheduleEvict(featureId)
  })
}
