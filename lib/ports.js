/**
 * Best-effort list of TCP ports this machine is listening on, so a remote DSH can offer them for
 * one-click forwarding. Uses the platform's own tool (`ss`, `lsof`, `netstat`); any failure yields
 * an empty list with the reason, never an exception.
 */
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 5000

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && !stdout) reject(error)
      else resolve(String(stdout))
    })
  })
}

/** Split `127.0.0.1:631`, `[::1]:631`, `*:22`, `:::22` into address and port. */
function splitEndpoint(text) {
  const match = /^(.*):(\d{1,5})$/.exec(text.trim())
  if (!match) return undefined
  const port = Number(match[2])
  if (port < 1 || port > 65535) return undefined
  let address = match[1].replace(/^\[|\]$/g, '')
  if (address === '' || address === '*') address = '*'
  address = address.replace(/%[^%]+$/, '')
  return { address, port }
}

function wildcard(address) {
  return address === '*' || address === '0.0.0.0' || address === '::'
}

/** Address a client on this machine should dial for a listener bound to `address`. */
function dialHost(address) {
  if (wildcard(address)) return '127.0.0.1'
  return address
}

function finish(rows) {
  const seen = new Map()
  for (const row of rows) {
    const host = dialHost(row.address)
    const key = `${host}:${row.port}`
    const previous = seen.get(key)
    if (previous) {
      if (!previous.process && row.process) previous.process = row.process
      continue
    }
    seen.set(key, { port: row.port, address: row.address, host, process: row.process, pid: row.pid, public: wildcard(row.address) })
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
}

function parseSs(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4 || columns[0] !== 'LISTEN') continue
    const endpoint = splitEndpoint(columns[3])
    if (!endpoint) continue
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
    rows.push({ ...endpoint, process: proc?.[1], pid: proc ? Number(proc[2]) : undefined })
  }
  return rows
}

function parseLsof(text) {
  const rows = []
  let pid
  let command
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n')) {
      const endpoint = splitEndpoint(line.slice(1))
      if (endpoint) rows.push({ ...endpoint, process: command, pid })
    }
  }
  return rows
}

function parseNetstat(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4 || !/^TCP/i.test(columns[0]) || !/LISTEN/i.test(line)) continue
    const endpoint = splitEndpoint(columns[1])
    if (!endpoint) continue
    const pid = Number(columns[columns.length - 1])
    rows.push({ ...endpoint, pid: Number.isFinite(pid) ? pid : undefined })
  }
  return rows
}

/**
 * @returns {Promise<{ ports: Array<{port: number, address: string, host: string, process?: string, pid?: number, public: boolean}>, error?: string }>}
 */
export async function listListeningPorts() {
  const attempts =
    process.platform === 'win32'
      ? [['netstat', ['-ano', '-p', 'tcp'], parseNetstat]]
      : process.platform === 'darwin'
        ? [['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], parseLsof]]
        : [
            ['ss', ['-H', '-ltnp'], parseSs],
            ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], parseLsof],
            ['netstat', ['-ltn'], (text) => parseSs(text.replace(/^tcp6?\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN.*$/gm, 'LISTEN 0 0 $1 *'))],
          ]
  let lastError
  for (const [file, args, parse] of attempts) {
    try {
      return { ports: finish(parse(await run(file, args))) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ports: [], error: lastError ?? 'no port listing tool available' }
}
