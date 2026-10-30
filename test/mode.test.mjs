/**
 * Remote mode: this computer's DSH window runs on another computer's DSH.
 *
 * Three stand-ins: a fake "local DSH" (this computer's Host: serves /api and the event WebSocket
 * itself, with Remote Connect's hooks in front exactly as index.js installs them), a fake "remote DSH"
 * with the real trust fence (Host must be its own loopback authority, an attached Origin must match,
 * requests need the cookie it minted), and Remote Connect on both sides.
 *
 *   node --test test/*.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveSettings } from '../lib/config.js'
import { detectDshVersion } from '../lib/dsh-version.js'
import { createGuiBridge } from '../lib/gui-bridge.js'
import { RemoteConnectManager } from '../lib/manager.js'
import { installUpgradeInterceptor } from '../lib/remote-mode.js'
import { createServerApi } from '../lib/server-api.js'
import { Store } from '../lib/store.js'
import { WsPeer, acceptKey, newKey } from '../lib/ws.js'

const DSH_TOKEN = 'remote-dsh-launch-token'
const VERSION = '0.2.1-rc.5'
const dirs = []
const managers = []
const servers = []
const bridges = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => (servers.push(server), resolve(server.address().port))))
}

/** The other computer's DSH web server. */
async function startRemoteDsh() {
  let secret = randomBytes(32)
  const stats = { logins: 0, hopHeaders: [] }
  const authority = () => `127.0.0.1:${server.address().port}`
  const cookieName = (host) => `dsh-auth-${createHash('sha256').update(host).digest('base64url')}`
  const cookieValue = (host) => createHmac('sha256', secret).update(host).digest('base64url')
  const trusted = (req) => {
    if (req.headers.host !== authority()) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    return req.headers.origin === undefined || req.headers.origin === `http://${req.headers.host}`
  }
  const authed = (req) => String(req.headers.cookie ?? '').split(';').map((s) => s.trim()).includes(`${cookieName(req.headers.host)}=${cookieValue(req.headers.host)}`)
  const server = http.createServer(async (req, res) => {
    if (!trusted(req)) return res.writeHead(403).end('untrusted host/origin')
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== DSH_TOKEN) return res.writeHead(401).end()
      stats.logins += 1
      res.writeHead(303, { location: './', 'set-cookie': `${cookieName(req.headers.host)}=${cookieValue(req.headers.host)}; Path=/; HttpOnly` })
      return res.end()
    }
    if (!authed(req)) return res.writeHead(401).end('login required')
    stats.hopHeaders.push(req.headers['x-remote-connect-hop'])
    if (url.pathname === '/api/echo') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1; Path=/' })
      return res.end(
        JSON.stringify({
          from: 'REMOTE',
          method: req.method,
          host: req.headers.host,
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          custom: req.headers['x-custom'],
          bodyBytes: body.length,
          bodySha: createHash('sha256').update(body).digest('hex'),
        }),
      )
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      for (let i = 0; i < 3; i += 1) {
        res.write(`chunk${i};`)
        await sleep(40)
      }
      return res.end('done')
    }
    if (url.pathname === '/api/redirect') return res.writeHead(302, { location: `http://${req.headers.host}/api/landed` }).end()
    return res.writeHead(404).end('nope')
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined)
    if (!trusted(req) || !authed(req) || new URL(req.url, 'http://x').pathname !== '/api/remote.mux') return socket.destroy()
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`)
    const ws = new WsPeer(socket, { role: 'server', head, pingMs: 0 })
    ws.on('error', () => undefined)
    ws.sendText('REMOTE-MUX')
    ws.on('data', (buffer) => ws.sendData(buffer))
  })
  const port = await listen(server)
  return {
    port,
    stats,
    rotate() {
      secret = randomBytes(32)
    },
  }
}

/** The other computer's Remote Connect, sharing, with remote control allowed unless told otherwise. */
function otherComputer({ dsh, dshVersion = VERSION, config = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-mode-b-'))
  dirs.push(dir)
  const settings = () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5, ...config })
  let manager
  const guiBridge = createGuiBridge({
    target: () => ({ protocol: 'http:', host: '127.0.0.1', port: dsh.port }),
    authenticatedUrl: (base) => `${base}/?token=${DSH_TOKEN}`,
  })
  bridges.push(guiBridge)
  const serverApi = createServerApi({ settings, version: 'test', dshVersion, tunnelCount: () => manager.share.tunnels.count(), web: () => null })
  manager = new RemoteConnectManager({ store: new Store(join(dir, 'state.json')), settings, logger: { warn() {} }, serverApi, guiBridge })
  managers.push(manager)
  return manager
}

/** This computer: a fake local DSH with Remote Connect's hooks in front of it, as index.js installs them. */
async function thisComputer({ localDsh = VERSION, config = {}, supported = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-mode-a-'))
  dirs.push(dir)
  const settings = () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5, ...config })
  const manager = new RemoteConnectManager({
    store: new Store(join(dir, 'state.json')),
    settings,
    logger: { warn() {} },
    localDsh,
    // Local sign-in: the WebSocket must carry this header (the local cookie, in the real thing).
    admit: (req) => (req.headers['x-local-auth'] === 'ok' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }),
  })
  managers.push(manager)
  const server = http.createServer(async (req, res) => {
    if (manager.mode.intercepts(req)) {
      await manager.mode.proxyHttp(req, res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`LOCAL:${req.url}`)
  })
  // The gateway's own listener: claims the mux path, destroys everything else (like dsh-host-webserver does).
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined)
    if (new URL(req.url, 'http://x').pathname !== '/api/remote.mux') return socket.destroy()
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`)
    const ws = new WsPeer(socket, { role: 'server', head, pingMs: 0 })
    ws.on('error', () => undefined)
    ws.sendText('LOCAL-MUX')
  })
  const uninstall = installUpgradeInterceptor(server, {
    take: (req) => manager.mode.intercepts(req, { upgrade: true }),
    handle: (req, socket, head) => manager.mode.proxyUpgrade(req, socket, head),
  })
  manager.mode.supported = supported
  manager.mode.reason = supported ? '' : 'test says no'
  const port = await listen(server)
  return { manager, port, uninstall }
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), chunkCount: chunks.length }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Open the event WebSocket on `port`, return the first text message and the live peer. */
function openMux(port, headers = {}) {
  const key = newKey()
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/remote.mux',
      agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key, origin: `http://127.0.0.1:${port}`, ...headers },
    })
    req.on('upgrade', (res, socket, head) => {
      const ws = new WsPeer(socket, { role: 'client', head, pingMs: 0 })
      ws.on('error', () => undefined)
      ws.once('text', (text) => resolve({ ws, greeting: text }))
    })
    req.on('response', (res) => {
      res.resume()
      reject(Object.assign(new Error(`not upgraded: HTTP ${res.statusCode}`), { status: res.statusCode }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Two computers wired together: B shares (remote control on), A is connected to B. */
async function pair({ aOptions = {}, bOptions = {}, remoteControl = true } = {}) {
  const dsh = await startRemoteDsh()
  const b = otherComputer({ dsh, ...bOptions })
  await b.call('shareEnable', { host: '127.0.0.1', gui: remoteControl })
  const a = await thisComputer(aOptions)
  const { connection } = await a.manager.addConnection({ url: (await b.call('shareAddress')).url, name: 'B' })
  return { dsh, b, a, connectionId: connection.id, connection }
}

after(async () => {
  for (const manager of managers) await manager.dispose()
  for (const bridge of bridges) bridge.close()
  for (const server of servers) await new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('remote mode', () => {
  it('starts on this computer, and only /api moves when switched', async () => {
    const { a, connectionId, dsh } = await pair()
    assert.equal((await request(a.port, '/api/echo')).body.toString(), 'LOCAL:/api/echo', 'local until switched')
    assert.equal(a.manager.state().mode.active, null)

    const { mode } = await a.manager.call('modeEnter', { id: connectionId })
    assert.equal(mode.active, connectionId)
    assert.equal(mode.name, 'B')
    assert.equal(a.manager.state().connections[0].active, true)

    const echoed = JSON.parse((await request(a.port, '/api/echo')).body.toString())
    assert.equal(echoed.from, 'REMOTE')
    assert.equal(dsh.stats.logins, 1)
    // The page, plugin bundles, this plugin's own routes and the hop-marked traffic all stay local.
    assert.equal((await request(a.port, '/')).body.toString(), 'LOCAL:/')
    assert.equal((await request(a.port, '/plugins/combo.js')).body.toString(), 'LOCAL:/plugins/combo.js')
    assert.equal((await request(a.port, '/remote-connect/api/state')).body.toString(), 'LOCAL:/remote-connect/api/state')
    assert.equal((await request(a.port, '/api/echo', { headers: { 'x-remote-connect-hop': '1' } })).body.toString(), 'LOCAL:/api/echo', 'never relayed twice')

    await a.manager.call('modeLeave')
    assert.equal((await request(a.port, '/api/echo')).body.toString(), 'LOCAL:/api/echo', 'back on this computer')
    assert.equal(a.manager.state().mode.active, null)
  })

  it('relays with Host/Origin rewritten, its own login injected, and nothing leaked either way', async () => {
    const { a, connectionId, dsh } = await pair()
    await a.manager.call('modeEnter', { id: connectionId })
    const seen = JSON.parse(
      (await request(a.port, '/api/echo', { headers: { origin: `http://127.0.0.1:${a.port}`, 'sec-fetch-site': 'same-origin', cookie: 'local-session=secret', 'x-custom': 'kept' } })).body.toString(),
    )
    assert.equal(seen.host, `127.0.0.1:${dsh.port}`)
    assert.equal(seen.origin, undefined, "this window's Origin never reaches the other DSH (it passes its fence as a non-browser caller)")
    assert.match(seen.cookie, /^dsh-auth-/)
    assert.ok(!seen.cookie.includes('local-session'), "this computer's cookie never reaches the other DSH")
    assert.equal(seen.custom, 'kept')
    assert.ok(dsh.stats.hopHeaders.every((value) => value === '1'), 'every relayed request is marked as having crossed a hop')

    const reply = await request(a.port, '/api/echo')
    assert.equal(reply.headers['set-cookie'], undefined, "the other DSH's cookies stay out of this window")
    assert.ok(!JSON.stringify([a.manager.state(), reply.headers]).includes(DSH_TOKEN))
  })

  it('streams bodies and responses, and keeps redirects on this window', async () => {
    const { a, connectionId } = await pair()
    await a.manager.call('modeEnter', { id: connectionId })
    const payload = randomBytes(1536 * 1024 + 3)
    const posted = JSON.parse(
      (await request(a.port, '/api/echo', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) }, body: payload })).body.toString(),
    )
    assert.equal(posted.bodyBytes, payload.length)
    assert.equal(posted.bodySha, createHash('sha256').update(payload).digest('hex'))

    const streamed = await request(a.port, '/api/stream')
    assert.equal(streamed.body.toString(), 'chunk0;chunk1;chunk2;done')
    assert.ok(streamed.chunkCount >= 2, 'arrives incrementally')

    const redirected = await request(a.port, '/api/redirect')
    assert.equal(redirected.headers.location, '/api/landed')
  })

  it('moves the live-event WebSocket too, and only when it is authenticated here', async () => {
    const { a, connectionId } = await pair()
    const local = await openMux(a.port, { 'x-local-auth': 'ok' })
    assert.equal(local.greeting, 'LOCAL-MUX', 'this computer answers while not switched')
    local.ws.destroy()

    await a.manager.call('modeEnter', { id: connectionId })
    await assert.rejects(openMux(a.port), (error) => error.status === 401, 'an unauthenticated client cannot use the relay')

    const remote = await openMux(a.port, { 'x-local-auth': 'ok' })
    assert.equal(remote.greeting, 'REMOTE-MUX')
    const payload = randomBytes(200 * 1024)
    const echoed = await new Promise((resolve) => {
      const chunks = []
      let size = 0
      remote.ws.on('data', (buffer) => {
        chunks.push(buffer)
        size += buffer.length
        if (size >= payload.length) resolve(Buffer.concat(chunks))
      })
      remote.ws.sendData(payload)
    })
    assert.ok(echoed.equals(payload))

    // Switching back cuts the relayed socket, so the UI reconnects to this computer.
    const closed = new Promise((resolve) => remote.ws.once('close', resolve))
    await a.manager.call('modeLeave')
    await closed
    const again = await openMux(a.port, { 'x-local-auth': 'ok' })
    assert.equal(again.greeting, 'LOCAL-MUX')
    again.ws.destroy()
  })

  it('logs in again when the other DSH drops its session cookie', async () => {
    const { a, connectionId, dsh } = await pair()
    await a.manager.call('modeEnter', { id: connectionId })
    assert.equal(JSON.parse((await request(a.port, '/api/echo')).body.toString()).from, 'REMOTE')
    dsh.rotate()
    assert.equal(JSON.parse((await request(a.port, '/api/echo')).body.toString()).from, 'REMOTE')
    assert.equal(dsh.stats.logins, 2)
  })

  it('needs the other computer to allow remote control, and refuses without touching its DSH', async () => {
    const { a, b, connectionId, dsh } = await pair({ remoteControl: false })
    await assert.rejects(a.manager.call('modeEnter', { id: connectionId }), (error) => error.code === 'gui-off')
    assert.equal(a.manager.state().mode.active, null)
    assert.equal(dsh.stats.logins, 0)

    // The user switches it on over there: the very next attempt succeeds, no 25 s wait for a health check.
    await b.call('shareUpdate', { gui: true })
    await a.manager.call('modeEnter', { id: connectionId })
    assert.equal(a.manager.state().mode.active, connectionId)
  })

  it('cuts the window off at once when the other computer turns remote control off', async () => {
    const { a, b, connectionId } = await pair()
    await a.manager.call('modeEnter', { id: connectionId })
    const mux = await openMux(a.port, { 'x-local-auth': 'ok' })
    const closed = new Promise((resolve) => mux.ws.once('close', resolve))
    await b.call('shareUpdate', { gui: false })
    await closed
    const refused = await request(a.port, '/api/echo')
    assert.equal(refused.status, 502, 'new requests fail loudly instead of falling back to this computer')
  })

  it('compares DSH releases and blocks a different one', async () => {
    const same = await pair()
    assert.deepEqual(same.connection.compat, { local: VERSION, remote: VERSION, status: 'same' })

    const different = await pair({ bOptions: { dshVersion: '0.3.0' } })
    assert.deepEqual(different.connection.compat, { local: VERSION, remote: '0.3.0', status: 'different' })
    await assert.rejects(different.a.manager.call('modeEnter', { id: different.connectionId }), (error) => error.code === 'version-mismatch' && /0\.2\.1-rc\.5.*0\.3\.0/.test(error.message))
    assert.equal(different.a.manager.state().mode.active, null)

    const allowed = await pair({ bOptions: { dshVersion: '0.3.0' }, aOptions: { config: { allowVersionMismatch: true } } })
    await allowed.a.manager.call('modeEnter', { id: allowed.connectionId })
    assert.equal(allowed.a.manager.state().mode.active, allowed.connectionId)

    const unknownLocal = await pair({ aOptions: { localDsh: null } })
    assert.equal(unknownLocal.connection.compat.status, 'unknown')
    await assert.rejects(unknownLocal.a.manager.call('modeEnter', { id: unknownLocal.connectionId }), (error) => error.code === 'version-mismatch')
  })

  it('treats a remote that reports no DSH release as too old', async () => {
    const { a, connectionId } = await pair()
    // An older Remote Connect answers /info without a `dsh` field.
    a.manager.conn(connectionId).info.dsh = undefined
    assert.equal(a.manager.compat(a.manager.conn(connectionId)).status, 'remote-old')
    assert.equal(a.manager.state().connections[0].compat.status, 'remote-old')
    await assert.rejects(a.manager.call('modeEnter', { id: connectionId }), (error) => error.code === 'remote-old')
    assert.equal(a.manager.state().mode.active, null)
  })

  it('reports when this DSH cannot be switched at all', async () => {
    const { a, connectionId } = await pair({ aOptions: { supported: false } })
    assert.equal(a.manager.state().mode.supported, false)
    await assert.rejects(a.manager.call('modeEnter', { id: connectionId }), (error) => error.code === 'mode-unsupported' && /test says no/.test(error.message))
  })

  it('leaves remote mode when its connection is disconnected or removed', async () => {
    const first = await pair()
    await first.a.manager.call('modeEnter', { id: first.connectionId })
    await first.a.manager.call('disconnect', { id: first.connectionId })
    assert.equal(first.a.manager.state().mode.active, null)
    assert.equal((await request(first.a.port, '/api/echo')).body.toString(), 'LOCAL:/api/echo')

    const second = await pair()
    await second.a.manager.call('modeEnter', { id: second.connectionId })
    await second.a.manager.call('removeConnection', { id: second.connectionId })
    assert.equal(second.a.manager.state().mode.active, null)
  })
})

describe('plumbing', () => {
  it('finds the DSH release from the way the Host was started', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-ver-'))
    dirs.push(root)
    const write = (path, manifest) => {
      mkdirSync(join(root, path), { recursive: true })
      writeFileSync(join(root, path, 'package.json'), JSON.stringify(manifest))
    }
    write('node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '9.8.7' })
    write('node_modules/@deepseek-ai/dsh-desktop-host', { name: '@deepseek-ai/dsh-desktop-host', version: '1.1.1' })
    // Desktop: argv = [node, <runtime>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js, <runtime>, ...]
    assert.equal(detectDshVersion({ argv: ['node', join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), root], execPath: '/nowhere' }), '9.8.7')
    // CLI: started from inside the dsh package.
    assert.equal(detectDshVersion({ argv: ['node', join(root, 'node_modules/@deepseek-ai/dsh/bin/dsh.js'), 'web'], execPath: '/nowhere' }), '9.8.7')
    // A package.json of something else is not mistaken for DSH.
    assert.equal(detectDshVersion({ argv: ['node', join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')], execPath: join(tmpdir(), 'no-such-dir', 'node') }), '9.8.7')
    assert.equal(detectDshVersion({ argv: ['node', '/definitely/not/here/index.js'], execPath: '/definitely/not/here/node' }), undefined)
  })

  it('the upgrade interceptor passes untouched requests through and restores the originals', async () => {
    const seen = []
    const server = http.createServer()
    server.on('upgrade', (req, socket) => {
      seen.push(`original:${req.url}`)
      socket.destroy()
    })
    const uninstall = installUpgradeInterceptor(server, {
      take: (req) => req.url === '/take',
      handle: (req, socket) => {
        seen.push(`taken:${req.url}`)
        socket.destroy()
      },
    })
    const port = await listen(server)
    const poke = (path) =>
      new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket' }, agent: false })
        req.on('error', () => resolve())
        req.on('response', () => resolve())
        req.end()
      })
    await poke('/take')
    await poke('/leave')
    assert.deepEqual(seen, ['taken:/take', 'original:/leave'])
    uninstall()
    await poke('/take')
    assert.deepEqual(seen.slice(2), ['original:/take'], 'after uninstalling, the original listener sees everything again')
    assert.equal(installUpgradeInterceptor({}, { take: () => false, handle: () => undefined }), undefined, 'no HTTP server, no interceptor')
  })
})
