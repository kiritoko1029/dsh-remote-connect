/**
 * Opening a remote computer's files with this computer's programs (lib/remote-open.js, lib/file-access.js).
 *
 * Same stand-ins as mode.test.mjs: a fake remote DSH (trust fence, cookie login, plus the real
 * /remote-connect/file route), Remote Connect on both computers, and a fake local DSH that answers the three
 * session calls the way the real Host would and records what it was asked.
 *
 *   node --test test/*.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveSettings } from '../lib/config.js'
import { createFileAccess } from '../lib/file-access.js'
import { createGuiBridge } from '../lib/gui-bridge.js'
import { RemoteConnectManager } from '../lib/manager.js'
import { createServerApi } from '../lib/server-api.js'
import { Store } from '../lib/store.js'

// Diagnostics go to $DSH_HOME/remote-connect/open.log: keep them out of the real one.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rc-open-home-'))

const DSH_TOKEN = 'remote-dsh-launch-token'
const LOCAL_TOKEN = 'local-dsh-launch-token'
const dirs = []
const managers = []
const servers = []
const bridges = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => (servers.push(server), resolve(server.address().port))))
}

/** A DSH web server with the real trust fence and cookie login; `routes` answers the authenticated requests. */
function fakeDsh(token, routes) {
  const secret = randomBytes(32)
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
      if (url.searchParams.get('token') !== token) return res.writeHead(401).end()
      res.writeHead(303, { location: './', 'set-cookie': `${cookieName(req.headers.host)}=${cookieValue(req.headers.host)}; Path=/; HttpOnly` })
      return res.end()
    }
    if (!authed(req)) return res.writeHead(401).end('login required')
    return routes(req, res, url)
  })
  return server
}

/** Remote DSH: serves /remote-connect/file with the real implementation. */
async function startRemoteDsh({ maxBytes = 1024 * 1024 } = {}) {
  const files = createFileAccess({ maxBytes })
  const server = fakeDsh(DSH_TOKEN, (req, res, url) => {
    if (url.pathname === '/remote-connect/file') return files.handle(req, res, url)
    return res.writeHead(404).end('nope')
  })
  return { port: await listen(server) }
}

/** The other computer's Remote Connect, sharing, with remote control on. */
function otherComputer(dsh) {
  const dir = tempDir('rc-open-b-')
  const settings = () => resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5 })
  let manager
  const guiBridge = createGuiBridge({ target: () => ({ protocol: 'http:', host: '127.0.0.1', port: dsh.port }), authenticatedUrl: (base) => `${base}/?token=${DSH_TOKEN}` })
  bridges.push(guiBridge)
  const serverApi = createServerApi({ settings, version: 'test', dshVersion: '1.0.0', tunnelCount: () => manager.share.tunnels.count(), web: () => null })
  manager = new RemoteConnectManager({ store: new Store(join(dir, 'state.json')), settings, logger: { warn() {} }, serverApi, guiBridge })
  managers.push(manager)
  return manager
}

