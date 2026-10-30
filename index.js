/**
 * dsh-remote-connect — Host half.
 *
 * Every DSH that loads this plugin plays both roles:
 *
 *  - Server role (the machine whose ports you want). Two doors, same API:
 *      1. DSH's own web server: `GET /remote-connect/info`, `/ports` and the tunnel upgrade at
 *         `/remote-connect/tunnel`, behind DSH's owner authentication and Host/Origin fence. This is
 *         the door for `dsh --profile web`.
 *      2. "Share this computer" (lib/share.js): a dedicated listener with a remembered port and its
 *         own forwarding-only token. This is the door for the DSH desktop app, whose web server is
 *         loopback-only on a random port and shows no URL.
 *  - Client role (the machine you sit at): keeps saved connections to remote URLs + tokens, and runs
 *    local TCP listeners that tunnel each accepted connection to a port on the remote. The Web UI
 *    drives it through `/remote-connect/api/*`; the `remote_connect` tool drives the same manager.
 *
 * Tokens and session cookies stay in this process (and a 0600 state file). They never appear in an
 * API response (except the share address, on an explicit copy), a log line, or the model's context.
 */
import { readFileSync } from 'node:fs'
import { Config, resolveSettings } from './lib/config.js'
import { detectDshVersion } from './lib/dsh-version.js'
import { createGuiBridge } from './lib/gui-bridge.js'
import { RemoteConnectManager } from './lib/manager.js'
import { ROUTE_PREFIX, RemoteError } from './lib/remote.js'
import { installUpgradeInterceptor } from './lib/remote-mode.js'
import { createServerApi } from './lib/server-api.js'
import { Store, defaultStorePath } from './lib/store.js'
import { createTool, TOOL_NAME } from './lib/tool.js'
import { createTunnelServer } from './lib/tunnel.js'

export { Config }
export const name = 'dsh-remote-connect'
/** The route carrier and the trust fence that guards every route. */
export const inject = ['webServer', 'connection']

const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

const MAX_BODY = 64 * 1024

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendText(res, status, message) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(message)
}

async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (type !== 'application/json') throw new RemoteError('bad-request', 'Content-Type must be application/json')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new RemoteError('bad-request', 'Request body too large')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw new RemoteError('bad-request', 'Request body is not valid JSON')
  }
}

