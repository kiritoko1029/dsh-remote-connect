/**
 * "Share this computer": a dedicated listener that lets another computer's Remote Connect forward
 * ports of this one, without going through DSH's own web server.
 *
 * Why it exists: the DSH desktop app starts its web server with `--host 127.0.0.1 --port 0` (this
 * machine only, a new random port every launch) and hands the tokenized URL to its own window over
 * IPC, so there is no address a second computer could use or a user could copy. This listener fixes
 * both: it binds a network address on a port that is remembered across restarts, and it has its own
 * token, which only grants port forwarding. It is never DSH's owner token.
 *
 * Wire shape is deliberately identical to the DSH-side routes (`GET /?token=` -> 303 + cookie,
 * `/remote-connect/info|ports|tunnel`), so the client code path is the same for both.
 *
 * Hardening: browsers are refused outright (any `Origin`/`Sec-Fetch-*` header), failed token
 * exchanges are rate-limited per address, and the token is 256 random bits compared in constant time.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { isWildcard, listAddresses, urlHost } from './netinfo.js'
import { ROUTE_PREFIX, RemoteError } from './remote.js'
import { createTunnelServer } from './tunnel.js'

const COOKIE_NAME = 'dsh-auth-rc'
const COOKIE_DAYS = 30
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 60_000

const secretBytes = () => randomBytes(32).toString('base64url')

function text(res, status, message) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`${message}\n`)
}

function json(res, value) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function tokenMatches(actual, expected) {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b)
}

function mapListenError(error, host, port) {
  if (error && error.code === 'EADDRINUSE') return new RemoteError('port-in-use', `Port ${port} on ${host} is already in use`)
  if (error && error.code === 'EACCES') return new RemoteError('port-denied', `Not allowed to listen on port ${port}`)
  if (error && error.code === 'EADDRNOTAVAIL') return new RemoteError('bad-host', `This computer has no address ${host}`)
  return new RemoteError('listen-failed', error instanceof Error ? error.message : String(error))
}

function validHost(value) {
  const host = String(value ?? '').trim().replace(/^\[|\]$/g, '')
  if (net.isIP(host) === 0) throw new RemoteError('bad-host', 'The listening address must be an IP address (0.0.0.0 = every network interface)')
  return host
}

function validPort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RemoteError('bad-port', 'The port must be a number between 0 and 65535')
  return port
}

export class ShareService {
  /**
   * @param {{
   *   settings: () => any,
   *   serverApi: ReturnType<import('./server-api.js').createServerApi>,
   *   logger?: any,
   *   initial?: Partial<{enabled: boolean, host: string, port: number, advertise: string, token: string, secret: string, gui: boolean}>,
   *   guiBridge?: ReturnType<import('./gui-bridge.js').createGuiBridge>,
   *   onChange: () => void,
   * }} deps `guiBridge` serves this computer's DSH web page to clients the user allowed to control it.
   */
  constructor({ settings, serverApi, logger, initial, guiBridge, onChange }) {
    this.settings = settings
    this.serverApi = serverApi
    this.logger = logger
    this.onChange = onChange
    this.rec = { enabled: false, host: '0.0.0.0', port: 0, advertise: '', token: '', secret: '', gui: false, ...(initial ?? {}) }
    this.server = null
    this.starting = undefined
    this.status = 'stopped'
    this.error = null
    this.notice = null
    this.boundPort = 0
    this.sockets = new Set()
    this.failures = new Map()
    this.tunnels = createTunnelServer({
      connection: { admit: (req) => this.admit(req) },
      settings,
      logger,
      gui: guiBridge ? { enabled: () => this.guiEnabled(), serve: (duplex) => guiBridge.serve(duplex) } : undefined,
    })
    this.hasGui = guiBridge !== undefined
  }

  allowed() {
    const cfg = this.settings()
    return cfg.shareAllowed !== false && cfg.serverEnabled !== false
  }

  /** Whether the user allowed share-door clients to open this computer's DSH (and the configuration permits it). */
  guiEnabled() {
    return this.hasGui && this.rec.gui === true && this.settings().remoteControlAllowed !== false
  }

  ensureSecrets() {
    let changed = false
    if (this.rec.token === '') {
      this.rec.token = secretBytes()
      changed = true
    }
    if (this.rec.secret === '') {
      this.rec.secret = secretBytes()
      changed = true
    }
    if (changed) this.onChange()
  }

  // ---------------------------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------------------------

  mac(expires) {
    return createHmac('sha256', Buffer.from(this.rec.secret, 'base64url')).update(`v1.${expires}`).digest('base64url')
  }

  cookieHeader() {
    const maxAge = COOKIE_DAYS * 86400
    const expires = Date.now() + maxAge * 1000
    return `${COOKIE_NAME}=v1.${expires}.${this.mac(expires)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`
  }

  cookieValid(req) {
    if (this.rec.secret === '') return false
    const header = String(req.headers.cookie ?? '')
    for (const part of header.split(';')) {
      const at = part.indexOf('=')
      if (at === -1 || part.slice(0, at).trim() !== COOKIE_NAME) continue
      const [version, expires, mac] = part.slice(at + 1).trim().split('.')
      if (version !== 'v1' || !/^\d+$/.test(expires ?? '') || Number(expires) <= Date.now() || !mac) return false
      return tokenMatches(mac, this.mac(expires))
    }
    return false
  }

  admit(req) {
    return this.cookieValid(req) ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }
  }

  limited(ip) {
    const entry = this.failures.get(ip)
    if (!entry) return false
    if (Date.now() > entry.resetAt) {
      this.failures.delete(ip)
      return false
    }
    return entry.count >= MAX_FAILURES
  }

  fail(ip) {
    const now = Date.now()
    const entry = this.failures.get(ip)
    if (!entry || now > entry.resetAt) this.failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
    else entry.count += 1
    if (this.failures.size > 1000) {
      for (const [key, value] of this.failures) if (now > value.resetAt) this.failures.delete(key)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP surface
  // ---------------------------------------------------------------------------------------------

  /** Browsers always send Origin and/or Sec-Fetch-*; Remote Connect clients are Node and send neither. */
  fromBrowser(req) {
    return req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined
  }

  async handle(req, res) {
    if (this.fromBrowser(req)) return text(res, 403, 'Browsers are not allowed on this endpoint.')
    const ip = req.socket.remoteAddress ?? ''
    let url
    try {
      url = new URL(req.url ?? '/', 'http://share.invalid')
    } catch {
      return text(res, 400, 'Bad request.')
    }
    if (req.method !== 'GET') return text(res, 405, 'Method not allowed.')

    if (url.pathname === '/') {
      if (this.limited(ip)) return text(res, 429, 'Too many failed attempts. Try again in a minute.')
      const tokens = url.searchParams.getAll('token')
      if (tokens.length === 1 && this.rec.token !== '' && tokenMatches(tokens[0], this.rec.token)) {
        this.failures.delete(ip)
        res.statusCode = 303
        res.setHeader('location', './')
        res.setHeader('set-cookie', this.cookieHeader())
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }
      this.fail(ip)
      return text(res, 401, 'A share token is required.')
    }

    if (!this.cookieValid(req)) return text(res, 401, 'Unauthorized.')
    if (url.pathname === `${ROUTE_PREFIX}/info`) return json(res, await this.serverApi.info({ via: 'share', gui: this.guiEnabled() }))
    if (url.pathname === `${ROUTE_PREFIX}/ports`) return json(res, await this.serverApi.ports())
    return text(res, 404, 'Not found.')
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Start listening. The port is remembered: a saved port that is busy at startup falls back to a free one
   * (and says so through `notice`), while a port the user just asked for fails loudly.
   */
  start(explicit = false) {
    if (this.server) return Promise.resolve()
    if (this.starting) return this.starting
    const run = this.doStart(explicit).finally(() => {
      if (this.starting === run) this.starting = undefined
    })
    this.starting = run
    return run
  }

  async doStart(explicit) {
    if (!this.allowed()) {
      this.status = 'error'
      this.error = { code: 'share-disabled', message: 'Sharing is turned off by this plugin\'s configuration (shareAllowed / serverEnabled).' }
      throw new RemoteError('share-disabled', this.error.message)
    }
    this.ensureSecrets()
    this.status = 'starting'
    this.error = null
    this.notice = null
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger?.warn?.(error)
        if (!res.headersSent) text(res, 500, 'Internal error.')
        else res.end()
      })
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => undefined)
      let pathname = ''
      try {
        pathname = new URL(req.url ?? '/', 'http://share.invalid').pathname
      } catch {
        /* fall through to destroy */
      }
      if (this.fromBrowser(req) || pathname !== `${ROUTE_PREFIX}/tunnel`) {
        socket.destroy()
        return
      }
      this.tunnels.handleUpgrade(req, socket, head)
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    const listen = (port) =>
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
        server.listen({ host: this.rec.host, port })
      })
    let tried = this.rec.port
    try {
      try {
        await listen(tried)
      } catch (error) {
        if (error && error.code === 'EADDRINUSE' && tried !== 0 && !explicit) {
          this.notice = 'port-changed'
          tried = 0
          await listen(0)
        } else {
          throw error
        }
      }
    } catch (error) {
      server.close()
      const mapped = mapListenError(error, this.rec.host, tried)
      this.status = 'error'
      this.error = { code: mapped.code, message: mapped.message }
      throw mapped
    }
    if (!this.rec.enabled) {
      // Switched off while the socket was opening.
      server.close()
      this.status = 'stopped'
      return
    }
    this.server = server
    this.boundPort = server.address().port
    server.on('error', (error) => this.logger?.warn?.(error))
    if (this.rec.port !== this.boundPort) {
      this.rec.port = this.boundPort
      this.onChange()
    }
    this.status = 'listening'
  }

  async stop() {
    const server = this.server
    this.server = null
    this.status = 'stopped'
    this.boundPort = 0
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }

  async dispose() {
    await this.stop()
  }

  /** Apply optional `host` / `port` / `advertise` from a request; returns whether the listener must restart. */
  applyOptions(params) {
    let restart = false
    if (params.host !== undefined) {
      const host = validHost(params.host)
      if (host !== this.rec.host) restart = true
      this.rec.host = host
    }
    if (params.port !== undefined) {
      const port = validPort(params.port)
      if (port !== this.rec.port) restart = true
      this.rec.port = port
    }
    if (params.advertise !== undefined) this.rec.advertise = String(params.advertise).trim().slice(0, 253)
    if (params.gui !== undefined) {
      if (params.gui === true && !this.hasGui) throw new RemoteError('gui-disabled', 'Remote sessions are not available in this composition')
      if (params.gui === true && this.settings().remoteControlAllowed === false) {
        throw new RemoteError('gui-disabled', "Remote control is forbidden by this plugin's configuration (remoteControlAllowed: false)")
      }
      this.rec.gui = params.gui === true
      // Turning it off takes effect now, not at the next reconnect.
      if (!this.rec.gui) this.tunnels.closeGui()
    }
    return restart
  }

  /** A concrete port in the request is the user's explicit choice: if it is busy, fail instead of picking another. */
  static asksForPort(params) {
    return params.port !== undefined && validPort(params.port) !== 0
  }

  async enable(params = {}) {
    if (!this.allowed()) throw new RemoteError('share-disabled', 'Sharing is turned off by this plugin\'s configuration (shareAllowed / serverEnabled).')
    const explicit = ShareService.asksForPort(params)
    this.applyOptions(params)
    this.rec.enabled = true
    this.ensureSecrets()
    this.onChange()
    await this.start(explicit)
  }

  async disable() {
    this.rec.enabled = false
    // Remote control is the dangerous part: switching sharing off also forgets that consent, so turning
    // sharing back on later starts from "forwarding only" again.
    this.rec.gui = false
    this.onChange()
    await this.stop()
  }

  async update(params = {}) {
    const explicit = ShareService.asksForPort(params)
    const restart = this.applyOptions(params)
    this.onChange()
    if (this.rec.enabled && restart) {
      await this.stop()
      await this.start(explicit)
    }
  }

  /** New token and cookie secret: every address copied earlier and every open tunnel stops working. */
  async rotate() {
    this.rec.token = secretBytes()
    this.rec.secret = secretBytes()
    this.onChange()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Restore at startup. Never throws. */
  async restore() {
    if (!this.rec.enabled) return
    try {
      await this.start(false)
    } catch (error) {
      this.logger?.warn?.(error)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  options() {
    return isWildcard(this.rec.host) ? listAddresses() : [{ host: this.rec.host, kind: 'bound' }]
  }

  advertisedHost(options = this.options()) {
    if (this.rec.advertise !== '' && options.some((o) => o.host === this.rec.advertise)) return this.rec.advertise
    return options[0]?.host ?? ''
  }

  /** The address to copy, token included. Only produced on an explicit user request. */
  address() {
    if (this.status !== 'listening' || this.boundPort === 0) throw new RemoteError('share-off', 'Sharing is not on')
    const host = this.advertisedHost()
    if (host === '') throw new RemoteError('no-address', 'No network address found on this computer')
    const url = `http://${urlHost(host)}:${this.boundPort}/?token=${this.rec.token}`
    return { url, host, port: this.boundPort }
  }

  view() {
    const options = this.options()
    const host = this.advertisedHost(options)
    const token = this.rec.token
    const masked = token === '' ? '' : `${token.slice(0, 4)}…${token.slice(-4)}`
    return {
      allowed: this.allowed(),
      enabled: this.rec.enabled,
      status: this.status,
      error: this.error,
      notice: this.notice,
      host: this.rec.host,
      port: this.rec.port,
      boundPort: this.boundPort,
      advertise: host,
      addresses: options,
      gui: this.rec.gui === true,
      guiAllowed: this.hasGui && this.settings().remoteControlAllowed !== false,
      tunnels: this.tunnels.count(),
      maskedUrl: this.status === 'listening' && host !== '' ? `http://${urlHost(host)}:${this.boundPort}/?token=${masked}` : '',
    }
  }
}