/** What the window sends: `args` is keyed by parameter name (`{}` without parameters, `{ request }` for these calls). */
function envelope(values) {
  const args = values.length === 0 ? {} : { request: values[0] }
  return JSON.stringify({ type: 'client-request', rpcId: randomBytes(4).toString('hex'), method: 'x', payload: { args } })
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** This computer: the hooks of index.js in front of a fake local Host. */
async function thisComputer({ cleanupMinutes = 60 } = {}) {
  const dir = tempDir('rc-open-a-')
  const root = join(dir, 'copies')
  const calls = { applications: [], open: [], can: 0 }
  let port = 0
  const base = resolveSettings({ connectTimeoutMs: 3000, keepAliveSeconds: 5 })
  const settings = () => ({ ...base, openCleanupMinutes: cleanupMinutes })
  const guiBridge = createGuiBridge({ target: () => ({ protocol: 'http:', host: '127.0.0.1', port }), authenticatedUrl: (b) => `${b}/?token=${LOCAL_TOKEN}` })
  bridges.push(guiBridge)
  const manager = new RemoteConnectManager({
    store: new Store(join(dir, 'state.json')),
    settings,
    logger: { warn() {}, info() {} },
    guiBridge,
    localDsh: '1.0.0',
    admit: () => ({ peer: { principal: { kind: 'owner' } } }),
  })
  managers.push(manager)
  manager.mode.supported = true
  manager.remoteOpen.root = root
  manager.remoteOpen.pollMs = 40
  manager.remoteOpen.isHeld = async () => false

  const server = fakeDsh(LOCAL_TOKEN, async (req, res, url) => {
    if (url.pathname.startsWith('/api/session/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const args = message.payload.args
      const reply = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }))
      // Like the real Host: `args` must be a plain object keyed by parameter name (never an array).
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: { code: 'gateway/internal', message: 'Remote payload must contain exactly one plain-object args field', details: {} } } }),
        )
      }
      if (url.pathname.endsWith('canOpenWorkspacePath')) {
        calls.can += 1
        return reply(true)
      }
      // Like the real Host (verifyDesktopPath): only a path that is its own resolved form is "verified". This
      // matters on macOS, where the system temporary folder is reached through a symlink.
      let verified = false
      try {
        verified = realpathSync(args.request.path) === args.request.path
      } catch {
        verified = false
      }
      if (!verified) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'Path has no verified Host path', details: {} } } }),
        )
      }
      if (url.pathname.endsWith('workspacePathApplications')) {
        calls.applications.push(args.request.path)
        return reply([{ id: 'local.editor', name: 'Local Editor', default: true, icon: null }])
      }
      calls.open.push({ ...args.request, content: existsSync(args.request.path) ? readFileSync(args.request.path, 'utf8') : null })
      return reply({ opened: true })
    }
    return res.writeHead(200, { 'content-type': 'text/plain' }).end(`LOCAL:${url.pathname}`)
  })
  // index.js's `connection/request` hook, minus the authentication (the fake Host above does its own).
  const front = http.createServer(async (req, res) => {
    if (manager.mode.intercepts(req)) {
      if (manager.remoteOpen.claims(req)) return manager.remoteOpen.handle(req, res)
      return manager.mode.proxyHttp(req, res)
    }
    return server.emit('request', req, res)
  })
  port = await listen(front)
  servers.push(server)
  // The fake Host and the front share one port: the Host's trust fence compares Host with this port.
  server.address = () => ({ port })
  return { manager, port, calls, root }
}

async function pair(options) {
  const dsh = await startRemoteDsh(options?.remote)
  const b = otherComputer(dsh)
  await b.call('shareEnable', { host: '127.0.0.1', gui: true })
  const a = await thisComputer(options?.local)
  const { connection } = await a.manager.addConnection({ url: (await b.call('shareAddress')).url, name: 'B' })
  return { a, b, connectionId: connection.id }
}

