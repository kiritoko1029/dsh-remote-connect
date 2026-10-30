/**
 * Tunnel plumbing shared by both ends, plus the server end.
 *
 * A tunnel is one TCP connection carried over one WebSocket: binary frames are the byte stream,
 * a text frame "eof" is a half-close (the sender finished writing but still wants to read), and the
 * WebSocket close frame ends everything.
 */
import net from 'node:net'
import { WsPeer, acceptKey } from './ws.js'
import { WsDuplex } from './ws-duplex.js'

/**
 * Pipe a TCP socket and a WebSocket peer into each other with back-pressure and half-close.
 * The TCP socket must have been created with `allowHalfOpen: true`.
 * @param {net.Socket} tcp
 * @param {WsPeer} ws
 * @param {{onOut?: (n: number) => void, onIn?: (n: number) => void, onClose?: (error?: Error) => void}} hooks
 *   `onOut`: bytes TCP -> WebSocket. `onIn`: bytes WebSocket -> TCP.
 */
export function bridge(tcp, ws, hooks = {}) {
  let finished = false
  let waitingForWsDrain = false
  let waitingForTcpDrain = false

  const finish = (error) => {
    if (finished) return
    finished = true
    tcp.destroy()
    ws.destroy()
    hooks.onClose?.(error)
  }

  tcp.on('data', (chunk) => {
    hooks.onOut?.(chunk.length)
    if (!ws.sendData(chunk) && !waitingForWsDrain) {
      waitingForWsDrain = true
      tcp.pause()
      ws.once('drain', () => {
        waitingForWsDrain = false
        tcp.resume()
      })
    }
  })
  tcp.on('end', () => {
    if (!finished) ws.sendText('eof')
  })
  tcp.on('error', (error) => finish(error))
  tcp.on('close', () => {
    if (finished) return
    // Everything the TCP side had to say is already queued ahead of the close frame.
    ws.close(1000)
  })

  ws.on('data', (buffer) => {
    hooks.onIn?.(buffer.length)
    if (!tcp.write(buffer) && !waitingForTcpDrain) {
      waitingForTcpDrain = true
      ws.pause()
      tcp.once('drain', () => {
        waitingForTcpDrain = false
        ws.resume()
      })
    }
  })
  ws.on('text', (text) => {
    if (text === 'eof' && !tcp.destroyed) tcp.end()
  })
  ws.on('error', (error) => finish(error))
  ws.on('close', () => {
    if (finished) return
    finished = true
    // Let queued writes reach the target before closing it.
    if (!tcp.destroyed) {
      tcp.end()
      const force = setTimeout(() => tcp.destroy(), 2000)
      force.unref?.()
      tcp.once('close', () => clearTimeout(force))
    }
    hooks.onClose?.()
  })
}

/** Answer an upgrade request with a plain HTTP error and close. */
export function respond(socket, status, message) {
  const reasons = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' }
  const body = Buffer.from(`${message}\n`, 'utf8')
  if (socket.destroyed || !socket.writable) return
  const head = Buffer.from(
    `HTTP/1.1 ${status} ${reasons[status] ?? 'Error'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n` +
      'Cache-Control: no-store\r\n' +
      'Connection: close\r\n\r\n',
    'utf8',
  )
  socket.end(Buffer.concat([head, body]))
}

/** `["5173", "3000-3999"]` -> `[[5173, 5173], [3000, 3999]]`; unparseable entries are dropped. */
export function parsePortRules(rules) {
  const out = []
  for (const rule of rules ?? []) {
    const match = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(String(rule))
    if (!match) continue
    const low = Number(match[1])
    const high = match[2] === undefined ? low : Number(match[2])
    if (low < 1 || high > 65535 || low > high) continue
    out.push([low, high])
  }
  return out
}

/** Whether `host` is allowed by `allowedHosts` (case-insensitive, `*` = anything). */
export function hostAllowed(host, allowedHosts) {
  const wanted = host.toLowerCase().replace(/^\[|\]$/g, '')
  return (allowedHosts ?? []).some((entry) => {
    const allowed = String(entry).toLowerCase().replace(/^\[|\]$/g, '')
    return allowed === '*' || allowed === wanted
  })
}

export function portAllowed(port, rules) {
  return rules.length === 0 || rules.some(([low, high]) => port >= low && port <= high)
}

/**
 * The server end: accepts tunnel upgrades from authenticated remote DSH clients.
 *
 * @param {{
 *   connection: { admit(req: unknown): { peer?: { principal: { kind: string } }, rejection?: number } },
 *   settings: () => { serverEnabled: boolean, allowedHosts: string[], allowedPorts: string[], maxTunnels: number, connectTimeoutMs: number, keepAliveSeconds: number },
 *   logger?: { warn?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void },
 *   gui?: { enabled: () => boolean, serve: (duplex: import('node:stream').Duplex) => void },
 * }} deps `gui` lets a tunnel opened with `?gui=1` carry this DSH's own web page instead of a TCP target.
 */
