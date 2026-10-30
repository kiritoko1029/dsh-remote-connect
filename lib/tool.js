/**
 * The `remote_connect` agent tool.
 *
 * It exposes the same operations as the Web UI (they run through the same manager) but only on
 * connections the user already saved: access tokens are typed into the UI and never pass through
 * the model or the session log. Connecting and opening forwards ask the user first.
 */

export const TOOL_NAME = 'remote_connect'

const ACTIONS = ['list', 'connect', 'disconnect', 'forward', 'unforward', 'ports']

function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}

function describeConnection(c) {
  const where = c.info ? ` — ${c.info.hostname} (${c.info.platform}/${c.info.arch})` : ''
  const problem = c.error ? ` — ${c.error.message}` : ''
  return `${c.name} [${c.id}] ${c.url}: ${c.status}${where}${problem}`
}

function describeForward(f) {
  const local = f.boundPort ? f.url : `${f.localHost}:${f.localPort || 'auto'}`
  const traffic = f.total > 0 ? `, ${f.total} connections, in ${bytes(f.bytesIn)} / out ${bytes(f.bytesOut)}` : ''
  const problem = f.error ? ` — ${f.error.message}` : f.lastError ? ` — last tunnel error: ${f.lastError.message}` : ''
  return `  forward [${f.id}] remote ${f.remoteHost}:${f.remotePort} -> ${local}: ${f.status}${traffic}${problem}`
}

/** One line about "Share this computer". Never includes the address or token: those are for the user to copy. */
function describeShare(share) {
  if (!share) return ''
  if (!share.allowed) return 'Sharing this computer: disabled by configuration.'
  if (!share.enabled) return 'Sharing this computer: off (the user turns it on in the Remote Connect panel).'
  if (share.status === 'listening') return `Sharing this computer: on, listening on ${share.host}:${share.boundPort}, ${share.tunnels} open tunnels.`
  return `Sharing this computer: on but ${share.status}${share.error ? ` — ${share.error.message}` : ''}.`
}

/** Which DSH the user's window is on. Worth knowing: file paths and commands then refer to the other computer. */
function describeMode(mode) {
  if (!mode || !mode.active) return ''
  return `The user's DSH window is switched onto the remote DSH "${mode.name}"${mode.connected ? '' : ' (connection down)'}: the sessions, workspaces and agent they see live on that computer.`
}

export function renderState(state) {
  const shareLine = [describeMode(state.mode), describeShare(state.share)].filter(Boolean).join('\n')
  if (state.connections.length === 0) {
    return `No saved connections. The user adds one in the Remote Connect panel (URL + token).${shareLine ? `\n${shareLine}` : ''}`
  }
  const lines = shareLine ? [shareLine] : []
  for (const c of state.connections) {
    lines.push(describeConnection(c))
    for (const f of state.forwards.filter((x) => x.connectionId === c.id)) lines.push(describeForward(f))
  }
  return lines.join('\n')
}

/**
 * @param {import('./manager.js').RemoteConnectManager} manager
 */
export function createTool(manager) {
  const result = (text) => ({ ok: true, text })

  return {
    name: TOOL_NAME,
    description:
      'Use saved connections to remote DSH instances and forward ports of those machines to this one. ' +
      'The user saves a connection (URL + token) in the Remote Connect panel; this tool never sees or sets tokens. ' +
      'Actions: list (connections, forwards, status); connect / disconnect a saved connection; ' +
      'forward (listen on a local port, 127.0.0.1 only, and tunnel it to a port on the remote machine); ' +
      'unforward; ports (list TCP ports the remote machine is listening on). ' +
      '`connection` is a saved connection id or name.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'What to do.' },
        connection: { type: 'string', description: 'Saved connection id or name (all actions except list; unforward may use forward instead).' },
        remote_port: { type: 'integer', description: 'forward: TCP port on the remote machine.' },
        remote_host: { type: 'string', description: 'forward: host as seen from the remote machine. Default 127.0.0.1.' },
        local_port: { type: 'integer', description: 'forward: local port. Default = remote_port; 0 picks a free port.' },
        forward: { type: 'string', description: 'unforward: forward id from list.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string', description: 'Human-readable result.' },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      switch (args.action) {
        case 'list':
          return result(renderState(manager.state()))
        case 'connect': {
          const c = manager.resolveConn(args.connection)
          const { connection } = await manager.connect(c.rec.id)
          return result(describeConnection(connection))
        }
        case 'disconnect': {
          const c = manager.resolveConn(args.connection)
          await manager.disconnect(c.rec.id)
          return result(`Disconnected ${c.rec.name}; its forwards are stopped.`)
        }
        case 'forward': {
          const c = manager.resolveConn(args.connection)
          if (!Number.isInteger(args.remote_port)) throw new Error('remote_port is required for forward')
          const { forward } = await manager.addForward({
            connectionId: c.rec.id,
            remotePort: args.remote_port,
            remoteHost: args.remote_host,
            localPort: args.local_port,
            localHost: '127.0.0.1',
          })
          if (forward.status !== 'listening') throw new Error(forward.error?.message ?? 'The forward could not start')
          return result(`${describeForward(forward).trim()}\nOpen ${forward.url} on this machine to reach ${forward.remoteHost}:${forward.remotePort} on ${c.rec.name}.`)
        }
        case 'unforward': {
          let id = typeof args.forward === 'string' ? args.forward.trim() : ''
          if (id === '') {
            const c = manager.resolveConn(args.connection)
            const match = manager.state().forwards.filter((f) => f.connectionId === c.rec.id && (args.remote_port === undefined || f.remotePort === args.remote_port))
            if (match.length !== 1) throw new Error(match.length === 0 ? 'No matching forward' : 'Several forwards match; pass forward (id) or remote_port')
            id = match[0].id
          }
          await manager.removeForward({ id })
          return result(`Removed forward ${id}.`)
        }
        case 'ports': {
          const c = manager.resolveConn(args.connection)
          const listing = await manager.listRemotePorts(c.rec.id)
          const ports = Array.isArray(listing.ports) ? listing.ports : []
          if (ports.length === 0) return result(listing.error ? `No ports listed: ${listing.error}` : 'The remote machine reports no listening TCP ports.')
          const rows = ports.map((p) => `${p.port}\t${p.host}\t${p.process ?? ''}${p.allowed === false ? '\t(not allowed by the remote)' : ''}`)
          return result(`Listening on ${c.rec.name}:\nport\thost\tprocess\n${rows.join('\n')}`)
        }
        default:
          throw new Error(`Unknown action ${String(args.action)}; use one of ${ACTIONS.join(', ')}`)
      }
    },
  }
}