after(async () => {
  for (const manager of managers) await manager.dispose()
  for (const bridge of bridges) bridge.close()
  for (const server of servers) await new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('opening remote files with local programs', () => {
  it('copies the file here, opens the copy with the local Host, sends edits back and cleans up', async () => {
    const { a, connectionId } = await pair({ local: { cleanupMinutes: 0.02 } })
    const remoteDir = tempDir('rc-open-files-')
    const remoteFile = join(remoteDir, 'notes 1.md')
    writeFileSync(remoteFile, 'hello from the remote')

    // Not in remote mode the hook claims nothing: the local Host answers its own calls.
    assert.equal(a.manager.remoteOpen.claims({ method: 'POST', url: '/api/session/openWorkspacePath', headers: {} }), false)

    await a.manager.call('modeEnter', { id: connectionId })

    assert.equal((await post(a.port, '/api/session/canOpenWorkspacePath', envelope([]))).json.result.value, true, 'this computer answers, not the remote')

    const apps = await post(a.port, '/api/session/workspacePathApplications', envelope([{ path: remoteFile }]))
    assert.equal(apps.json.result.value[0].name, 'Local Editor')
    assert.match(a.calls.applications[0], /probe\.md$/, 'the local Host is asked about a same-type probe file, not the remote path')
    assert.ok(!a.calls.applications[0].includes(remoteDir))

    const opened = await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: remoteFile, application: 'local.editor' }]))
    assert.equal(opened.json.result.ok, true)
    assert.equal(a.calls.open.length, 1)
    const copy = a.calls.open[0].path
    assert.equal(a.calls.open[0].application, 'local.editor', 'the chosen program is passed through')
    assert.equal(a.calls.open[0].content, 'hello from the remote', 'the copy was complete before the program was started')
    assert.equal(basename(copy), 'notes 1.md', 'file name (and so its type) is kept')
    assert.ok(copy.startsWith(a.manager.remoteOpen.root), 'the copy is in the private folder')
    assert.equal(realpathSync(copy), copy, 'the copy path is its own real path, as the local Host requires')
    assert.equal(statSync(copy).mode & 0o077, 0, 'private to the user')

    // The program saves: the new content reaches the remote computer.
    writeFileSync(copy, 'edited here')
    for (let i = 0; i < 100 && readFileSync(remoteFile, 'utf8') !== 'edited here'; i += 1) await sleep(50)
    assert.equal(readFileSync(remoteFile, 'utf8'), 'edited here')
    assert.deepEqual(a.manager.state().pendingFiles, [])

    // A second save, the way editors do it: write a new file and rename it over the copy.
    const swap = `${copy}.swap`
    writeFileSync(swap, 'edited twice')
    const { renameSync } = await import('node:fs')
    renameSync(swap, copy)
    for (let i = 0; i < 100 && readFileSync(remoteFile, 'utf8') !== 'edited twice'; i += 1) await sleep(50)
    assert.equal(readFileSync(remoteFile, 'utf8'), 'edited twice')

    // In sync and idle: the copy disappears.
    for (let i = 0; i < 100 && existsSync(copy); i += 1) await sleep(100)
    assert.equal(existsSync(copy), false, 'synced copy is deleted once idle')
  })

  it('never overwrites a file that changed on the other computer, and keeps the edited copy', async () => {
    const { a, connectionId } = await pair({ local: { cleanupMinutes: 0.02 } })
    const remoteFile = join(tempDir('rc-open-files-'), 'a.txt')
    writeFileSync(remoteFile, 'v1')
    await a.manager.call('modeEnter', { id: connectionId })
    await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: remoteFile }]))
    const copy = a.calls.open[0].path

    writeFileSync(remoteFile, 'changed over there!')
    writeFileSync(copy, 'my edit')
    for (let i = 0; i < 100 && a.manager.state().pendingFiles.length === 0; i += 1) await sleep(50)
    await sleep(300)

    assert.equal(readFileSync(remoteFile, 'utf8'), 'changed over there!', 'remote file untouched')
    assert.equal(readFileSync(copy, 'utf8'), 'my edit', 'edited copy is kept')
    const [pending] = a.manager.state().pendingFiles
    assert.equal(pending.conflict, true)
    assert.equal(pending.remotePath, remoteFile)
    await sleep(1500) // longer than the cleanup delay
    assert.equal(existsSync(copy), true, 'a copy that is not on the other computer is never deleted')
  })

  it('opening again does not overwrite unsent edits', async () => {
    const { a, connectionId } = await pair({ local: { cleanupMinutes: 60 } })
    const remoteFile = join(tempDir('rc-open-files-'), 'b.txt')
    writeFileSync(remoteFile, 'one')
    await a.manager.call('modeEnter', { id: connectionId })
    await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: remoteFile }]))
    const copy = a.calls.open[0].path
    // Make the upload fail so the edit stays unsent.
    a.manager.remoteOpen.upload = async () => {
      throw new Error('offline')
    }
    writeFileSync(copy, 'unsent')
    await sleep(300)
    await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: remoteFile }]))
    assert.equal(readFileSync(copy, 'utf8'), 'unsent')
    assert.equal(a.calls.open[1].content, 'unsent')
  })

  it('refuses folders and oversized files with a message', async () => {
    const { a, connectionId } = await pair({ remote: { maxBytes: 1024 } })
    const folder = tempDir('rc-open-files-')
    const big = join(folder, 'big.bin')
    writeFileSync(big, Buffer.alloc(4096))
    await a.manager.call('modeEnter', { id: connectionId })

    const dir = await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: folder }]))
    assert.equal(dir.json.result.ok, false)
    assert.match(dir.json.result.error.message, /Folders/)
    assert.equal(a.calls.open.length, 0, 'nothing was opened')

    const tooBig = await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: big }]))
    assert.equal(tooBig.json.result.ok, false)
    assert.equal(a.calls.open.length, 0)

    const missing = await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: join(folder, 'nope.txt') }]))
    assert.equal(missing.json.result.ok, false)
    assert.equal(missing.json.result.error.code, 'remote-connect/remote-not-found')
  })

  it('shutdown sends what is unsent, deletes synced copies and keeps the rest', async () => {
    const { a, connectionId } = await pair({ local: { cleanupMinutes: 60 } })
    const folder = tempDir('rc-open-files-')
    const synced = join(folder, 's.txt')
    const late = join(folder, 'l.txt')
    writeFileSync(synced, 's')
    writeFileSync(late, 'l')
    await a.manager.call('modeEnter', { id: connectionId })
    await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: synced }]))
    await post(a.port, '/api/session/openWorkspacePath', envelope([{ path: late }]))
    const [syncedCopy, lateCopy] = a.calls.open.map((call) => call.path)

    a.manager.remoteOpen.stop() // the edit lands between two polls, as at a sudden quit
    writeFileSync(lateCopy, 'late edit')
    const future = new Date(Date.now() + 5000)
    utimesSync(lateCopy, future, future)
    await a.manager.remoteOpen.dispose()

    assert.equal(readFileSync(late, 'utf8'), 'late edit', 'unsent edit was sent at shutdown')
    assert.equal(existsSync(syncedCopy), false)
    assert.equal(existsSync(lateCopy), false, 'and then deleted, being in sync')
  })
})