export function apply(ctx, rawConfig) {
  const settings = resolveSettings(rawConfig)
  const getSettings = () => settings
  const logger = ctx.logger
  const connection = Reflect.get(ctx, 'connection')
  const webServer = ctx.webServer

  const store = new Store(settings.dataFile !== '' ? settings.dataFile : defaultStorePath())
  // Serves this computer's own DSH web page to a remote Remote Connect client, logged in with DSH's own
  // launch token (which never leaves this process). Reached only through authenticated tunnels.
  const guiBridge = createGuiBridge({
    target: () => ({ protocol: webServer.protocol, host: webServer.host, port: webServer.port ?? null }),
    authenticatedUrl: (base) => connection.authenticatedUrl(base),
    logger,
  })
  // DSH's own door: the caller already holds DSH's owner login, so remote sessions need no extra consent.
  const tunnels = createTunnelServer({
    connection,
    settings: getSettings,
    logger,
    gui: { enabled: () => settings.remoteControlAllowed, serve: (duplex) => guiBridge.serve(duplex) },
  })
  /** Assigned below; the server API only reads it lazily (for the tunnel count). */
  let manager
  const dshVersion = detectDshVersion()
  const serverApi = createServerApi({
    settings: getSettings,
    version: VERSION,
    dshVersion,
    tunnelCount: () => tunnels.count() + (manager?.share?.tunnels.count() ?? 0),
    web: () => ({ protocol: webServer.protocol, host: String(webServer.host).replace(/%.*$/, ''), port: webServer.port ?? null }),
  })
  manager = new RemoteConnectManager({ store, settings: getSettings, logger, serverApi, guiBridge, localDsh: dshVersion, admit: (req) => connection.admit(req) })

  /** Authenticate a request as the owner. Returns an HTTP status when it must be refused. */
  const refusal = (req) => {
    const admission = connection.admit(req)
    if ('rejection' in admission && admission.rejection !== undefined) return admission.rejection
    return admission.peer?.principal?.kind === 'owner' ? undefined : 403
  }

  async function handle(req, res) {
    const status = refusal(req)
    if (status !== undefined) {
      sendText(res, status, status === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    if (route === '/info' && method === 'GET') return sendJson(res, 200, await serverApi.info({ via: 'dsh', gui: settings.remoteControlAllowed }))
    if (route === '/ports' && method === 'GET') return sendJson(res, 200, await serverApi.ports())
    if (route === '/api/state' && method === 'GET') return sendJson(res, 200, { ok: true, value: manager.state() })
    if (route === '/api/call' && method === 'POST') {
      try {
        const body = await readJson(req)
        const value = await manager.call(String(body.method ?? ''), body.params)
        return sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const known = error instanceof RemoteError
        if (!known) logger?.warn?.(error)
        return sendJson(res, known && error.code === 'bad-request' ? 400 : 200, {
          ok: false,
          error: { code: known ? error.code : 'internal', message: known ? error.message : 'Internal error' },
        })
      }
    }
    if (['/info', '/ports', '/api/state', '/api/call'].includes(route)) {
      res.setHeader('allow', route === '/api/call' ? 'POST' : 'GET')
      return sendText(res, 405, 'method not allowed')
    }
    return sendText(res, 404, 'not found')
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            await handle(req, res)
          } catch (error) {
            logger?.warn?.(error)
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'Internal error' } })
            else res.end()
          }
        },
      }),
    `${name}: ${ROUTE_PREFIX}`,
  )

  ctx.effect(
    () =>
      webServer.registerUpgrade({
        path: `${ROUTE_PREFIX}/tunnel`,
        handler: (req, socket, head) => tunnels.handleUpgrade(req, socket, head),
      }),
    `${name}: ${ROUTE_PREFIX}/tunnel`,
  )

  ctx.effect(() => {
    manager.restore()
    return async () => {
      guiBridge.close()
      await manager.dispose()
    }
  }, `${name}: connections`)

  // Remote mode, HTTP half: DSH offers an official hook around every authenticated /api request. While
  // the window is switched onto another computer, relay the request there instead of answering it here.
  ctx.on(
    'connection/request',
    async (req, res, next) => {
      if (!manager.mode.intercepts(req)) return next()
      await manager.mode.proxyHttp(req, res)
      return undefined
    },
    { prepend: true },
  )

  // Remote mode, WebSocket half: the shared event stream is claimed by DSH's gateway with an exact upgrade
  // route and has no hook, so stand in front of the HTTP server's upgrade listeners. Everything else (this
  // plugin's tunnel included) reaches them untouched. If the server cannot be reached, switching is simply
  // reported as unavailable.
  ctx.effect(() => {
    let uninstall
    let timer
    let tries = 0
    const install = () => {
      const server = webServer.server
      if (!server) return false
      uninstall = installUpgradeInterceptor(server, {
        take: (req) => manager.mode.intercepts(req, { upgrade: true }),
        handle: (req, socket, head) => manager.mode.proxyUpgrade(req, socket, head),
      })
      manager.mode.supported = uninstall !== undefined
      manager.mode.reason = uninstall ? '' : "this DSH's web server cannot be intercepted"
      return true
    }
    if (!install()) {
      manager.mode.reason = "this DSH's web server is still starting"
      timer = setInterval(() => {
        tries += 1
        if (install() || tries >= 80) {
          clearInterval(timer)
          if (!uninstall) manager.mode.reason = "this DSH's web server did not start"
        }
      }, 250)
    }
    return () => {
      clearInterval(timer)
      uninstall?.()
      manager.mode.supported = false
    }
  }, `${name}: remote mode`)

  if (settings.agentTool) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => toolCtx.tools.register(createTool(manager)), `${name}: ${TOOL_NAME} tool`)
      // Connecting out and opening local listeners are user-visible side effects: ask first.
      toolCtx.on('tools/pre-execute', (exec, next) => {
        if (exec.name !== TOOL_NAME) return next()
        const action = exec.arguments?.action
        if (action !== 'connect' && action !== 'forward') return next()
        const target = typeof exec.arguments?.connection === 'string' ? exec.arguments.connection : 'a saved connection'
        const detail = action === 'forward' ? ` and open a local port to ${exec.arguments?.remote_host ?? '127.0.0.1'}:${exec.arguments?.remote_port ?? '?'}` : ''
        return {
          kind: 'ask',
          reason: `remote_connect ${action}: use ${target}${detail}`,
          displayReason: `Remote Connect: ${action === 'forward' ? 'forward a remote port' : 'connect'} (${target})`,
        }
      })
    })
  }
}