export function createTunnelServer({ connection, settings, logger, gui }) {
  const active = new Set()

  /** `?gui=1`: the tunnel is an HTTP connection to this computer's own DSH web page (see gui-bridge.js). */
  function openGui(req, socket, head, cfg, reject) {
    if (!gui || !gui.enabled()) {
      return reject(403, 'Remote control of this DSH is turned off on that computer. Turn on "Allow remote control" in its Remote Connect panel.')
    }
    const key = req.headers['sec-websocket-key']
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || key === '') {
      return reject(400, 'A WebSocket upgrade is required.')
    }
    if (active.size >= cfg.maxTunnels) return reject(503, `This machine already serves ${cfg.maxTunnels} tunnels.`)
    const entry = { host: '(dsh)', port: 0, gui: true, since: Date.now(), bytesIn: 0, bytesOut: 0 }
    active.add(entry)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    const ws = new WsPeer(socket, { role: 'server', head, pingMs: cfg.keepAliveSeconds * 1000 })
    entry.close = () => ws.destroy()
    ws.once('close', () => active.delete(entry))
    gui.serve(new WsDuplex(ws))
  }

  function handleUpgrade(req, socket, head) {
    const cfg = settings()
    const reject = (status, message) => respond(socket, status, message)

    if (!cfg.serverEnabled) return reject(403, `Port forwarding is disabled on this machine (serverEnabled: false).`)

    const admission = connection.admit(req)
    if ('rejection' in admission && admission.rejection !== undefined) {
      return reject(admission.rejection, admission.rejection === 401 ? 'Unauthorized.' : 'Forbidden: this Host/Origin is not trusted by this DSH.')
    }
    if (admission.peer?.principal?.kind !== 'owner') return reject(403, 'Only the owner may open tunnels.')

    let url
    try {
      url = new URL(req.url ?? '/', 'http://tunnel.invalid')
    } catch {
      return reject(400, 'Bad request URL.')
    }
    if (url.searchParams.get('gui') === '1') return openGui(req, socket, head, cfg, reject)
    const host = (url.searchParams.get('host') ?? '127.0.0.1').trim()
    const portText = url.searchParams.get('port') ?? ''
    const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0
    if (host === '' || host.length > 253 || /[\s/\\@]/.test(host)) return reject(400, 'Invalid target host.')
    if (port < 1 || port > 65535) return reject(400, 'Invalid target port.')
    if (!hostAllowed(host, cfg.allowedHosts)) {
      return reject(403, `Target host ${host} is not in allowedHosts on this machine (${cfg.allowedHosts.join(', ') || 'none'}).`)
    }
    if (!portAllowed(port, parsePortRules(cfg.allowedPorts))) return reject(403, `Target port ${port} is not in allowedPorts on this machine.`)

    const key = req.headers['sec-websocket-key']
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || key === '') {
      return reject(400, 'A WebSocket upgrade is required.')
    }
    if (active.size >= cfg.maxTunnels) return reject(503, `This machine already serves ${cfg.maxTunnels} tunnels.`)

    const entry = { host, port, since: Date.now(), bytesIn: 0, bytesOut: 0 }
    active.add(entry)
    const release = () => active.delete(entry)

    const target = net.connect({ host: host.replace(/^\[|\]$/g, ''), port, allowHalfOpen: true })
    const timer = setTimeout(() => target.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), cfg.connectTimeoutMs)
    let connected = false
    const clientGone = () => {
      if (!connected) {
        clearTimeout(timer)
        target.destroy()
        release()
      }
    }
    socket.once('close', clientGone)

    target.once('error', (error) => {
      if (connected) return
      clearTimeout(timer)
      release()
      socket.off('close', clientGone)
      logger?.info?.(`remote-connect: tunnel to ${host}:${port} failed: ${error.message}`)
      reject(502, `Cannot connect to ${host}:${port} from this machine: ${error.code ?? error.message}`)
    })
    target.once('connect', () => {
      clearTimeout(timer)
      if (socket.destroyed) {
        target.destroy()
        release()
        return
      }
      connected = true
      socket.off('close', clientGone)
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      )
      const ws = new WsPeer(socket, { role: 'server', head, pingMs: cfg.keepAliveSeconds * 1000 })
      bridge(target, ws, {
        onOut: (n) => {
          entry.bytesOut += n
        },
        onIn: (n) => {
          entry.bytesIn += n
        },
        onClose: release,
      })
    })
  }

  return {
    handleUpgrade,
    count: () => active.size,
    snapshot: () => [...active].map(({ close: _close, ...entry }) => entry),
    /** Drop every remote-session tunnel (used when the user turns remote control off). */
    closeGui() {
      for (const entry of [...active]) if (entry.gui) entry.close?.()
    },
  }
}
