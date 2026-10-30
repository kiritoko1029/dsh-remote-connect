/**
 * Client side of the wire protocol: how this DSH talks to a remote DSH.
 *
 *  1. Exchange the remote's launch token for its signed session cookie (`GET /?token=...`, the same
 *     exchange a browser does; `/connect` is the fallback for compositions without a SPA root).
 *  2. Probe `GET /remote-connect/info` to learn the remote machine and confirm the plugin is there.
 *  3. Open a tunnel: `GET /remote-connect/tunnel?host=&port=` upgraded to a WebSocket whose binary
 *     frames carry the TCP byte stream.
 *
 * The token and cookie only ever travel in the Host process; callers never get them back out.
 */
import http from 'node:http'
import https from 'node:https'
import { WsPeer, acceptKey, newKey } from './ws.js'

export const PROTOCOL = 1
export const PLUGIN_ID = 'dsh-remote-connect'
export const ROUTE_PREFIX = '/remote-connect'

const USER_AGENT = 'dsh-remote-connect'
const COOKIE_PREFIX = 'dsh-auth-'

/** A failure with a stable `code` the UI can localize, plus a human message. */
export class RemoteError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
])

/** Turn a Node network error into a RemoteError (existing RemoteErrors pass through). */
export function classify(error) {
  if (error instanceof RemoteError) return error
  const code = error && typeof error === 'object' ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (error && error.name === 'AbortError') return new RemoteError('aborted', 'Cancelled', { cause: error })
  if (code === 'ECONNREFUSED') return new RemoteError('refused', `Connection refused (${message})`, { cause: error })
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new RemoteError('dns', `Host not found (${message})`, { cause: error })
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'TIMEOUT') return new RemoteError('timeout', `Timed out (${message})`, { cause: error })
  if (code === 'ECONNRESET' || code === 'EPIPE') return new RemoteError('reset', `Connection reset (${message})`, { cause: error })
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new RemoteError('unreachable', `Host unreachable (${message})`, { cause: error })
  if (typeof code === 'string' && (TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL'))) {
    return new RemoteError('tls', `TLS error: ${message}`, { cause: error })
  }
  return new RemoteError('network', message, { cause: error })
}

/**
 * Accept what a user pastes: `host:port`, `http://host:port/`, or the full `dsh web` URL that
 * carries `?token=`. Returns the clean base (origin + mount path, no trailing slash) and a token
 * found in the query, if any.
 */
export function normalizeRemoteUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new RemoteError('bad-url', 'URL is required')
  let text = input.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new RemoteError('bad-url', `Not a valid URL: ${input.trim()}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteError('bad-url', 'Only http:// and https:// URLs are supported')
  if (url.hostname === '') throw new RemoteError('bad-url', 'URL has no host')
  const token = url.searchParams.get('token') ?? undefined
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  let pathname = url.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '')
  url.pathname = pathname === '' ? '/' : pathname
  const base = new URL(url.href)
  return { base, token: token === '' ? undefined : token }
}

/** Origin + mount path of a normalized base, without a trailing slash. */
export function baseHref(base) {
  return `${base.origin}${base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')}`
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '')
}

function transportFor(url) {
  return url.protocol === 'https:' ? https : http
}

/**
 * One HTTP exchange with a bounded body. Never follows redirects and never reuses sockets.
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer}>}
 */
export function requestOnce(url, { method = 'GET', headers = {}, insecure = false, timeoutMs = 10000, signal, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteError('aborted', 'Cancelled'))
      return
    }
    const request = transportFor(url).request({
      protocol: url.protocol,
      hostname: hostnameOf(url),
      port: url.port === '' ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method,
      agent: false,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
      rejectUnauthorized: !insecure,
      signal,
    })
    const timer = setTimeout(() => request.destroy(Object.assign(new Error(`no response within ${timeoutMs} ms`), { code: 'TIMEOUT' })), timeoutMs)
    const done = (fn, value) => {
      clearTimeout(timer)
      fn(value)
    }
    request.on('error', (error) => done(reject, classify(error)))
    request.on('response', (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          request.destroy(new RemoteError('protocol', 'Response too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => done(resolve, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', (error) => done(reject, classify(error)))
    })
    request.end()
  })
}

function pathUnder(base, suffix) {
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')
  return `${prefix}${suffix}`
}

function urlFor(base, suffix) {
  const url = new URL(base.href)
  const [path, query = ''] = suffix.split('?')
  url.pathname = pathUnder(base, path)
  url.search = query === '' ? '' : `?${query}`
  return url
}

function statusError(status, where) {
  if (status === 401) return new RemoteError('unauthorized', `${where}: the remote DSH rejected the credentials (HTTP 401)`, { status })
  if (status === 403) {
    return new RemoteError(
      'forbidden',
      `${where}: the remote DSH refused this address (HTTP 403). Start it with --host <its IP> or --trusted-host <name>, or reach it through a trusted hostname`,
      { status },
    )
  }
  return new RemoteError('protocol', `${where}: unexpected HTTP ${status}`, { status })
}

function cookieFrom(headers) {
  const raw = headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const entry of list) {
    const pair = entry.split(';', 1)[0].trim()
    if (pair.startsWith(COOKIE_PREFIX)) return pair
  }
  return undefined
}

/**
 * Exchange a launch token for the signed session cookie.
 * @returns {Promise<string>} `name=value`, ready for a Cookie header
 */
