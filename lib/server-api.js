/**
 * What the server role answers, independent of which listener carries it: DSH's own web server
 * (behind DSH's authentication) or the dedicated share listener (behind the share token).
 */
import os from 'node:os'
import { listListeningPorts } from './ports.js'
import { PLUGIN_ID, PROTOCOL } from './remote.js'
import { hostAllowed, parsePortRules, portAllowed } from './tunnel.js'

function machine() {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    /* no passwd entry (containers) */
  }
  return { hostname: os.hostname(), platform: process.platform, arch: process.arch, user, node: process.version }
}

/**
 * @param {{
 *   settings: () => any,
 *   version: string,
 *   dshVersion?: string,
 *   tunnelCount: () => number,
 *   web: () => ({ protocol: string, host: string, port: number | null }) | null,
 * }} deps `dshVersion` is the hosting DSH release: the other computer compares it with its own before switching its window onto this one.
 */
export function createServerApi({ settings, version, dshVersion, tunnelCount, web }) {
  return {
    /**
     * `via` tells the client which listener answered: `dsh` (DSH's web server) or `share`.
     * `gui` says whether this door currently serves the DSH web page over a tunnel (remote sessions).
     */
    async info({ via = 'dsh', gui = false } = {}) {
      const cfg = settings()
      return {
        plugin: PLUGIN_ID,
        protocol: PROTOCOL,
        version,
        dsh: { version: dshVersion ?? null },
        via,
        ...machine(),
        // The share listener carries a forwarding-only credential: it must not advertise (or lead to) the DSH web login.
        web: via === 'dsh' ? web() : null,
        gui: { enabled: gui === true },
        server: {
          enabled: cfg.serverEnabled,
          allowedHosts: cfg.allowedHosts,
          allowedPorts: cfg.allowedPorts,
          maxTunnels: cfg.maxTunnels,
          tunnels: tunnelCount(),
        },
      }
    },

    async ports() {
      const cfg = settings()
      if (!cfg.serverEnabled) return { ports: [], error: 'Port forwarding is disabled on this machine (serverEnabled: false).' }
      const rules = parsePortRules(cfg.allowedPorts)
      const listing = await listListeningPorts()
      return {
        ports: listing.ports.map((p) => ({ ...p, allowed: hostAllowed(p.host, cfg.allowedHosts) && portAllowed(p.port, rules) })),
        ...(listing.error ? { error: listing.error } : {}),
      }
    },
  }
}
