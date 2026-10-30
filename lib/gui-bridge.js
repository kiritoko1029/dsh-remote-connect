/**
 * Serves this computer's own DSH web page (sessions, chat, settings: the whole app) to a remote
 * Remote Connect client, over a tunnel, without ever handing out DSH's login token.
 *
 * The DSH desktop app does the same thing between its window and its Host: it logs in once with the
 * launch token, then forwards every request with the session cookie attached and Host/Origin
 * rewritten to the Host's own loopback authority. This is that proxy, fed by tunnels instead of by a
 * window. It has no listening socket: each tunnel is wrapped in a Duplex and handed to an in-process
 * `http.Server`, so nothing on this machine (or its network) can reach the proxy except through an
 * authenticated tunnel.
 *
 * Whoever holds a tunnel through this bridge controls this DSH completely (every session, and the
 * agent can run commands as the user). Callers must gate it behind an explicit user opt-in.
 */
import http from 'node:http'
import https from 'node:https'

const COOKIE_PREFIX = 'dsh-auth-'
export const HOP_HEADER = 'x-remote-connect-hop'

const DROP_REQUEST = new Set(['host', 'cookie', 'origin', 'sec-fetch-site', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade'])
const DROP_RESPONSE = new Set(['set-cookie', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function bracket(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * @param {{
 *   target: () => { protocol: string, host: string, port: number | null },
 *   authenticatedUrl: (baseUrl: string) => string,
 *   logger?: any,
 * }} deps `target` is DSH's own web listener; `authenticatedUrl` adds its launch token to a base URL.
 */
export function createGuiBridge({ target, authenticatedUrl, logger }) {
  let cookie
  let loginInFlight
  const sockets = new Set()

  /** The DSH listener as the proxy dials it, and the authority DSH must see in Host / Origin. */
  function upstream() {
    const t = target()
    if (!t || !t.port) throw new Error('This DSH has no web listener to bridge to')
    const host = String(t.host).replace(/%.*$/, '')
    const secure = t.protocol === 'https:'
    return { secure, host, port: t.port, authority: `${bracket(host)}:${t.port}`, origin: `${secure ? 'https:' : 'http:'}//${bracket(host)}:${t.port}` }
  }

  function transport(up) {
    return up.secure ? https : http
  }

  function baseOptions(up, extra) {
    return { host: up.host, port: up.port, agent: false, ...(up.secure ? { rejectUnauthorized: false } : {}), ...extra }
  }

  /** Exchange the launch token for the owner session cookie, exactly as a browser (or the desktop shell) does. */
  function login() {
    if (loginInFlight) return loginInFlight
    const run = new Promise((resolve, reject) => {
      const up = upstream()
      const url = new URL(authenticatedUrl(up.origin))
      const request = transport(up).request(
        baseOptions(up, { method: 'GET', path: `${url.pathname}${url.search}`, headers: { host: up.authority, accept: 'text/html' } }),
        (response) => {
          response.resume()
          const raw = response.headers['set-cookie']
          const list = Array.isArray(raw) ? raw : raw ? [raw] : []
          const pair = list.map((entry) => entry.split(';', 1)[0].trim()).find((entry) => entry.startsWith(COOKIE_PREFIX))
          if (response.statusCode === 303 && pair) resolve(pair)
          else reject(new Error(`DSH refused the local login (HTTP ${response.statusCode})`))
        },
      )
      request.setTimeout(10000, () => request.destroy(new Error('DSH did not answer the local login')))
      request.on('error', reject)
      request.end()
    })
    loginInFlight = run
    run.then(
      (value) => {
        cookie = value
        loginInFlight = undefined
      },
      () => {
        loginInFlight = undefined
      },
    )
    return run
  }

  async function session() {
    return cookie ?? (await login())
  }

  function requestHeaders(inbound, up, sessionCookie, { upgrade }) {
    const out = {}
    for (const [name, value] of Object.entries(inbound)) {
      const key = name.toLowerCase()
      if (!DROP_REQUEST.has(key)) out[key] = value
    }
    out.host = up.authority
    out.cookie = sessionCookie
    // Marks traffic that already crossed a Remote Connect hop, so a DSH switched onto another one never relays it again (no loops).
    out[HOP_HEADER] = '1'
    if (inbound.origin !== undefined) out.origin = up.origin
    if (inbound['sec-fetch-site'] !== undefined) out['sec-fetch-site'] = 'same-origin'
    if (upgrade) {
      out.connection = 'Upgrade'
      out.upgrade = inbound.upgrade
    }
    return out
  }

  /** Keep Location headers on the proxy's own origin instead of leaking the DSH listener's address. */
  function responseHeaders(inbound, up) {
    const out = {}
    for (const [name, value] of Object.entries(inbound)) {
      if (DROP_RESPONSE.has(name)) continue
      out[name] = name === 'location' && typeof value === 'string' && value.startsWith(up.origin) ? value.slice(up.origin.length) || '/' : value
    }
    return out
  }

  function fail(res, status, message) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${message}\n`)
  }

  async function proxyRequest(req, res, retried = false) {
    let up
    let sessionCookie
    try {
      up = upstream()
      sessionCookie = await session()
    } catch (error) {
      logger?.warn?.(error)
      fail(res, 502, 'Cannot reach the DSH on this computer.')
      return
    }
    const bodyless = req.method === 'GET' || req.method === 'HEAD'
    const outgoing = transport(up).request(baseOptions(up, { method: req.method, path: req.url, headers: requestHeaders(req.headers, up, sessionCookie, { upgrade: false }) }))
    outgoing.on('response', (response) => {
      if (response.statusCode === 401 && bodyless && !retried) {
        // The cookie went stale (DSH rotated its secret): log in again once.
        response.resume()
        cookie = undefined
        proxyRequest(req, res, true)
        return
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers, up))
      response.pipe(res)
      response.on('error', () => res.destroy())
    })
    outgoing.on('error', (error) => {
      logger?.info?.(`remote-connect: gui proxy request failed: ${error.message}`)
      fail(res, 502, 'The DSH on this computer did not answer.')
    })
    res.on('close', () => outgoing.destroy())
    if (bodyless) outgoing.end()
    else req.pipe(outgoing)
  }

  async function proxyUpgrade(req, socket, head) {
    socket.on('error', () => undefined)
    let up
    let sessionCookie
    try {
      up = upstream()
      sessionCookie = await session()
    } catch (error) {
      logger?.warn?.(error)
      socket.destroy()
      return
    }
    const outgoing = transport(up).request(baseOptions(up, { method: req.method, path: req.url, headers: requestHeaders(req.headers, up, sessionCookie, { upgrade: true }) }))
    outgoing.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      upstreamSocket.on('error', () => socket.destroy())
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
    })
    outgoing.on('response', (response) => {
      // Refused (for example a stale cookie): relay the status instead of leaving the client hanging.
      if (response.statusCode === 401) cookie = undefined
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ''}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
      response.resume()
    })
    outgoing.on('error', () => socket.destroy())
    socket.on('close', () => outgoing.destroy())
    outgoing.end()
  }

  const server = http.createServer((req, res) => {
    proxyRequest(req, res).catch((error) => {
      logger?.warn?.(error)
      fail(res, 502, 'Internal error.')
    })
  })
  server.on('upgrade', (req, socket, head) => {
    proxyUpgrade(req, socket, head).catch(() => socket.destroy())
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.keepAliveTimeout = 60_000

  return {
    /** Serve one tunnel (a Duplex) as an HTTP connection. */
    serve(duplex) {
      sockets.add(duplex)
      duplex.once('close', () => sockets.delete(duplex))
      server.emit('connection', duplex)
    },
    /** Drop the cached login (for example after the user changed something that invalidates it). */
    forget() {
      cookie = undefined
    },
    close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
    },
  }
}