describe('file route', () => {
  async function route(maxBytes = 1024) {
    const access = createFileAccess({ maxBytes })
    const server = http.createServer((req, res) => access.handle(req, res, new URL(req.url, 'http://x')))
    const port = await listen(server)
    const call = (method, path, { headers = {}, body } = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        req.on('error', reject)
        req.end(body)
      })
    return call
  }

  it('reads, versions and replaces a file atomically', async () => {
    const call = await route()
    const dir = tempDir('rc-file-')
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'abc', { mode: 0o640 })
    const q = (extra = '') => `/remote-connect/file?path=${encodeURIComponent(file)}${extra}`

    const read = await call('GET', q())
    assert.equal(read.body.toString(), 'abc')
    const etag = read.headers.etag
    assert.ok(etag)

    assert.equal((await call('PUT', q(), { body: 'x' })).status, 428, 'If-Match is required')
    assert.equal((await call('PUT', q(), { headers: { 'if-match': '"stale"' }, body: 'x' })).status, 412)
    assert.equal(readFileSync(file, 'utf8'), 'abc')

    const put = await call('PUT', q(), { headers: { 'if-match': etag }, body: 'new content' })
    assert.equal(put.status, 200)
    assert.equal(readFileSync(file, 'utf8'), 'new content')
    assert.equal(statSync(file).mode & 0o777, 0o640, 'permissions kept')
    assert.notEqual(JSON.parse(put.body).etag, etag)
    assert.deepEqual(
      (await import('node:fs')).readdirSync(dir),
      ['f.txt'],
      'no temporary file is left behind',
    )
    assert.equal((await call('PUT', q(), { headers: { 'if-match': etag }, body: 'again' })).status, 412, 'the old etag no longer matches')
  })

  it('rejects relative paths, folders, missing files and oversize bodies', async () => {
    const call = await route(10)
    const dir = tempDir('rc-file-')
    const file = join(dir, 'f.txt')
    writeFileSync(file, '0123456789')
    assert.equal((await call('GET', '/remote-connect/file?path=relative.txt')).status, 400)
    assert.equal((await call('GET', `/remote-connect/file?path=${encodeURIComponent(join(dir, 'missing'))}`)).status, 404)
    assert.equal((await call('GET', `/remote-connect/file?path=${encodeURIComponent(dir)}`)).status, 415)
    const stat = JSON.parse((await call('GET', `/remote-connect/file?stat=1&path=${encodeURIComponent(dir)}`)).body)
    assert.equal(stat.kind, 'directory')
    const etag = (await call('GET', `/remote-connect/file?path=${encodeURIComponent(file)}`)).headers.etag
    const big = await call('PUT', `/remote-connect/file?path=${encodeURIComponent(file)}`, { headers: { 'if-match': etag }, body: 'x'.repeat(50) })
    assert.equal(big.status, 413)
    assert.equal(readFileSync(file, 'utf8'), '0123456789')
    mkdirSync(join(dir, 'sub'))
  })
})
