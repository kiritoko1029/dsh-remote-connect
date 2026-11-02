/**
 * The local half: saved connections to remote DSHs and the port forwards that ride on them.
 *
 * One operation, two callers: the Web UI (through the HTTP API in index.js) and the agent tool both
 * go through {@link RemoteConnectManager.call}, so they can never disagree about behavior.
 */
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { hostname as osHostname } from 'node:os'
import { RemoteError, baseHref, classify, exchangeToken, fetchInfo, fetchPorts, normalizeRemoteUrl, openTunnel } from './remote.js'
import { RemoteMode } from './remote-mode.js'
import { RemoteOpen } from './remote-open.js'
import { ShareService } from './share.js'
import { bridge } from './tunnel.js'

const MAX_NAME = 80
const NETWORK_CODES = new Set(['refused', 'dns', 'timeout', 'reset', 'unreachable', 'tls', 'network'])

function text(value) {
  return typeof value === 'string' ? value : ''
}

function userError(code, message) {
  return new RemoteError(code, message)
}

function validPort(value, what, { allowZero = false } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 65535) {
    throw userError('bad-port', `${what} must be a port number between ${allowZero ? 0 : 1} and 65535`)
  }
  return number
}

function validHost(value, what) {
  const host = text(value).trim().replace(/^\[|\]$/g, '')
  if (host === '' || host.length > 253 || /[\s/\\@?#]/.test(host)) throw userError('bad-host', `${what} is not a valid host name or address`)
  return host
}

function validLocalHost(value) {
  const host = value === undefined || value === '' ? '127.0.0.1' : text(value).trim().replace(/^\[|\]$/g, '')
  if (host !== 'localhost' && net.isIP(host) === 0) throw userError('bad-host', 'The local address must be an IP address (for example 127.0.0.1 or 0.0.0.0)')
  return host
}

function mapListenError(error, host, port) {
  if (error && error.code === 'EADDRINUSE') return new RemoteError('port-in-use', `Local port ${host}:${port} is already in use`)
  if (error && error.code === 'EACCES') return new RemoteError('port-denied', `Not allowed to listen on ${host}:${port}`)
  if (error && error.code === 'EADDRNOTAVAIL') return new RemoteError('bad-host', `This machine has no address ${host}`)
  return new RemoteError('listen-failed', error instanceof Error ? error.message : String(error))
}

export class RemoteConnectManager {
  /**
   * @param {{
   *   store: import('./store.js').Store,
   *   settings: () => any,
   *   logger?: any,
   *   serverApi?: ReturnType<import('./server-api.js').createServerApi>,
   *   guiBridge?: ReturnType<import('./gui-bridge.js').createGuiBridge>,
   *   localDsh?: string,
   *   admit?: (req: import('node:http').IncomingMessage) => { peer?: unknown, rejection?: number },
   * }} deps `serverApi` enables the "share this computer" listener; `guiBridge` lets it (once the user
   *   allows it) serve this computer's DSH to the other computer. `localDsh` is this computer's DSH release
   *   and `admit` authenticates requests to this DSH (both used by remote mode).
   */
  constructor({ store, settings, logger, serverApi, guiBridge, localDsh, admit }) {
    this.store = store
    this.settings = settings
    this.logger = logger
    this.localDsh = localDsh
    this.mode = new RemoteMode({
      openTunnel: (connectionId, signal) => this.openTunnel(connectionId, '', 0, signal, { gui: true }),
      admit: admit ?? (() => ({ rejection: 401 })),
      logger,
    })
    // Opens the other computer's files with this computer's programs while the window uses its DSH.
    this.remoteOpen = new RemoteOpen({ mode: this.mode, local: guiBridge?.localRequest, settings, logger })
    this.conns = new Map()
    this.fwds = new Map()
    this.disposed = false
    const saved = store.load()
    this.loadError = saved.loadError
    for (const rec of saved.connections) this.conns.set(rec.id, this.makeConn(rec))
    for (const rec of saved.forwards) this.fwds.set(rec.id, this.makeFwd(rec))
    this.share = serverApi
      ? new ShareService({ settings, serverApi, logger, guiBridge, initial: saved.share, onChange: () => this.save() })
      : undefined
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /** Reconnect saved connections, re-open forwards and sharing flagged for it. Never throws. */
  restore() {
    if (!this.settings().restore) return
    for (const c of this.conns.values()) {
      if (!c.rec.autoConnect) continue
      c.wanted = true
      void this.attempt(c)
    }
    for (const f of this.fwds.values()) {
      if (f.rec.autoStart) this.startForward(f.rec.id).catch(() => undefined)
    }
    void this.share?.restore()
  }

  async dispose() {
    this.disposed = true
    // Before the tunnels are cut: unsent edits of opened remote files still need them.
    await this.remoteOpen.dispose()
    this.mode.dispose()
    for (const c of this.conns.values()) {
      c.wanted = false
      clearTimeout(c.timer)
      c.abort?.abort()
      for (const ws of c.tunnels) ws.destroy()
    }
    for (const f of this.fwds.values()) this.stopListening(f)
    try {
      this.store.flush()
    } catch (error) {
      this.logger?.warn?.(error)
    }
    await this.share?.dispose()
  }

  save() {
    this.store.schedule(() => ({
      connections: [...this.conns.values()].map((c) => ({ ...c.rec })),
      forwards: [...this.fwds.values()].map((f) => ({ ...f.rec })),
      share: this.share ? { ...this.share.rec } : undefined,
    }))
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime records
  // ---------------------------------------------------------------------------------------------

  makeConn(rec) {
    let base = null
    let error = null
    try {
      base = normalizeRemoteUrl(rec.url).base
    } catch (e) {
      error = { code: 'bad-url', message: e.message }
    }
    return { rec, base, status: 'idle', error, info: null, connectedAt: 0, latencyMs: null, wanted: false, failures: 0, timer: undefined, attempt: undefined, abort: undefined, auth: undefined, tunnels: new Set() }
  }

  makeFwd(rec) {
    return { rec, server: null, status: 'stopped', error: null, lastError: null, boundPort: 0, active: new Set(), total: 0, bytesIn: 0, bytesOut: 0, startedAt: 0, starting: undefined, generation: 0 }
  }

  conn(id) {
    const c = this.conns.get(text(id))
    if (!c) throw userError('not-found', `No saved connection with id ${text(id) || '(empty)'}`)
    return c
  }

  fwd(id) {
    const f = this.fwds.get(text(id))
    if (!f) throw userError('not-found', `No port forward with id ${text(id) || '(empty)'}`)
    return f
  }

  /** Resolve a connection by id, exact name, or unique name prefix (used by the agent tool). */
  resolveConn(ref) {
    const wanted = text(ref).trim()
    if (wanted === '') throw userError('bad-request', 'connection is required (a saved connection id or name)')
    const byId = this.conns.get(wanted)
    if (byId) return byId
    const lower = wanted.toLowerCase()
    const exact = [...this.conns.values()].filter((c) => c.rec.name.toLowerCase() === lower)
    if (exact.length === 1) return exact[0]
    const prefix = [...this.conns.values()].filter((c) => c.rec.name.toLowerCase().startsWith(lower) || c.rec.id.startsWith(wanted))
    if (prefix.length === 1) return prefix[0]
    throw userError('not-found', prefix.length > 1 || exact.length > 1 ? `"${wanted}" matches several connections; use the id` : `No saved connection matches "${wanted}"`)
  }

  // ---------------------------------------------------------------------------------------------
  // Connection health and authentication
  // ---------------------------------------------------------------------------------------------

  requestOptions(c, signal) {
    const cfg = this.settings()
    return { insecure: c.rec.insecure, timeoutMs: cfg.connectTimeoutMs, signal }
  }

  /** Exchange the saved token for a fresh session cookie. Concurrent callers share one exchange. */
  reauth(c, signal) {
    if (c.auth) return c.auth
    if (!c.base) return Promise.reject(userError('bad-url', 'The saved URL is invalid'))
    const run = (async () => {
      const cookie = await exchangeToken(c.base, c.rec.token, this.requestOptions(c, signal))
      c.rec.cookie = cookie
      this.save()
      return cookie
    })()
    c.auth = run
    run.then(
      () => {
        if (c.auth === run) c.auth = undefined
      },
      () => {
        if (c.auth === run) c.auth = undefined
      },
    )
    return run
  }

  async handshake(c, signal) {
    if (!c.base) throw userError('bad-url', 'The saved URL is invalid')
    const opts = this.requestOptions(c, signal)
    if (c.rec.cookie) {
      try {
        return await fetchInfo(c.base, c.rec.cookie, opts)
      } catch (error) {
        if (classify(error).code !== 'unauthorized') throw error
      }
    }
    const cookie = await this.reauth(c, signal)
    return fetchInfo(c.base, cookie, opts)
  }

  /** One connect/health attempt; concurrent callers share it. Never rejects. */
  attempt(c) {
    if (c.attempt) return c.attempt
    clearTimeout(c.timer)
    if (c.status !== 'connected') {
      c.status = 'connecting'
      c.error = null
    }
    const controller = new AbortController()
    c.abort = controller
    const run = (async () => {
      try {
        const { info, latencyMs } = await this.handshake(c, controller.signal)
        if (!c.wanted || controller.signal.aborted) return
        c.status = 'connected'
        c.error = null
        c.info = info
        c.latencyMs = latencyMs
        if (c.connectedAt === 0) c.connectedAt = Date.now()
        c.failures = 0
        this.schedule(c, Math.max(5000, this.settings().keepAliveSeconds * 1000))
      } catch (e) {
        const error = classify(e)
        if (error.code === 'aborted' || !c.wanted || controller.signal.aborted) return
        c.status = 'error'
        c.error = { code: error.code, message: error.message }
        c.connectedAt = 0
        c.failures += 1
        // A missing or rejected credential needs the user; everything else may heal on its own.
        if (error.code !== 'unauthorized' && error.code !== 'no-token') this.schedule(c, Math.min(30000, 2000 * 2 ** Math.min(c.failures - 1, 4)))
      }
    })()
    c.attempt = run
    run.then(() => {
      if (c.attempt === run) {
        c.attempt = undefined
        c.abort = undefined
      }
    })
    return run
  }

  schedule(c, delayMs) {
    clearTimeout(c.timer)
    if (this.disposed || !c.wanted) return
    c.timer = setTimeout(() => void this.attempt(c), delayMs)
    c.timer.unref?.()
  }

  /**
   * Open one tunnel through connection `connectionId` (re-authenticating once if the cookie went stale).
   * With `gui`, the tunnel carries the other computer's DSH web page instead of a TCP target.
   */
  async openTunnel(connectionId, host, port, signal, { gui = false } = {}) {
    const c = this.conn(connectionId)
    if (!c.base) throw userError('bad-url', 'The saved URL is invalid')
    const cfg = this.settings()
    const options = { host, port, gui, insecure: c.rec.insecure, timeoutMs: cfg.connectTimeoutMs, signal, keepAliveMs: cfg.keepAliveSeconds * 1000 }
    let cookie = c.rec.cookie || (await this.reauth(c, signal))
    let ws
    try {
      ws = await openTunnel(c.base, cookie, options)
    } catch (error) {
      if (classify(error).code !== 'unauthorized' || c.rec.token === '') throw error
      cookie = await this.reauth(c, signal)
      ws = await openTunnel(c.base, cookie, options)
    }
    c.tunnels.add(ws)
    ws.once('close', () => c.tunnels.delete(ws))
    return ws
  }

  // ---------------------------------------------------------------------------------------------
  // Forward listeners
  // ---------------------------------------------------------------------------------------------

  async accept(f, socket) {
    f.total += 1
    f.active.add(socket)
    socket.on('error', () => undefined)
    const controller = new AbortController()
    socket.once('close', () => {
      f.active.delete(socket)
      controller.abort()
    })
    try {
      const ws = await this.openTunnel(f.rec.connectionId, f.rec.remoteHost, f.rec.remotePort, controller.signal)
      if (socket.destroyed) {
        ws.destroy()
        return
      }
      f.lastError = null
      bridge(socket, ws, {
        onOut: (n) => {
          f.bytesOut += n
        },
        onIn: (n) => {
          f.bytesIn += n
        },
      })
      socket.resume()
    } catch (e) {
      const error = classify(e)
      socket.destroy()
      if (error.code === 'aborted') return
      f.lastError = { code: error.code, message: error.message, at: Date.now() }
      const c = this.conns.get(f.rec.connectionId)
      if (c && c.wanted && c.status === 'connected' && NETWORK_CODES.has(error.code)) void this.attempt(c)
    }
  }

  async listen(f, generation) {
    const host = f.rec.localHost
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => void this.accept(f, socket))
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({ host, port })
      })
    let wanted = f.rec.localPort
    try {
      try {
        await tryListen(wanted)
      } catch (error) {
        if (error && error.code === 'EADDRINUSE' && f.rec.autoPort && wanted !== 0) {
          wanted = 0
          await tryListen(0)
        } else {
          throw error
        }
      }
    } catch (error) {
      server.close()
      throw mapListenError(error, host, wanted)
    }
    if (generation !== f.generation || this.disposed) {
      server.close()
      return
    }
    f.server = server
    f.boundPort = server.address().port
    if (f.rec.autoPort && f.rec.localPort !== f.boundPort) {
      f.rec.localPort = f.boundPort
      this.save()
    }
    server.on('error', (error) => {
      f.status = 'error'
      f.error = { code: 'listen-failed', message: error.message }
    })
    f.status = 'listening'
    f.error = null
    f.startedAt = Date.now()
  }

  stopListening(f) {
    f.generation += 1
    const server = f.server
    f.server = null
    f.status = 'stopped'
    f.error = null
    f.boundPort = 0
    f.starting = undefined
    for (const socket of f.active) socket.destroy()
    f.active.clear()
    server?.close()
  }

  // ---------------------------------------------------------------------------------------------
  // Operations (every public method is reachable through call())
  // ---------------------------------------------------------------------------------------------

  async addConnection(params) {
    const { base, token: urlToken } = normalizeRemoteUrl(text(params.url))
    const url = baseHref(base)
    for (const other of this.conns.values()) {
      if (other.rec.url === url) throw userError('duplicate', `${url} is already saved as "${other.rec.name}"`)
    }
    const token = (text(params.token) || urlToken || '').trim()
    const name = text(params.name).trim().slice(0, MAX_NAME) || base.host
    const rec = { id: randomUUID(), name, url, token, cookie: '', insecure: params.insecure === true, autoConnect: params.autoConnect !== false, createdAt: Date.now() }
    const c = this.makeConn(rec)
    this.conns.set(rec.id, c)
    this.save()
    if (params.connect !== false) await this.connect(rec.id)
    return { connection: this.connView(c) }
  }

  async updateConnection(params) {
    const c = this.conn(params.id)
    let reset = false
    if (params.name !== undefined) c.rec.name = text(params.name).trim().slice(0, MAX_NAME) || c.rec.name
    if (params.url !== undefined && text(params.url).trim() !== '') {
      const { base, token } = normalizeRemoteUrl(text(params.url))
      const url = baseHref(base)
      for (const other of this.conns.values()) {
        if (other !== c && other.rec.url === url) throw userError('duplicate', `${url} is already saved as "${other.rec.name}"`)
      }
      if (url !== c.rec.url) {
        c.rec.url = url
        c.base = base
        c.error = null
        reset = true
      }
      if (token && text(params.token).trim() === '') {
        c.rec.token = token
        reset = true
      }
    }
    if (text(params.token).trim() !== '') {
      c.rec.token = text(params.token).trim()
      reset = true
    }
    if (params.insecure !== undefined && (params.insecure === true) !== c.rec.insecure) {
      c.rec.insecure = params.insecure === true
      reset = true
    }
    if (params.autoConnect !== undefined) c.rec.autoConnect = params.autoConnect === true
    if (reset) {
      c.rec.cookie = ''
      c.info = null
      for (const ws of c.tunnels) ws.destroy()
      c.abort?.abort()
      c.attempt = undefined
      c.auth = undefined
    }
    this.save()
    if (reset && c.wanted) await this.attempt(c)
    return { connection: this.connView(c) }
  }

  async removeConnection(params) {
    const c = this.conn(params.id)
    this.disconnectConn(c)
    for (const f of [...this.fwds.values()]) {
      if (f.rec.connectionId !== c.rec.id) continue
      this.stopListening(f)
      this.fwds.delete(f.rec.id)
    }
    this.conns.delete(c.rec.id)
    this.save()
    return { removed: c.rec.id }
  }

  async connect(id) {
    const c = this.conn(id)
    c.wanted = true
    // A manual connect always starts fresh, even if the background loop is waiting out a backoff.
    if (c.status === 'error') {
      clearTimeout(c.timer)
      c.failures = 0
    }
    await this.attempt(c)
    return { connection: this.connView(c) }
  }

  disconnectConn(c) {
    // The window must not stay pointed at a computer the user just disconnected from.
    if (this.mode.active === c.rec.id) this.mode.leave()
    c.wanted = false
    clearTimeout(c.timer)
    c.abort?.abort()
    c.attempt = undefined
    c.auth = undefined
    for (const ws of c.tunnels) ws.destroy()
    c.tunnels.clear()
    for (const f of this.fwds.values()) if (f.rec.connectionId === c.rec.id) this.stopListening(f)
    c.status = 'idle'
    c.error = null
    c.info = null
    c.connectedAt = 0
    c.latencyMs = null
    c.failures = 0
  }

  async disconnect(id) {
    const c = this.conn(id)
    this.disconnectConn(c)
    return { connection: this.connView(c) }
  }

  parseForward(params, existing) {
    const c = this.conn(params.connectionId ?? existing?.connectionId)
    const remotePort = validPort(params.remotePort ?? existing?.remotePort, 'The remote port')
    const remoteHost = params.remoteHost === undefined || text(params.remoteHost).trim() === '' ? (existing?.remoteHost ?? '127.0.0.1') : validHost(params.remoteHost, 'The remote host')
    let localHost = existing?.localHost ?? '127.0.0.1'
    if (params.localHost !== undefined) localHost = validLocalHost(params.localHost)
    else if (params.lan === true) localHost = '0.0.0.0'
    else if (params.lan === false) localHost = '127.0.0.1'
    let localPort
    let autoPort = existing?.autoPort ?? false
    if (params.localPort === undefined || params.localPort === null || params.localPort === '') {
      localPort = existing ? existing.localPort : remotePort
    } else {
      localPort = validPort(params.localPort, 'The local port', { allowZero: true })
      autoPort = localPort === 0
    }
    if (params.autoPort === true) autoPort = true
    return {
      id: existing?.id ?? randomUUID(),
      connectionId: c.rec.id,
      name: params.name !== undefined ? text(params.name).trim().slice(0, MAX_NAME) : (existing?.name ?? ''),
      remoteHost,
      remotePort,
      localHost,
      localPort,
      autoPort,
      autoStart: params.autoStart !== undefined ? params.autoStart === true : (existing?.autoStart ?? true),
    }
  }

  checkLocalConflict(rec) {
    if (rec.localPort === 0) return
    for (const other of this.fwds.values()) {
      if (other.rec.id === rec.id) continue
      if (other.rec.localPort === rec.localPort && other.rec.localHost === rec.localHost) {
        throw userError('duplicate', `Local port ${rec.localHost}:${rec.localPort} is already used by another forward`)
      }
    }
  }

  async addForward(params) {
    const rec = this.parseForward(params)
    this.checkLocalConflict(rec)
    const f = this.makeFwd(rec)
    this.fwds.set(rec.id, f)
    this.save()
    if (params.start !== false) await this.startForward(rec.id).catch(() => undefined)
    return { forward: this.fwdView(f) }
  }

  async updateForward(params) {
    const f = this.fwd(params.id)
    const next = this.parseForward(params, f.rec)
    this.checkLocalConflict(next)
    const changedBinding = next.localHost !== f.rec.localHost || next.localPort !== f.rec.localPort || next.remoteHost !== f.rec.remoteHost || next.remotePort !== f.rec.remotePort
    const wasRunning = f.status === 'listening' || f.status === 'starting'
    f.rec = next
    this.save()
    if (changedBinding && wasRunning) {
      this.stopListening(f)
      await this.startForward(next.id).catch(() => undefined)
    }
    return { forward: this.fwdView(f) }
  }

  async removeForward(params) {
    const f = this.fwd(params.id)
    this.stopListening(f)
    this.fwds.delete(f.rec.id)
    this.save()
    return { removed: f.rec.id }
  }

  async startForward(id) {
    const f = this.fwd(id)
    if (f.status === 'listening') return { forward: this.fwdView(f) }
    if (f.starting) {
      await f.starting
      return { forward: this.fwdView(f) }
    }
    const c = this.conn(f.rec.connectionId)
    c.wanted = true
    if (c.status !== 'connected' && !c.attempt) void this.attempt(c)
    f.status = 'starting'
    f.error = null
    const generation = ++f.generation
    const run = this.listen(f, generation).catch((error) => {
      if (generation !== f.generation) return
      const e = classify(error)
      f.status = 'error'
      f.error = { code: e.code, message: e.message }
    })
    f.starting = run
    await run
    if (f.starting === run) f.starting = undefined
    return { forward: this.fwdView(f) }
  }

  async stopForward(id) {
    const f = this.fwd(id)
    this.stopListening(f)
    return { forward: this.fwdView(f) }
  }

  async listRemotePorts(id) {
    const c = this.conn(id)
    if (!c.base) throw userError('bad-url', 'The saved URL is invalid')
    const opts = this.requestOptions(c)
    let cookie = c.rec.cookie || (await this.reauth(c))
    try {
      return await fetchPorts(c.base, cookie, opts)
    } catch (error) {
      if (classify(error).code !== 'unauthorized' || c.rec.token === '') throw error
      cookie = await this.reauth(c)
      return fetchPorts(c.base, cookie, opts)
    }
  }

  /** The URL a browser opens to use the remote DSH directly (carries the token: user-initiated only). */
  async openUrl(id) {
    const c = this.conn(id)
    const url = c.base ? new URL(baseHref(c.base) + '/') : null
    if (!url) throw userError('bad-url', 'The saved URL is invalid')
    if (c.info?.via === 'share') throw userError('share-only', 'This is a sharing endpoint: it only forwards ports, it does not serve the DSH web page')
    if (c.rec.token) url.searchParams.set('token', c.rec.token)
    return { url: url.href }
  }

  /**
   * How the other computer's DSH release compares with this one's. Switching reuses this computer's UI
   * against the other computer's API, so only an identical release is safe.
   */
  compat(c) {
    const local = this.localDsh ?? null
    if (!c.info) return { local, remote: null, status: 'unknown' }
    if (!c.info.dsh) return { local, remote: null, status: 'remote-old' }
    const remote = c.info.dsh.version ?? null
    if (local === null || remote === null) return { local, remote, status: 'unknown' }
    return { local, remote, status: local === remote ? 'same' : 'different' }
  }

  /**
   * Switch this computer's DSH window onto the other computer's DSH: its sessions, workspaces, files and
   * agent. The UI stays this computer's own; only the data source changes (see remote-mode.js).
   */
  async modeEnter(id) {
    const c = this.conn(id)
    if (!this.mode.supported) throw userError('mode-unsupported', `Switching is not available in this DSH (${this.mode.reason})`)
    if (c.status !== 'connected') await this.connect(id)
    if (c.status !== 'connected') throw userError(c.error?.code ?? 'not-connected', c.error?.message ?? 'The connection is not established')
    // The cached description can be up to a health-check interval old, and the other computer's user may
    // have just switched remote control on: look again before saying no.
    if (!c.info?.gui?.enabled) {
      await this.attempt(c)
      if (c.status !== 'connected') throw userError(c.error?.code ?? 'not-connected', c.error?.message ?? 'The connection is not established')
    }
    const gui = c.info?.gui
    if (!gui) throw userError('remote-old', 'The other computer runs an older Remote Connect that cannot be switched to; update the plugin there')
    if (!gui.enabled) throw userError('gui-off', 'Remote control is off on the other computer: turn on "Allow remote control" in its Remote Connect panel')
    const compat = this.compat(c)
    if (compat.status === 'remote-old') throw userError('remote-old', 'The other computer does not report its DSH version; update Remote Connect there')
    if (compat.status !== 'same' && !this.settings().allowVersionMismatch) {
      throw userError(
        'version-mismatch',
        compat.status === 'different'
          ? `This computer runs DSH ${compat.local} and the other runs ${compat.remote}. The window can only be switched between the same release: install the same DSH version on both`
          : 'Could not determine the DSH version of one of the computers, so compatibility cannot be checked (allowVersionMismatch: true skips the check)',
      )
    }
    this.mode.enter(c.rec.id)
    return { mode: this.modeView() }
  }

  /** Switch back to this computer's own DSH. */
  async modeLeave() {
    this.mode.leave()
    return { mode: this.modeView() }
  }

  modeView() {
    const c = this.mode.active ? this.conns.get(this.mode.active) : undefined
    return {
      supported: this.mode.supported,
      reason: this.mode.supported ? '' : this.mode.reason,
      active: this.mode.active,
      name: c ? c.rec.name : '',
      connected: c ? c.status === 'connected' : false,
      since: this.mode.since,
      localVersion: this.localDsh ?? null,
      allowVersionMismatch: this.settings().allowVersionMismatch === true,
    }
  }

  requireShare() {
    if (!this.share) throw userError('share-disabled', 'Sharing is not available in this composition')
    return this.share
  }

  // ---------------------------------------------------------------------------------------------
  // Views (never include tokens or cookies)
  // ---------------------------------------------------------------------------------------------

  connView(c) {
    const info = c.info
    return {
      id: c.rec.id,
      name: c.rec.name,
      url: c.base ? baseHref(c.base) : c.rec.url,
      host: c.base ? c.base.host : c.rec.url,
      secure: c.base?.protocol === 'https:',
      status: c.status,
      error: c.error,
      hasToken: c.rec.token !== '',
      insecure: c.rec.insecure,
      autoConnect: c.rec.autoConnect,
      wanted: c.wanted,
      connectedAt: c.connectedAt,
      latencyMs: c.latencyMs,
      tunnels: c.tunnels.size,
      info: info
        ? {
            hostname: info.hostname,
            platform: info.platform,
            arch: info.arch,
            user: info.user,
            version: info.version,
            via: info.via === 'share' ? 'share' : 'dsh',
            web: info.web ?? null,
            gui: info.gui && typeof info.gui === 'object' ? { enabled: info.gui.enabled === true } : null,
            dsh: info.dsh && typeof info.dsh === 'object' ? { version: typeof info.dsh.version === 'string' ? info.dsh.version : null } : null,
            server: info.server,
          }
        : null,
      compat: this.compat(c),
      active: this.mode.active === c.rec.id,
    }
  }

  fwdView(f) {
    const local = f.rec.localHost === '0.0.0.0' || f.rec.localHost === '::' ? '127.0.0.1' : f.rec.localHost
    return {
      id: f.rec.id,
      connectionId: f.rec.connectionId,
      name: f.rec.name,
      remoteHost: f.rec.remoteHost,
      remotePort: f.rec.remotePort,
      localHost: f.rec.localHost,
      localPort: f.rec.localPort,
      autoPort: f.rec.autoPort,
      autoStart: f.rec.autoStart,
      status: f.status,
      error: f.error,
      lastError: f.lastError,
      boundPort: f.boundPort,
      url: f.boundPort ? `http://${local.includes(':') ? `[${local}]` : local}:${f.boundPort}` : '',
      lan: f.rec.localHost === '0.0.0.0' || f.rec.localHost === '::',
      active: f.active.size,
      total: f.total,
      bytesIn: f.bytesIn,
      bytesOut: f.bytesOut,
      startedAt: f.startedAt,
    }
  }

  state() {
    const cfg = this.settings()
    return {
      now: Date.now(),
      hostname: osHostname(),
      serverEnabled: cfg.serverEnabled,
      loadError: this.loadError,
      share: this.share ? this.share.view() : null,
      mode: this.modeView(),
      connections: [...this.conns.values()].map((c) => this.connView(c)),
      forwards: [...this.fwds.values()].map((f) => this.fwdView(f)),
      /** Opened remote files whose edits are not on the other computer yet (or were refused because it changed). */
      pendingFiles: this.remoteOpen.pending(),
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Dispatch shared by the HTTP API and the agent tool
  // ---------------------------------------------------------------------------------------------

  async call(method, params = {}) {
    const p = params && typeof params === 'object' ? params : {}
    switch (method) {
      case 'state':
        return this.state()
      case 'addConnection':
        return this.addConnection(p)
      case 'updateConnection':
        return this.updateConnection(p)
      case 'removeConnection':
        return this.removeConnection(p)
      case 'connect':
        return this.connect(p.id)
      case 'disconnect':
        return this.disconnect(p.id)
      case 'addForward':
        return this.addForward(p)
      case 'updateForward':
        return this.updateForward(p)
      case 'removeForward':
        return this.removeForward(p)
      case 'startForward':
        return this.startForward(p.id)
      case 'stopForward':
        return this.stopForward(p.id)
      case 'listRemotePorts':
        return this.listRemotePorts(p.id)
      case 'openUrl':
        return this.openUrl(p.id)
      case 'modeEnter':
        return this.modeEnter(p.id)
      case 'modeLeave':
        return this.modeLeave()
      case 'shareEnable':
        await this.requireShare().enable(p)
        return { share: this.share.view() }
      case 'shareDisable':
        await this.requireShare().disable()
        return { share: this.share.view() }
      case 'shareUpdate':
        await this.requireShare().update(p)
        return { share: this.share.view() }
      case 'shareRotate':
        await this.requireShare().rotate()
        return { share: this.share.view() }
      case 'shareAddress':
        return this.requireShare().address()
      default:
        throw userError('bad-request', `Unknown method ${String(method)}`)
    }
  }
}
