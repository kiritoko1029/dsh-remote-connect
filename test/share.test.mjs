/**
 * "Share this computer": the dedicated listener a DSH desktop app needs, since its own web server is
 * loopback-only on a random port. Two managers play the two machines: B shares, A connects with the
 * copied address.
 *
 *   node --test test/*.test.mjs
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveSettings } from '../lib/config.js'
import { RemoteConnectManager } from '../lib/manager.js'
import { createServerApi } from '../lib/server-api.js'
import { Store } from '../lib/store.js'
import { renderState } from '../lib/tool.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dirs = []
const managers = []
const servers = []

function side({ dir = mkdtempSync(join(tmpdir(), 'rc-share-')), config = {}, withShare = true } = {}) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const settings = () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5, ...config })
  let manager
  const serverApi = withShare
    ? createServerApi({ settings, version: 'test', tunnelCount: () => manager.share.tunnels.count(), web: () => ({ protocol: 'http:', host: '127.0.0.1', port: 1 }) })
    : undefined
  manager = new RemoteConnectManager({ store: new Store(join(dir, 'state.json')), settings, logger: { warn() {} }, serverApi })
  managers.push(manager)
  return { manager, dir }
}

async function target(onConnection) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => undefined)
    onConnection(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server.address().port
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
  return new Promise((resolve) => {
    socket.on('end', () => {
      socket.end()
      resolve(Buffer.concat(chunks))
    })
    socket.on('close', () => resolve(Buffer.concat(chunks)))
  })
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

after(async () => {
  for (const manager of managers) await manager.dispose()
  for (const server of servers) await new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('share this computer', () => {
  it('stays off until the user turns it on, and the address needs a running listener', async () => {
    const { manager } = side()
    const view = manager.state().share
    assert.equal(view.allowed, true)
    assert.equal(view.enabled, false)
    assert.equal(view.status, 'stopped')
    assert.equal(view.maskedUrl, '')
    await assert.rejects(manager.call('shareAddress'), /not on/)
  })

  it('a second computer connects with the copied address and forwards a port', async () => {
    const b = side()
    const { share } = await b.manager.call('shareEnable', { host: '127.0.0.1' })
    assert.equal(share.status, 'listening')
    assert.ok(share.boundPort > 0)
    const { url } = await b.manager.call('shareAddress')
    const token = new URL(url).searchParams.get('token')
    assert.ok(token.length >= 40, 'the token has 256 bits')
    assert.ok(share.maskedUrl.includes('…') && !share.maskedUrl.includes(token))

    const echoPort = await target((socket) => socket.pipe(socket))
    const a = side({ withShare: false })
    const { connection } = await a.manager.addConnection({ url, name: 'B' })
    assert.equal(connection.status, 'connected')
    assert.equal(connection.info.via, 'share')
    assert.equal(connection.info.web, null, 'the share door never advertises the DSH web login')

    const { forward } = await a.manager.addForward({ connectionId: connection.id, remotePort: echoPort, localPort: 0 })
    assert.equal(forward.status, 'listening')
    const payload = randomBytes(1024 * 1024 + 7)
    const socket = await connectLocal(forward.boundPort)
    const received = collect(socket)
    socket.end(payload)
    assert.ok((await received).equals(payload))
    assert.equal(typeof b.manager.state().share.tunnels, 'number')
  })

  it('keeps the same port and token across a restart, so a copied address stays valid', async () => {
    const first = side()
    await first.manager.call('shareEnable', { host: '127.0.0.1' })
    const before = await first.manager.call('shareAddress')
    first.manager.store.flush()
    await first.manager.dispose()

    const second = side({ dir: first.dir })
    second.manager.restore()
    await new Promise((resolve) => {
      const wait = () => (second.manager.state().share.status === 'listening' ? resolve() : setTimeout(wait, 20))
      wait()
    })
    const after = await second.manager.call('shareAddress')
    assert.equal(after.url, before.url)
  })

  it('falls back to a free port when the saved one is taken, and says so', async () => {
    const holder = net.createServer()
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve))
    servers.push(holder)
    const taken = holder.address().port
    const dir = mkdtempSync(join(tmpdir(), 'rc-share-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, share: { enabled: true, host: '127.0.0.1', port: taken, token: 'x'.repeat(43), secret: 'y'.repeat(43) } }))
    const { manager } = side({ dir })
    await manager.share.restore()
    const view = manager.state().share
    assert.equal(view.status, 'listening')
    assert.notEqual(view.boundPort, taken)
    assert.equal(view.notice, 'port-changed')
  })

  it('fails loudly when the user asks for a port that is taken', async () => {
    const holder = net.createServer()
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve))
    servers.push(holder)
    const { manager } = side()
    await assert.rejects(manager.call('shareEnable', { host: '127.0.0.1', port: holder.address().port }), (error) => error.code === 'port-in-use')
    assert.equal(manager.state().share.status, 'error')
  })

  it('refuses browsers and unauthenticated callers', async () => {
    const { manager } = side()
    const { share } = await manager.call('shareEnable', { host: '127.0.0.1' })
    const { url } = await manager.call('shareAddress')
    const port = share.boundPort
    const token = new URL(url).searchParams.get('token')

    assert.equal((await get(port, `/?token=${token}`, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await get(port, `/?token=${token}`, { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await get(port, '/remote-connect/info')).status, 401)
    assert.equal((await get(port, '/remote-connect/ports')).status, 401)

    const ok = await get(port, `/?token=${token}`)
    assert.equal(ok.status, 303)
    const cookie = ok.headers['set-cookie'][0].split(';', 1)[0]
    assert.ok(cookie.startsWith('dsh-auth-'))
    const info = await get(port, '/remote-connect/info', { cookie })
    assert.equal(info.status, 200)
    assert.equal(JSON.parse(info.body).via, 'share')
    assert.equal((await get(port, '/anything-else', { cookie })).status, 404)
    assert.equal((await get(port, '/remote-connect/info', { cookie: `${cookie}tampered` })).status, 401)
  })

  it('rate-limits wrong tokens', async () => {
    const { manager } = side()
    const { share } = await manager.call('shareEnable', { host: '127.0.0.1' })
    let last
    for (let i = 0; i < 12; i += 1) last = await get(share.boundPort, '/?token=wrong')
    assert.equal(last.status, 429)
  })

  it('reset token: old cookies and old addresses stop working, the new one works', async () => {
    const b = side()
    await b.manager.call('shareEnable', { host: '127.0.0.1' })
    const { url: oldUrl } = await b.manager.call('shareAddress')
    const echoPort = await target((socket) => socket.pipe(socket))
    const a = side({ withShare: false })
    const { connection } = await a.manager.addConnection({ url: oldUrl })
    assert.equal(connection.status, 'connected')

    await b.manager.call('shareRotate')
    const { forward } = await a.manager.addForward({ connectionId: connection.id, remotePort: echoPort, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    await collect(socket)
    const failed = a.manager.state().forwards.find((f) => f.id === forward.id)
    assert.equal(failed.lastError.code, 'unauthorized')

    const { url: newUrl } = await b.manager.call('shareAddress')
    assert.notEqual(newUrl, oldUrl)
    await a.manager.call('updateConnection', { id: connection.id, url: newUrl })
    const retry = await connectLocal(forward.boundPort)
    const received = collect(retry)
    retry.end('after reset')
    assert.equal((await received).toString(), 'after reset')
  })

  it('honours the remote allow-lists like the DSH door does', async () => {
    const b = side({ config: { allowedHosts: ['127.0.0.1'], allowedPorts: ['1-1000'] } })
    await b.manager.call('shareEnable', { host: '127.0.0.1' })
    const { url } = await b.manager.call('shareAddress')
    const echoPort = await target((socket) => socket.pipe(socket))
    assert.ok(echoPort > 1000)
    const a = side({ withShare: false })
    const { connection } = await a.manager.addConnection({ url })
    const { forward } = await a.manager.addForward({ connectionId: connection.id, remotePort: echoPort, localPort: 0 })
    const socket = await connectLocal(forward.boundPort)
    await collect(socket)
    const view = a.manager.state().forwards.find((f) => f.id === forward.id)
    assert.equal(view.lastError.code, 'forbidden')
    assert.match(view.lastError.message, /allowedPorts/)
  })

  it('a connection added without a token says what to do instead of retrying forever', async () => {
    const a = side({ withShare: false })
    const { connection } = await a.manager.addConnection({ url: 'http://127.0.0.1:9' })
    assert.equal(connection.status, 'error')
    assert.equal(connection.error.code, 'no-token')
    assert.match(connection.error.message, /Copy connection address/)
    assert.equal(a.manager.conn(connection.id).timer, undefined, 'no retry is scheduled for a missing token')
  })

  it('can be turned off by configuration', async () => {
    const { manager } = side({ config: { shareAllowed: false } })
    assert.equal(manager.state().share.allowed, false)
    await assert.rejects(manager.call('shareEnable', { host: '127.0.0.1' }), (error) => error.code === 'share-disabled')
  })

  it('turning it off closes the door and the tunnels', async () => {
    const { manager } = side()
    const { share } = await manager.call('shareEnable', { host: '127.0.0.1' })
    await manager.call('shareDisable')
    assert.equal(manager.state().share.status, 'stopped')
    await assert.rejects(get(share.boundPort, '/'))
  })

  it('never puts the token or cookie secret in a view, a log line for the model, or the tool text', async () => {
    const { manager, dir } = side()
    await manager.call('shareEnable', { host: '127.0.0.1' })
    const { url } = await manager.call('shareAddress')
    const token = new URL(url).searchParams.get('token')
    manager.store.flush()
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.equal(saved.share.token, token, 'the token is persisted (0600 file) so the address survives restarts')
    const secret = saved.share.secret
    const exposed = `${JSON.stringify(manager.state())}\n${renderState(manager.state())}`
    assert.ok(!exposed.includes(token) && !exposed.includes(secret))
    assert.match(renderState(manager.state()), /Sharing this computer: on/)
    await sleep(0)
  })
})
