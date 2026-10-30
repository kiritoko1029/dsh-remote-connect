/**
 * Persistence for saved connections and forwards: one JSON file, written atomically with owner-only
 * permissions because it holds remote access tokens and session cookies.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const VERSION = 1

/** Default location: `$DSH_HOME/remote-connect/state[-<profile>].json`. */
export function defaultStorePath(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  const profile = env.DSH_PROFILE && /^[\w.-]+$/.test(env.DSH_PROFILE) ? `-${env.DSH_PROFILE}` : ''
  return join(home, 'remote-connect', `state${profile}.json`)
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function int(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}

function sanitize(raw) {
  const connections = []
  const forwards = []
  if (raw && typeof raw === 'object') {
    for (const item of Array.isArray(raw.connections) ? raw.connections : []) {
      if (!item || typeof item !== 'object' || str(item.id) === '' || str(item.url) === '') continue
      connections.push({
        id: str(item.id),
        name: str(item.name),
        url: str(item.url),
        token: str(item.token),
        cookie: str(item.cookie),
        insecure: item.insecure === true,
        autoConnect: item.autoConnect !== false,
        createdAt: int(item.createdAt, Date.now()),
      })
    }
    const known = new Set(connections.map((c) => c.id))
    for (const item of Array.isArray(raw.forwards) ? raw.forwards : []) {
      if (!item || typeof item !== 'object' || str(item.id) === '' || !known.has(str(item.connectionId))) continue
      // 1.1.0 kept a listener for an embedded remote page; remote mode replaced it.
      if (item.kind === 'gui') continue
      forwards.push({
        id: str(item.id),
        connectionId: str(item.connectionId),
        name: str(item.name),
        remoteHost: str(item.remoteHost, '127.0.0.1') || '127.0.0.1',
        remotePort: int(item.remotePort, 0),
        localHost: str(item.localHost, '127.0.0.1') || '127.0.0.1',
        localPort: int(item.localPort, 0),
        autoPort: item.autoPort === true,
        autoStart: item.autoStart !== false,
      })
    }
  }
  const share = raw && typeof raw === 'object' && raw.share && typeof raw.share === 'object' ? raw.share : {}
  return {
    connections,
    forwards: forwards.filter((f) => f.remotePort >= 1 && f.remotePort <= 65535),
    share: {
      enabled: share.enabled === true,
      host: str(share.host, '0.0.0.0') || '0.0.0.0',
      port: Number.isInteger(share.port) && share.port >= 0 && share.port <= 65535 ? share.port : 0,
      advertise: str(share.advertise),
      token: str(share.token),
      secret: str(share.secret),
      gui: share.gui === true,
    },
  }
}

export class Store {
  /** @param {string} path absolute file path */
  constructor(path) {
    this.path = resolve(path)
    this.timer = undefined
    this.pending = undefined
  }

  load() {
    try {
      if (!existsSync(this.path)) return sanitize(undefined)
      return sanitize(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      // A corrupt file must not take the plugin down; keep it aside and start empty.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return { ...sanitize(undefined), loadError: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Coalesce bursts of changes into one write. `snapshot` is called at write time. */
  schedule(snapshot) {
    this.pending = snapshot
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 150)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const snapshot = this.pending
    this.pending = undefined
    if (!snapshot) return
    const data = { version: VERSION, ...snapshot() }
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = join(dir, `.${basename(this.path)}.${process.pid}.tmp`)
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      /* not supported on every platform */
    }
    renameSync(temp, this.path)
  }
}
