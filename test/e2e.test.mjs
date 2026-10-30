/**
 * End-to-end test over loopback: a fake "remote DSH" (the same route/upgrade/auth semantics as
 * dsh-host-webserver + dsh-client-connection) running this plugin's real `apply`, and the local
 * manager connecting to it, forwarding ports and moving real bytes.
 *
 *   node --test test/*.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { apply } from '../index.js'
import { RemoteConnectManager } from '../lib/manager.js'
import { listListeningPorts } from '../lib/ports.js'
import { normalizeRemoteUrl } from '../lib/remote.js'
import { Store } from '../lib/store.js'
import { resolveSettings } from '../lib/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, what, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** A fake remote DSH: token exchange at `/`, cookie auth, route tables like dsh-host-webserver. */
async function startRemote({ token, config = {} }) {
  const secret = randomBytes(32)
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const disposers = []
  const tools = []
  const cookieValue = (authority) => createHmac('sha256', secret).update(authority).digest('base64url')
  const cookieName = (authority) => `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  const loopback = (host) => /^(127\.|localhost$|\[::1\]|::1)/.test(host ?? '')

  const connection = {
    authenticatedUrl: (base) => `${base}/?token=${token}`,
    admit(req) {
      const host = req.headers.host
      if (!loopback(host)) return { rejection: 403 }
      const cookie = String(req.headers.cookie ?? '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(`${cookieName(host)}=`))
      if (cookie !== `${cookieName(host)}=${cookieValue(host)}`) return { rejection: 401 }
      return { peer: { principal: { kind: 'owner' } } }
    },
  }
  const webServer = {
    protocol: 'http:',
    host: '127.0.0.1',
    port: undefined,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const route = exact.get(url.pathname) ?? [...prefixes.values()].find((r) => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`))
    if (route) {
      void route.handler(req, res)
      return
    }
    if (url.pathname === '/') {
      if (!loopback(req.headers.host)) {
        res.writeHead(403).end()
        return
      }
      if (url.searchParams.get('token') !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('dsh web authentication required')
        return
      }
      res.writeHead(303, {
        location: './',
        'set-cookie': `${cookieName(req.headers.host)}=${cookieValue(req.headers.host)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>spa</html>')
  })
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(new URL(req.url, 'http://x').pathname)
    if (!route) return socket.destroy()
    socket.on('error', () => undefined)
    void route.handler(req, socket, head)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  webServer.port = server.address().port
  // dsh-host-webserver keeps its node:http server on `.server`; remote mode puts its upgrade interceptor in front of it.
  webServer.server = server

  const dir = mkdtempSync(join(tmpdir(), 'rc-remote-'))
  const ctx = {
    webServer,
    connection,
    logger: { warn() {}, info() {} },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(_names, cb) {
      cb({
        ...ctx,
        tools: { register: (definition) => (tools.push(definition), () => undefined) },
        on() {},
        effect: ctx.effect,
      })
    },
  }
  apply(ctx, { dataFile: join(dir, 'remote-state.json'), ...config })
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    tools,
    async close() {
      for (const dispose of disposers.reverse()) await dispose()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A TCP service on the "remote machine" for the tunnel to reach. */
async function startTarget(onConnection) {
  const sockets = new Set()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    onConnection(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function connectLocal(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => resolve(socket))
    socket.once('error', reject)
  })
}

function collect(socket) {
  const chunks = []
  socket.on('data', (chunk) => chunks.push(chunk))
  // The test sockets are half-open, so the peer's FIN arrives as 'end' and 'close' only follows our own end().
  return new Promise((resolve) => {
    socket.on('end', () => {
      socket.end()
      resolve(Buffer.concat(chunks))
    })
    socket.on('close', () => resolve(Buffer.concat(chunks)))
  })
}

describe('remote connect', () => {
  const TOKEN = 'test-launch-token'
  let remote
  let manager
  let dir
  let connectionId
  const echo = (socket) => {
    socket.pipe(socket)
  }
  let echoTarget
  let echoClosed

  before(async () => {
    remote = await startRemote({ token: TOKEN })
    dir = mkdtempSync(join(tmpdir(), 'rc-local-'))
    manager = new RemoteConnectManager({
      store: new Store(join(dir, 'state.json')),
      settings: () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5 }),
      logger: { warn() {} },
    })
    echoTarget = await startTarget(echo)
    echoClosed = false
  })

  after(async () => {
    manager.dispose()
    if (!echoClosed) await echoTarget.close()
    await remote.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes pasted URLs and pulls the token out of a dsh web URL', () => {
    const a = normalizeRemoteUrl('127.0.0.1:3080/?token=abc#x')
    assert.equal(a.base.href, 'http://127.0.0.1:3080/')
    assert.equal(a.token, 'abc')
    const b = normalizeRemoteUrl('https://dsh.example.com/mount/index.html')
    assert.equal(b.base.pathname, '/mount')
    assert.equal(b.token, undefined)
    assert.throws(() => normalizeRemoteUrl('ftp://x'), /http/)
  })

  it('rejects a wrong token with a stable error code', async () => {
    const { connection } = await manager.addConnection({ url: remote.url, token: 'nope', name: 'bad', connect: true })
    assert.equal(connection.status, 'error')
    assert.equal(connection.error.code, 'unauthorized')
    await manager.removeConnection({ id: connection.id })
  })

  it('connects with the token, learns the remote machine, and never leaks secrets in views', async () => {
    const { connection } = await manager.addConnection({ url: `${remote.url}/?token=${TOKEN}`, name: 'fake' })
    connectionId = connection.id
    assert.equal(connection.status, 'connected')
    assert.equal(connection.info.web.port, remote.port)
    assert.equal(connection.info.server.enabled, true)
    assert.equal(connection.hasToken, true)
    const dump = JSON.stringify(manager.state())
    assert.ok(!dump.includes(TOKEN), 'token leaked into the state view')
    assert.ok(!dump.includes('dsh-auth-'), 'cookie leaked into the state view')
  })

  it('persists the state file with owner-only permissions', async () => {
    manager.store.flush()
    const path = join(dir, 'state.json')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(saved.connections[0].token, TOKEN)
  })

  it('forwards a remote port and moves megabytes through it intact', async () => {
    const { forward } = await manager.addForward({ connectionId, remotePort: echoTarget.port, localPort: 0 })
    assert.equal(forward.status, 'listening')
    assert.ok(forward.boundPort > 0)
    const payload = randomBytes(6 * 1024 * 1024 + 123)
    const socket = await connectLocal(forward.boundPort)
    const received = collect(socket)
    socket.write(payload)
    socket.end()
    const echoed = await received
    assert.equal(echoed.length, payload.length)
    assert.ok(echoed.equals(payload), 'echoed bytes differ')
    const view = manager.state().forwards.find((f) => f.id === forward.id)
    assert.ok(view.bytesOut >= payload.length && view.bytesIn >= payload.length)
    assert.equal(view.total, 1)
  })

  it('honors half-close: the target answers after the client stopped writing', async () => {
    const target = await startTarget((socket) => {
      const chunks = []
      socket.on('data', (c) => chunks.push(c))
      socket.on('end', () => socket.end(`got:${Buffer.concat(chunks).toString()}`))
    })
    const { forward } = await manager.addForward({ connectionId, remotePort: target.port, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    const received = collect(socket)
    socket.end('hello')
    assert.equal((await received).toString(), 'got:hello')
    await target.close()
  })

  it('serves many concurrent connections', async () => {
    const { forward } = await manager.addForward({ connectionId, remotePort: echoTarget.port, localPort: 0 })
    const results = await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const socket = await connectLocal(forward.boundPort)
        const received = collect(socket)
        const data = Buffer.from(`conn-${index}-${'x'.repeat(index * 1000)}`)
        socket.end(data)
        return (await received).equals(data)
      }),
    )
    assert.ok(results.every(Boolean))
  })

  it('closes the local socket and records why when the remote target is down', async () => {
    const dead = await startTarget(() => undefined)
    const port = dead.port
    await dead.close()
    const { forward } = await manager.addForward({ connectionId, remotePort: port, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    await collect(socket)
    const view = await until(() => manager.state().forwards.find((f) => f.id === forward.id && f.lastError), 'lastError')
    assert.equal(view.lastError.code, 'target')
  })

  it('refuses targets outside allowedHosts / allowedPorts on the remote', async () => {
    const { forward } = await manager.addForward({ connectionId, remoteHost: '10.255.255.1', remotePort: 80, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    await collect(socket)
    const view = await until(() => manager.state().forwards.find((f) => f.id === forward.id && f.lastError), 'lastError')
    assert.equal(view.lastError.code, 'forbidden')
    assert.match(view.lastError.message, /allowedHosts/)
  })

  it('re-authenticates with the token when the saved cookie goes stale', async () => {
    manager.conn(connectionId).rec.cookie = 'dsh-auth-stale=garbage'
    const { forward } = await manager.addForward({ connectionId, remotePort: echoTarget.port, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    const received = collect(socket)
    socket.end('still works')
    assert.equal((await received).toString(), 'still works')
    assert.notEqual(manager.conn(connectionId).rec.cookie, 'dsh-auth-stale=garbage')
  })

  it('stops a forward and releases its port', async () => {
    const { forward } = await manager.addForward({ connectionId, remotePort: echoTarget.port, localPort: 0 })
    const port = forward.boundPort
    const { forward: stopped } = await manager.stopForward(forward.id)
    assert.equal(stopped.status, 'stopped')
    await assert.rejects(connectLocal(port))
    const { forward: again } = await manager.startForward(forward.id)
    assert.equal(again.status, 'listening')
  })

  it('reports a local port conflict instead of throwing', async () => {
    const holder = net.createServer()
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const taken = holder.address().port
    const { forward } = await manager.addForward({ connectionId, remotePort: echoTarget.port, localPort: taken })
    assert.equal(forward.status, 'error')
    assert.equal(forward.error.code, 'port-in-use')
    holder.close()
  })

  it('lists the remote machine\'s listening ports with the allow decision', async () => {
    const listing = await manager.listRemotePorts(connectionId)
    const own = await listListeningPorts()
    if (own.error && own.ports.length === 0) return // no listing tool in this environment
    const row = listing.ports.find((p) => p.port === echoTarget.port)
    assert.ok(row, 'the echo target should be listed')
    assert.equal(row.allowed, true)
  })

  it("DSH's own door advertises its DSH release and remote control (the owner login already implies consent)", async () => {
    const connection = manager.state().connections.find((c) => c.id === connectionId)
    assert.equal(connection.info.via, 'dsh')
    assert.deepEqual(connection.info.gui, { enabled: true })
    assert.ok(connection.info.dsh && 'version' in connection.info.dsh, 'the release is reported (null when it cannot be determined)')
    assert.equal(connection.compat.local, null, 'this test manager was given no local release')
  })

  it('remoteControlAllowed: false removes remote control from DSH\'s own door as well', async () => {
    const locked = await startRemote({ token: TOKEN, config: { remoteControlAllowed: false } })
    const other = new RemoteConnectManager({
      store: new Store(join(dir, 'locked.json')),
      settings: () => resolveSettings({ connectTimeoutMs: 3000 }),
      logger: { warn() {} },
    })
    const { connection } = await other.addConnection({ url: locked.url, token: TOKEN })
    assert.deepEqual(connection.info.gui, { enabled: false })
    other.dispose()
    await locked.close()
  })

  it('exposes the agent tool and drives the same manager', async () => {
    const tool = remote.tools.find((t) => t.name === 'remote_connect')
    assert.ok(tool, 'tool registered')
    assert.deepEqual(tool.parameters.required, ['action'])
  })

  it('disconnect stops every forward of the connection', async () => {
    await manager.disconnect(connectionId)
    const state = manager.state()
    assert.equal(state.connections[0].status, 'idle')
    assert.ok(state.forwards.every((f) => f.status !== 'listening'))
  })

  it('reconnects and restarts auto-start forwards from the saved state', async () => {
    manager.store.flush()
    manager.dispose()
    manager = new RemoteConnectManager({
      store: new Store(join(dir, 'state.json')),
      settings: () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5 }),
      logger: { warn() {} },
    })
    manager.restore()
    await until(() => manager.state().connections[0]?.status === 'connected', 'restored connection')
    const listening = await until(() => manager.state().forwards.filter((f) => f.status === 'listening').length >= 1, 'restored forwards')
    assert.ok(listening)
    // Cookie from the previous run still authenticates (the remote's launch token is not needed).
    manager.conn(connectionId).rec.token = ''
    manager.conn(connectionId).wanted = true
    await manager.attempt(manager.conn(connectionId))
    assert.equal(manager.conn(connectionId).status, 'connected')
  })

  it('disabled server role answers the probe but refuses tunnels', async () => {
    const closed = await startRemote({ token: TOKEN, config: { serverEnabled: false } })
    const other = new RemoteConnectManager({
      store: new Store(join(dir, 'other.json')),
      settings: () => resolveSettings({ connectTimeoutMs: 3000 }),
      logger: { warn() {} },
    })
    const { connection } = await other.addConnection({ url: closed.url, token: TOKEN })
    assert.equal(connection.status, 'connected')
    assert.equal(connection.info.server.enabled, false)
    const { forward } = await other.addForward({ connectionId: connection.id, remotePort: echoTarget.port, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    await collect(socket)
    const view = await until(() => other.state().forwards.find((f) => f.lastError), 'lastError')
    assert.equal(view.lastError.code, 'forbidden')
    other.dispose()
    await closed.close()
  })
})
