/**
 * Open a remote computer's file with a program on THIS computer.
 *
 * While the window runs on another computer's DSH (remote-mode.js), the file controls of the UI ("Open",
 * "Open with", "Show file location") ask the remote Host to open a path on ITS desktop, which nobody is
 * sitting at. This module answers those three calls here instead:
 *
 *   session/canOpenWorkspacePath     -> this computer's answer (is there a desktop to open things on?)
 *   session/workspacePathApplications -> this computer's programs for that file type
 *   session/openWorkspacePath         -> copy the file here, then have this computer's DSH open the copy
 *
 * The program is therefore chosen by the file's type on this computer, exactly as for a local file: the
 * calls are forwarded to the local Host with the temporary copy's path (a same-named empty probe file for
 * the program list). The copy lives in a private temporary folder. A poller notices when the copy changes
 * (also when an editor saves by replacing the file) and sends it back to the other computer with the etag
 * it last saw; if that computer's file changed meanwhile, nothing is overwritten and the copy is kept.
 * A copy that is in sync, not held open by any program and untouched for `openCleanupMinutes` is deleted;
 * so is every synced copy when this DSH shuts down. Copies that could not be synced are never deleted.
 */
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { HOP_HEADER } from './gui-bridge.js'
import { ROUTE_PREFIX } from './remote.js'

const API = '/api/session/'
export const OPEN = `${API}openWorkspacePath`
export const APPLICATIONS = `${API}workspacePathApplications`
export const CAN_OPEN = `${API}canOpenWorkspacePath`

const FILE_ROUTE = `${ROUTE_PREFIX}/file`
const MAX_BODY = 64 * 1024
const POLL_MS = 1000
const STALE_MS = 24 * 3600 * 1000
const MB = 1024 * 1024

class OpenError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function pathOf(req) {
  return String(req.url ?? '/').split('?', 1)[0]
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new OpenError('bad-request', 'Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function readAll(response) {
  return new Promise((resolve, reject) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve(Buffer.concat(chunks)))
    response.on('error', reject)
  })
}

async function readJson(response) {
  try {
    return JSON.parse((await readAll(response)).toString('utf8'))
  } catch {
    return {}
  }
}

/** A file name that is safe inside a temporary folder and keeps the extension that picks the program. */
export function safeName(remotePath) {
  const last = String(remotePath).split(/[\\/]/).filter(Boolean).pop() ?? ''
  const cleaned = last.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 200)
}

const signature = (st) => `${st.mtimeMs}:${st.size}`

function lsofHolds(path) {
  if (process.platform === 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('lsof', ['-t', '--', path], { timeout: 3000 }, (error, stdout) => resolve(!error && String(stdout).trim() !== ''))
  })
}

/**
 * @param {{
 *   mode: import('./remote-mode.js').RemoteMode,
 *   local?: (request: { method?: string, path: string, headers?: Record<string, string>, body?: Buffer }) => Promise<{ status: number, headers: Record<string, any>, body: Buffer }>,
 *   settings: () => any,
 *   logger?: any,
 *   root?: string,
 *   isHeld?: (path: string) => Promise<boolean>,
 *   pollMs?: number,
 * }} deps `local` asks this computer's own DSH (the gui bridge's `localRequest`); `root` is where copies live.
 */