export async function exchangeToken(base, token, opts = {}) {
  if (!token) {
    throw new RemoteError(
      'no-token',
      'No token saved for this connection. On the other computer copy its connection address (Remote Connect > Share this computer > Copy connection address), then edit this connection and paste it',
    )
  }
  const attempts = [`/?token=${encodeURIComponent(token)}`, `/connect?interactions=none&token=${encodeURIComponent(token)}`]
  let last
  for (const suffix of attempts) {
    const response = await requestOnce(urlFor(base, suffix), { ...opts, headers: { accept: 'text/html,*/*' } })
    const cookie = cookieFrom(response.headers)
    if (cookie && response.status >= 300 && response.status < 400) return cookie
    if (response.status === 401) throw statusError(401, 'Token exchange')
    if (response.status === 403) throw statusError(403, 'Token exchange')
    last = response.status === 404 || response.status === 405 ? undefined : response
    if (last === undefined) continue
    break
  }
  throw new RemoteError('protocol', `Token exchange: this does not look like a DSH web server (HTTP ${last ? last.status : 404})`, { status: last?.status })
}

function parseJson(response, where) {
  const type = String(response.headers['content-type'] ?? '')
  if (!type.toLowerCase().includes('json')) {
    throw new RemoteError('no-plugin', `${where}: the remote DSH has no ${PLUGIN_ID} plugin (install and enable it there)`, { status: response.status })
  }
  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new RemoteError('protocol', `${where}: malformed JSON from the remote`)
  }
}

async function getJson(base, suffix, cookie, opts, where) {
  const started = Date.now()
  const response = await requestOnce(urlFor(base, suffix), { ...opts, headers: { cookie } })
  if (response.status === 401 || response.status === 403) throw statusError(response.status, where)
  if (response.status === 404) throw new RemoteError('no-plugin', `${where}: the remote DSH has no ${PLUGIN_ID} plugin (install and enable it there)`, { status: 404 })
  if (response.status !== 200) throw statusError(response.status, where)
  const value = parseJson(response, where)
  return { value, latencyMs: Date.now() - started }
}

/** Probe the remote: authenticates the cookie and reads the machine description. */
export async function fetchInfo(base, cookie, opts = {}) {
  const { value, latencyMs } = await getJson(base, `${ROUTE_PREFIX}/info`, cookie, opts, 'Probe')
  if (!value || value.plugin !== PLUGIN_ID) {
    throw new RemoteError('no-plugin', `Probe: the remote DSH did not identify as ${PLUGIN_ID}`)
  }
  if (value.protocol !== PROTOCOL) {
    throw new RemoteError('protocol', `Probe: the remote speaks tunnel protocol ${String(value.protocol)}, this side speaks ${PROTOCOL}; update ${PLUGIN_ID} on both machines`)
  }
  return { info: value, latencyMs }
}

/** Ports the remote machine is listening on. */
export async function fetchPorts(base, cookie, opts = {}) {
  const { value } = await getJson(base, `${ROUTE_PREFIX}/ports`, cookie, opts, 'Port listing')
  return value
}

/**
 * Open one tunnel to `host:port` as seen from the remote machine.
 * Resolves once the remote has connected to the target and answered 101.
 * @returns {Promise<WsPeer>}
 */
export function openTunnel(base, cookie, { host, port, gui = false, insecure = false, timeoutMs = 10000, signal, keepAliveMs = 25000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteError('aborted', 'Cancelled'))
      return
    }
    // `gui`: the tunnel carries the other computer's own DSH web page (it dials no TCP target).
    const url = urlFor(base, gui ? `${ROUTE_PREFIX}/tunnel?gui=1` : `${ROUTE_PREFIX}/tunnel?host=${encodeURIComponent(host)}&port=${String(port)}`)
    const key = newKey()
    const request = transportFor(url).request({
      protocol: url.protocol,
      hostname: hostnameOf(url),
      port: url.port === '' ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        cookie,
      },
      rejectUnauthorized: !insecure,
    })
    let settled = false
    const timer = setTimeout(() => fail(new RemoteError('timeout', gui ? `Timed out opening the remote session (${timeoutMs} ms)` : `Timed out opening a tunnel to ${host}:${port} (${timeoutMs} ms)`)), timeoutMs)
    const onAbort = () => fail(new RemoteError('aborted', 'Cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      request.destroy()
      reject(error)
    }
    request.on('error', (error) => fail(classify(error)))
    request.on('response', (response) => {
      // Not upgraded: the remote refused. Its body says why.
      const chunks = []
      response.on('data', (chunk) => chunks.length < 8 && chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim().slice(0, 300)
        const status = response.statusCode ?? 0
        if (status === 401) return fail(statusError(401, 'Tunnel'))
        // The server's own words ("target host not in allowedHosts ...") beat the generic fence hint.
        if (status === 403) return fail(text && !/^Forbidden: this Host\/Origin/.test(text) ? new RemoteError('forbidden', text, { status }) : statusError(403, 'Tunnel'))
        if (status === 404) return fail(new RemoteError('no-plugin', `Tunnel: the remote DSH has no ${PLUGIN_ID} plugin`, { status }))
        return fail(new RemoteError(status === 502 ? 'target' : 'protocol', text || `Tunnel: HTTP ${status}`, { status }))
      })
    })
    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      if (String(response.headers['sec-websocket-accept'] ?? '') !== acceptKey(key)) {
        socket.destroy()
        return fail(new RemoteError('protocol', 'Tunnel: invalid WebSocket handshake from the remote'))
      }
      settled = true
      cleanup()
      resolve(new WsPeer(socket, { role: 'client', head, pingMs: keepAliveMs }))
    })
    request.end()
  })
}
