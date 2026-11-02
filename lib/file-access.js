/**
 * Server role: read and write one file on this computer for a Remote Connect client that is using this
 * computer's DSH (the "open a remote file with a local program" feature, see remote-open.js).
 *
 *   GET /remote-connect/file?path=<abs>&stat=1   JSON { ok, kind, size, mtimeMs, etag }
 *   GET /remote-connect/file?path=<abs>          the file's bytes; `etag` header names this exact version
 *   PUT /remote-connect/file?path=<abs>          replace the file with the request body; needs `If-Match: <etag>`
 *
 * Writes are optimistic: the client sends the etag it last downloaded or uploaded, and a file that changed
 * on this computer in the meantime is refused (412) instead of being overwritten. The body goes to a
 * temporary file next to the target and is renamed over it, so a reader never sees a half-written file and
 * a failed upload leaves the original untouched.
 *
 * The caller is the authenticated DSH owner (index.js checks that and `remoteControlAllowed`), who can
 * already run commands here through the agent; this route adds no new reach.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, realpath, rename, stat, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

class FileError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(payload))
}

/** The version of a file: changes whenever its modification time (to the nanosecond) or size does. */
export function etagOf(st) {
  return `"${st.mtimeNs ?? Math.round(st.mtimeMs * 1e6)}-${st.size}"`
}

function kindOf(st) {
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'directory'
  return 'other'
}

async function resolveTarget(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new FileError(400, 'bad-request', 'path is required')
  if (!isAbsolute(path)) throw new FileError(400, 'bad-request', 'path must be absolute')
  let real
  try {
    real = await realpath(path)
  } catch (error) {
    throw fsError(error)
  }
  let st
  try {
    st = await stat(real, { bigint: true })
  } catch (error) {
    throw fsError(error)
  }
  return { real, st: { ...st, size: Number(st.size), mtimeMs: Number(st.mtimeNs / 1000000n), mode: Number(st.mode), isFile: () => st.isFile(), isDirectory: () => st.isDirectory() } }
}

function fsError(error) {
  const code = error && error.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileError(404, 'not-found', 'The file does not exist on this computer')
  if (code === 'EACCES' || code === 'EPERM') return new FileError(403, 'forbidden', 'This computer does not allow access to that file')
  if (code === 'EISDIR') return new FileError(415, 'not-a-file', 'That path is a folder')
  if (code === 'EROFS') return new FileError(403, 'read-only', 'The file is on a read-only volume')
  return new FileError(500, 'io-error', 'Could not access the file')
}

/** @param {{ maxBytes: number }} options */
export function createFileAccess({ maxBytes }) {
  async function get(req, res, url, head) {
    const { real, st } = await resolveTarget(url.searchParams.get('path'))
    const meta = { kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs, etag: etagOf(st) }
    if (url.searchParams.has('stat')) return sendJson(res, 200, { ok: true, ...meta })
    if (meta.kind !== 'file') throw new FileError(415, 'not-a-file', 'Only regular files can be opened')
    if (st.size > maxBytes) throw new FileError(413, 'too-large', `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit`, { size: st.size, limit: maxBytes })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', etag: meta.etag })
    if (head) return res.end()
    const stream = createReadStream(real)
    res.once('close', () => stream.destroy())
    await pipeline(stream, res).catch(() => res.destroy())
    return undefined
  }

  async function put(req, res, url) {
    const { real, st } = await resolveTarget(url.searchParams.get('path'))
    if (!st.isFile()) throw new FileError(415, 'not-a-file', 'Only regular files can be replaced')
    const expected = String(req.headers['if-match'] ?? '').trim()
    if (expected === '') throw new FileError(428, 'precondition-required', 'If-Match is required')
    if (expected !== etagOf(st)) throw new FileError(412, 'changed', 'The file changed on this computer after it was opened', { etag: etagOf(st) })
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > maxBytes) throw new FileError(413, 'too-large', `The upload is larger than the ${Math.round(maxBytes / 1048576)} MB limit`)

    const temp = join(dirname(real), `.${basename(real)}.dsh-${randomBytes(6).toString('hex')}.tmp`)
    let received = 0
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > maxBytes) callback(new FileError(413, 'too-large', `The upload is larger than the ${Math.round(maxBytes / 1048576)} MB limit`))
        else callback(null, chunk)
      },
    })
    try {
      await pipeline(req, limiter, createWriteStream(temp, { flags: 'wx', mode: st.mode & 0o777 }))
      if (declared > 0 && received !== declared) throw new FileError(400, 'bad-request', 'The upload was cut short')
      await chmod(temp, st.mode & 0o7777).catch(() => undefined)
      // Closest we can get to compare-and-swap with plain files: check again right before the rename.
      const again = await resolveTarget(real)
      if (etagOf(again.st) !== expected) throw new FileError(412, 'changed', 'The file changed on this computer after it was opened', { etag: etagOf(again.st) })
      await rename(temp, real)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error instanceof FileError ? error : fsError(error)
    }
    const after = await resolveTarget(real)
    return sendJson(res, 200, { ok: true, kind: 'file', size: after.st.size, mtimeMs: after.st.mtimeMs, etag: etagOf(after.st) })
  }

  /** Answer one `/file` request. Never throws: failures become `{ ok: false, error }` with a status. */
  async function handle(req, res, url) {
    try {
      const method = req.method ?? 'GET'
      if (method === 'GET' || method === 'HEAD') return await get(req, res, url, method === 'HEAD')
      if (method === 'PUT') return await put(req, res, url)
      res.setHeader('allow', 'GET, HEAD, PUT')
      return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
    } catch (error) {
      const known = error instanceof FileError ? error : fsError(error)
      if (res.headersSent) {
        res.destroy()
        return undefined
      }
      return sendJson(res, known.status, { ok: false, error: { code: known.code, message: known.message, ...known.extra } })
    }
  }

  return { handle }
}
