/**
 * Network addresses of this machine that another computer might use to reach it.
 */
import os from 'node:os'

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const LINK_LOCAL = /^169\.254\./

export function isWildcard(host) {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/** `192.168.1.20` -> itself, `::1` -> `[::1]`, a name -> itself. */
export function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Candidate addresses, best first: private LAN, then VPN (Tailscale-style CGNAT), then public IPv4,
 * then this machine's name. Loopback and link-local addresses are never offered.
 * @returns {Array<{host: string, kind: 'lan'|'vpn'|'public'|'name', iface?: string}>}
 */
export function listAddresses() {
  const rows = []
  for (const [iface, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (entry.internal || LINK_LOCAL.test(entry.address)) continue
      const kind = PRIVATE.some((re) => re.test(entry.address)) ? 'lan' : CGNAT.test(entry.address) ? 'vpn' : 'public'
      rows.push({ host: entry.address, kind, iface })
    }
  }
  const rank = { lan: 0, vpn: 1, public: 2, name: 3 }
  rows.sort((a, b) => rank[a.kind] - rank[b.kind])
  const name = os.hostname()
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name) && name.includes('.')) rows.push({ host: name, kind: 'name' })
  return rows
}
