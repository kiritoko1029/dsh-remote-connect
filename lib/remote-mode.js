/**
 * Remote mode: this computer's DSH window runs on another computer's DSH.
 *
 * The window keeps its own UI (shell, sidebar, chat: the same code, which is why both computers must
 * run the same DSH release) and only its data source changes: every request the UI sends to its Host's
 * `/api` (RPC, uploads, attachments) and the `/api/remote.mux` WebSocket (live events and streams) is
 * relayed to the other computer's Host instead. The relay rides the same tunnels as everything else:
 * a `?gui=1` tunnel ends in the other computer's gui bridge, which logs in to its own DSH and attaches
 * the session cookie, so no DSH login ever reaches this computer.
 *
 * Everything outside `/api` (the page, plugin bundles, this plugin's own `/remote-connect/*` routes,
 * IPC to the desktop shell) stays local. That is also why switching back is always possible.
 */
import http from 'node:http'
import { HOP_HEADER } from './gui-bridge.js'
import { WsDuplex } from './ws-duplex.js'

const MUX_PATH = '/api/remote.mux'

const DROP_REQUEST = new Set([
  'host',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  HOP_HEADER,
])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function pathOf(req) {
  return String(req.url ?? '/').split('?', 1)[0]
}

function requestHeaders(inbound, { upgrade }) {
  const out = {}
  for (const [name, value] of Object.entries(inbound)) {
    const key = name.toLowerCase()
    if (upgrade && (key === 'connection' || key === 'upgrade')) {
      out[key] = value
      continue
    }
    if (!DROP_REQUEST.has(key)) out[key] = value
  }
  // The other computer's bridge replaces Host / Origin / Cookie with its own DSH's; these just have to exist.
  out.host = 'remote-dsh'
  out[HOP_HEADER] = '1'
  return out
}

function responseHeaders(inbound) {
  const out = {}
  for (const [name, value] of Object.entries(inbound)) if (!DROP_RESPONSE.has(name)) out[name] = value
  return out
}

function plain(res, status, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${message}\n`)
}

export class RemoteMode {
  /**
   * @param {{
   *   openTunnel: (connectionId: string, signal?: AbortSignal) => Promise<import('./ws.js').WsPeer>,
   *   admit: (req: import('node:http').IncomingMessage) => { peer?: unknown, rejection?: number },
   *   logger?: any,
   * }} deps `openTunnel` opens a `?gui=1` tunnel through a saved connection; `admit` authenticates a request to THIS DSH.
   */
  constructor({ openTunnel, admit, logger }) {
    this.openTunnel = openTunnel
    this.admit = admit
    this.logger = logger
    this.activeId = null
    this.since = 0
    this.agent = null
    this.sockets = new Set()
    /** Whether this DSH's Host can be switched at all (set once the WebSocket interceptor is in place). */
    this.supported = false
    this.reason = 'starting'
  }

  get active() {
    return this.activeId
  }

  makeAgent(connectionId, { keepAlive }) {
    const agent = new http.Agent({ keepAlive, maxSockets: 16, timeout: 30_000 })
    agent.createConnection = (_options, callback) => {
      this.openTunnel(connectionId).then(
        (ws) => callback(null, new WsDuplex(ws)),
        (error) => callback(error),
      )
    }
    return agent
  }

  /** Route this DSH's `/api` to the other computer from now on. Open API sockets are cut so the UI reconnects there. */
  enter(connectionId) {
    this.leave()
    this.activeId = connectionId
    this.since = Date.now()
    this.agent = this.makeAgent(connectionId, { keepAlive: true })
  }

  /** Back to this computer. */
  leave() {
    this.activeId = null
    this.since = 0
    this.agent?.destroy()
    this.agent = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  dispose() {
    this.leave()
  }

  /** Whether a request to this DSH's Host should be relayed (HTTP: any `/api`; upgrade: the event mux). */
  intercepts(req, { upgrade = false } = {}) {
    if (this.activeId === null) return false
    // Already crossed a Remote Connect hop (it came through a bridge): answer it here, never relay twice.
    if (req.headers[HOP_HEADER] !== undefined) return false
    const path = pathOf(req)
    return upgrade ? path === MUX_PATH : path === '/api' || path.startsWith('/api/')
  }

  /** Relay one HTTP request. Resolves when the response is finished. */
  proxyHttp(req, res) {
    const agent = this.agent
    return new Promise((resolve) => {
      res.once('close', resolve)
      if (!agent) {
        plain(res, 503, 'Remote mode ended.')
        return
      }
      const upstream = http.request(
        { agent, host: 'remote-dsh', port: 80, method: req.method, path: req.url, headers: requestHeaders(req.headers, { upgrade: false }) },
        (response) => {
          res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers))
          response.pipe(res)
          response.on('error', () => res.destroy())
        },
      )
      upstream.on('error', (error) => {
        this.logger?.info?.(`remote-connect: remote mode request failed: ${error.message}`)
        plain(res, 502, 'The other computer did not answer.')
      })
      res.once('close', () => upstream.destroy())
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    })
  }

  /** Relay the live-event WebSocket. The caller has checked {@link intercepts}. */
  proxyUpgrade(req, socket, head) {
    const refuse = (status) => socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
    socket.on('error', () => undefined)
    const admission = this.admit(req)
    if ('rejection' in admission && admission.rejection !== undefined) {
      refuse(admission.rejection === 401 ? 401 : 403)
      return
    }
    const id = this.activeId
    if (id === null) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    const agent = this.makeAgent(id, { keepAlive: false })
    const upstream = http.request({ agent, host: 'remote-dsh', port: 80, method: req.method, path: req.url, headers: requestHeaders(req.headers, { upgrade: true }) })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      this.sockets.add(upstreamSocket)
      upstreamSocket.once('close', () => this.sockets.delete(upstreamSocket))
      upstreamSocket.on('error', () => socket.destroy())
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      socket.once('close', () => upstreamSocket.destroy())
      upstreamSocket.once('close', () => socket.destroy())
    })
    upstream.on('response', (response) => {
      response.resume()
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ''}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
    })
    upstream.on('error', (error) => {
      this.logger?.info?.(`remote-connect: remote mode WebSocket failed: ${error.message}`)
      socket.destroy()
    })
    socket.once('close', () => upstream.destroy())
    upstream.end()
  }
}

/**
 * Put a wrapper in front of a Node HTTP server's own `upgrade` listeners: requests `take` claims go to
 * `handle`, everything else reaches the original listeners untouched.
 *
 * Needed because the shared event WebSocket is claimed by DSH's gateway with an exact-path upgrade route
 * and there is no hook to relay it; the HTTP side has an official one (`connection/request`).
 * @returns a function that restores the original listeners, or undefined when `server` is not an HTTP server.
 */
export function installUpgradeInterceptor(server, { take, handle }) {
  if (!server || typeof server.listeners !== 'function' || typeof server.removeAllListeners !== 'function') return undefined
  const originals = server.listeners('upgrade')
  server.removeAllListeners('upgrade')
  const wrapper = (req, socket, head) => {
    let taken = false
    try {
      taken = take(req)
    } catch {
      taken = false
    }
    if (taken) {
      handle(req, socket, head)
      return
    }
    for (const listener of originals) listener.call(server, req, socket, head)
  }
  server.on('upgrade', wrapper)
  return () => {
    server.off('upgrade', wrapper)
    for (const listener of originals) server.on('upgrade', listener)
  }
}