export class RemoteOpen {
  constructor({ mode, local, settings, logger, root, isHeld, pollMs }) {
    this.mode = mode
    this.local = local
    this.settings = settings
    this.logger = logger
    this.root = root ?? join(tmpdir(), `dsh-remote-open-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
    this.isHeld = isHeld ?? lsofHolds
    this.pollMs = pollMs ?? POLL_MS
    /** @type {Map<string, any>} */
    this.entries = new Map()
    this.timer = undefined
    this.ticking = false
    this.disposed = false
    this.purged = false
  }

  // ---------------------------------------------------------------------------------------------
  // Request interception (called from the `connection/request` hook)
  // ---------------------------------------------------------------------------------------------

  /** Whether this request is one of the three file calls, made while the window uses another computer. */
  claims(req) {
    const path = pathOf(req)
    const ours = path === OPEN || path === APPLICATIONS || path === CAN_OPEN
    const why = this.disposed
      ? 'disposed'
      : !this.local
        ? 'no local bridge'
        : !this.settings().openRemoteFiles
          ? 'openRemoteFiles is off'
          : this.mode.activeId === null
            ? 'not using a remote DSH'
            : req.method !== 'POST'
              ? `method ${req.method}`
              : req.headers[HOP_HEADER] !== undefined
                ? 'already relayed'
                : !ours
                  ? 'other endpoint'
                  : ''
    if (ours) this.trace(`claims ${path}: ${why === '' ? 'yes' : `no (${why})`}`)
    return why === ''
  }

  /** Diagnostics for this feature: one line per decision in `<DSH_HOME>/remote-connect/open.log` (emptied when large). */
  trace(message) {
    this.logger?.info?.(`remote-connect: ${message}`)
    try {
      const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'remote-connect', 'open.log')
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > 256 * 1024) writeFileSync(file, '')
      } catch {
        /* first line */
      }
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* diagnostics must never break the call */
    }
  }

  async handle(req, res) {
    const endpoint = pathOf(req)
    let envelope
    try {
      envelope = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
      if (envelope === null || typeof envelope !== 'object' || typeof envelope.rpcId !== 'string') throw new Error('bad envelope')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Invalid request.\n')
      return
    }
    const rpcId = envelope.rpcId
    // `args` is an object keyed by parameter name: `{}` for canOpenWorkspacePath, `{ request: { path, … } }` for the others.
    const payloadArgs = envelope.payload && envelope.payload.args
    const args = payloadArgs !== null && typeof payloadArgs === 'object' && !Array.isArray(payloadArgs) ? payloadArgs : {}
    try {
      if (endpoint === CAN_OPEN) return await this.relay(res, endpoint, envelope, args)
      const key = Object.keys(args).find((name) => args[name] !== null && typeof args[name] === 'object' && typeof args[name].path === 'string')
      const remotePath = key === undefined ? '' : args[key].path
      if (remotePath === '') throw new OpenError('bad-request', 'path is required')
      const withPath = (path) => ({ ...args, [key]: { ...args[key], path } })
      if (endpoint === APPLICATIONS) return await this.applications(res, envelope, withPath, remotePath)
      return await this.open(res, envelope, withPath, remotePath)
    } catch (error) {
      const known = error instanceof OpenError
      this.trace(`${endpoint} failed: ${error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : error}`)
      if (!known) this.logger?.warn?.(error)
      return this.fail(res, rpcId, known ? error.code : 'internal', known ? error.message : 'Could not open the remote file')
    }
  }

  fail(res, rpcId, code, message) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: `remote-connect/${code}`, message, details: {} } } }))
  }

  ok(res, rpcId, value) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
  }

  /** Ask this computer's own DSH the same call with different arguments and return its answer to the window. */
  async callLocal(endpoint, envelope, args) {
    const body = Buffer.from(JSON.stringify({ ...envelope, payload: { ...envelope.payload, args } }))
    return this.local({ method: 'POST', path: endpoint, headers: { 'content-type': 'application/json' }, body })
  }

  async relay(res, endpoint, envelope, args) {
    const answer = await this.callLocal(endpoint, envelope, args)
    this.trace(`local ${endpoint} -> HTTP ${answer.status} ${answer.body.toString('utf8').slice(0, 300)}`)
    res.writeHead(answer.status, { 'content-type': String(answer.headers['content-type'] ?? 'application/json'), 'cache-control': 'no-store' })
    res.end(answer.body)
  }

  // ---------------------------------------------------------------------------------------------
  // The calls
  // ---------------------------------------------------------------------------------------------

  /** The programs on THIS computer for the file's type: ask the local Host about an empty probe file of that type. */
  async applications(res, envelope, withPath, remotePath) {
    let value = []
    try {
      const probe = await this.probe(remotePath)
      const answer = await this.callLocal(APPLICATIONS, envelope, withPath(probe))
      this.trace(`local applications for ${probe} -> HTTP ${answer.status} ${answer.body.toString('utf8').slice(0, 300)}`)
      const parsed = JSON.parse(answer.body.toString('utf8'))
      if (answer.status === 200 && parsed && parsed.result && parsed.result.ok === true && Array.isArray(parsed.result.value)) value = parsed.result.value
    } catch (error) {
      this.logger?.info?.(`remote-connect: listing local programs failed: ${error.message}`)
    }
    // Empty means "no program known": the window then offers to show the file's location instead.
    this.ok(res, envelope.rpcId, value)
  }

  /**
   * Create the private folder and settle on its real path. The local Host only opens a path that equals its own
   * resolved form (`realpath(p) === p`), and the system temporary folder is a symlink on macOS
   * (`/var/folders/...` is `/private/var/folders/...`), so every path handed to it must start from the real one.
   */
  ready() {
    this.rootReady ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      this.root = await realpath(this.root)
    })().catch((error) => {
      this.rootReady = undefined
      throw error
    })
    return this.rootReady
  }

  async probe(remotePath) {
    await this.ready()
    const extension = extname(safeName(remotePath)).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16)
    const dir = join(this.root, 'probe', extension === '' ? 'none' : extension.slice(1))
    const file = join(dir, `probe${extension}`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(file, '', { flag: 'a', mode: 0o600 })
    return file
  }

  async open(res, envelope, withPath, remotePath) {
    const connectionId = this.mode.activeId
    if (connectionId === null) throw new OpenError('mode-ended', 'This window is no longer using the other computer')
    const entry = await this.ensureCopy(connectionId, remotePath)
    entry.lastActivity = Date.now()
    const answer = await this.callLocal(OPEN, envelope, withPath(entry.localPath))
    this.trace(`local open of ${entry.localPath} -> HTTP ${answer.status} ${answer.body.toString('utf8').slice(0, 300)}`)
    this.start()
    res.writeHead(answer.status, { 'content-type': String(answer.headers['content-type'] ?? 'application/json'), 'cache-control': 'no-store' })
    res.end(answer.body)
  }

  // ---------------------------------------------------------------------------------------------
  // Copies
  // ---------------------------------------------------------------------------------------------

  /** One HTTP request to the other computer's DSH through a fresh tunnel (the caller reads or drops the response). */
  remote(connectionId, { method, path, headers = {}, body }) {
    const agent = this.mode.makeAgent(connectionId, { keepAlive: false })
    return new Promise((resolve, reject) => {
      const request = http.request(
        { agent, host: 'remote-dsh', port: 80, method, path, headers: { host: 'remote-dsh', [HOP_HEADER]: '1', ...headers } },
        (response) => {
          response.once('close', () => agent.destroy())
          resolve(response)
        },
      )
      request.on('error', (error) => {
        agent.destroy()
        reject(error)
      })
      if (body) {
        body.on('error', (error) => request.destroy(error))
        body.pipe(request)
      } else {
        request.end()
      }
    })
  }

  async remoteMeta(connectionId, remotePath) {
    const response = await this.remote(connectionId, { method: 'GET', path: `${FILE_ROUTE}?stat=1&path=${encodeURIComponent(remotePath)}` })
    const json = await readJson(response)
    if (response.statusCode === 404 && json.ok === undefined) throw new OpenError('remote-old', "The other computer's Remote Connect is too old to open files. Update the plugin there.")
    if (response.statusCode !== 200) throw this.remoteError(response.statusCode, json)
    return json
  }

  remoteError(status, json) {
    const error = json && json.error ? json.error : {}
    if (status === 403 && error.code === undefined) return new OpenError('remote-forbidden', 'The other computer does not allow Remote Connect to read its files')
    return new OpenError(`remote-${error.code ?? status}`, String(error.message ?? `The other computer refused (HTTP ${status})`))
  }

  async ensureCopy(connectionId, remotePath) {
    await this.ready()
    const key = `${connectionId}\0${remotePath}`
    let entry = this.entries.get(key)
    const meta = await this.remoteMeta(connectionId, remotePath)
    if (meta.kind !== 'file') throw new OpenError('not-a-file', meta.kind === 'directory' ? 'Folders cannot be opened this way' : 'Only regular files can be opened')
    const limit = this.settings().fileMaxMB * MB
    if (meta.size > limit) throw new OpenError('too-large', `The file is larger than the ${this.settings().fileMaxMB} MB limit`)

    if (entry && (entry.dirty || entry.conflict || entry.uploading)) return entry // never overwrite edits that are not on the other computer yet
    if (entry && entry.etag === meta.etag) {
      try {
        await stat(entry.localPath)
        return entry
      } catch {
        /* the copy was removed meanwhile: fetch it again */
      }
    }
    if (!entry) {
      const id = createHash('sha256').update(key).digest('hex').slice(0, 16)
      const localDir = join(this.root, id)
      entry = { key, connectionId, remotePath, localDir, localPath: join(localDir, safeName(remotePath)), etag: '', sig: '', pendingSig: '', dirty: false, conflict: false, uploading: false, failures: 0, lastActivity: Date.now() }
    }
    await this.download(entry)
    this.entries.set(key, entry)
    return entry
  }

  async download(entry) {
    await this.purgeStale()
    await mkdir(entry.localDir, { recursive: true, mode: 0o700 })
    const response = await this.remote(entry.connectionId, { method: 'GET', path: `${FILE_ROUTE}?path=${encodeURIComponent(entry.remotePath)}` })
    if (response.statusCode !== 200) throw this.remoteError(response.statusCode, await readJson(response))
    const etag = String(response.headers.etag ?? '')
    const part = `${entry.localPath}.part`
    try {
      await pipeline(response, createWriteStream(part, { mode: 0o600 }))
      await rename(part, entry.localPath)
    } catch (error) {
      await rm(part, { force: true })
      throw new OpenError('download-failed', `Could not copy the file from the other computer (${error.message})`)
    }
    const st = await stat(entry.localPath)
    entry.etag = etag
    entry.sig = signature(st)
    entry.pendingSig = entry.sig
    entry.dirty = false
    entry.failures = 0
  }

  async upload(entry) {
    entry.uploading = true
    try {
      const st = await stat(entry.localPath)
      const response = await this.remote(entry.connectionId, {
        method: 'PUT',
        path: `${FILE_ROUTE}?path=${encodeURIComponent(entry.remotePath)}`,
        headers: { 'if-match': entry.etag, 'content-type': 'application/octet-stream', 'content-length': String(st.size) },
        body: createReadStream(entry.localPath),
      })
      const json = await readJson(response)
      if (response.statusCode === 200) {
        entry.etag = String(json.etag)
        entry.sig = signature(st)
        entry.dirty = entry.pendingSig !== entry.sig
        entry.failures = 0
        entry.conflict = false
      } else if (response.statusCode === 412) {
        entry.conflict = true
        this.logger?.warn?.(`remote-connect: ${entry.remotePath} changed on the other computer; your edited copy is kept at ${entry.localPath}`)
      } else {
        throw this.remoteError(response.statusCode, json)
      }
    } finally {
      entry.uploading = false
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Watching, syncing, cleaning
  // ---------------------------------------------------------------------------------------------

  start() {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  /** One pass over every copy: notice edits, send settled ones back, delete the ones that are done. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const entry of [...this.entries.values()]) {
        if (entry.uploading) continue
        let st
        try {
          st = await stat(entry.localPath)
        } catch {
          continue // mid-replace by an editor, or removed by the user
        }
        const sig = signature(st)
        if (sig !== entry.sig && !entry.conflict) {
          entry.lastActivity = Date.now()
          entry.dirty = true
          if (sig !== entry.pendingSig) {
            entry.pendingSig = sig // still changing: wait for it to settle
            continue
          }
          if (entry.failures > 0 && Date.now() < (entry.retryAt ?? 0)) continue
          try {
            await this.upload(entry)
          } catch (error) {
            entry.failures += 1
            entry.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** entry.failures)
            this.logger?.info?.(`remote-connect: sending ${entry.remotePath} back failed: ${error.message}`)
          }
          continue
        }
        if (sig === entry.sig) entry.dirty = false // edited and put back: identical to what the other computer has
        if (!entry.dirty && !entry.conflict && Date.now() - entry.lastActivity >= this.settings().openCleanupMinutes * 60_000) {
          if (await this.isHeld(entry.localPath)) {
            entry.lastActivity = Date.now() - this.settings().openCleanupMinutes * 60_000 + 60_000 // look again in a minute
            continue
          }
          await this.remove(entry)
        }
      }
      if (this.entries.size === 0) this.stop()
    } finally {
      this.ticking = false
    }
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  async remove(entry) {
    this.entries.delete(entry.key)
    await rm(entry.localDir, { recursive: true, force: true })
  }

  /** Leftovers of earlier runs (a crash, a kill) older than a day. Done once, before the first copy of this run. */
  async purgeStale() {
    if (this.purged) return
    this.purged = true
    let names = []
    try {
      names = await readdir(this.root)
    } catch {
      return
    }
    for (const name of names) {
      if (name === 'probe') continue
      const dir = join(this.root, name)
      try {
        if (Date.now() - (await stat(dir)).mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true })
      } catch {
        /* gone already */
      }
    }
  }

  /** What the panel can show: copies that are not on the other computer yet. */
  pending() {
    return [...this.entries.values()]
      .filter((entry) => entry.dirty || entry.conflict)
      .map((entry) => ({ connectionId: entry.connectionId, remotePath: entry.remotePath, localPath: entry.localPath, conflict: entry.conflict }))
  }

  /** Shutdown: send what is still unsent (briefly), then delete every copy that is in sync. Unsynced copies stay. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    const flush = Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        if (entry.conflict || entry.uploading) return
        try {
          const st = await stat(entry.localPath)
          if (signature(st) !== entry.sig) {
            entry.pendingSig = signature(st)
            await this.upload(entry)
          }
        } catch (error) {
          this.logger?.info?.(`remote-connect: could not send ${entry.remotePath} back at shutdown: ${error.message}`)
        }
      }),
    )
    await Promise.race([flush, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())])
    for (const entry of [...this.entries.values()]) {
      let synced = !entry.conflict
      try {
        synced = synced && signature(await stat(entry.localPath)) === entry.sig
      } catch {
        synced = true // the copy is already gone
      }
      if (synced) await this.remove(entry)
      else this.logger?.warn?.(`remote-connect: unsynced copy of ${entry.remotePath} kept at ${entry.localPath}`)
    }
    await rm(join(this.root, 'probe'), { recursive: true, force: true })
    await rmdir(this.root).catch(() => undefined) // only succeeds when nothing is left
  }
}
