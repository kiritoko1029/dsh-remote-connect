/**
 * Plugin Config: the serialized schema Settings uses to describe the fields, and the normalizer
 * the plugin reads them through.
 *
 * The schema is the `toJSON()` of a schemastery object generated once (see README, "Config"); the
 * plugin carries it inline because a profile-installed bundle cannot import DSH's own packages.
 * Validation never throws: every field is normalized by {@link resolveSettings}, and an unreadable
 * value falls back to its default instead of failing the plugin at boot.
 */

export const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1']

const SCHEMA = {
  uid: 37,
  refs: {
    2: {
      type: 'boolean',
      meta: {
        default: true,
        description:
          "Let authenticated remote DSH clients forward this machine's ports through the /remote-connect/tunnel route. Turn off on machines that should only act as a client.",
      },
    },
    5: { type: 'string', meta: { required: true } },
    7: {
      type: 'array',
      meta: {
        default: DEFAULT_ALLOWED_HOSTS,
        description: 'Target hosts a remote client may reach through this machine\'s tunnel. "*" allows any host this machine can reach.',
      },
      inner: 5,
    },
    10: { type: 'string', meta: { required: true } },
    12: {
      type: 'array',
      meta: {
        default: [],
        description: 'Target ports a remote client may reach: single ports ("5173") or ranges ("3000-3999"). Empty allows every port.',
      },
      inner: 10,
    },
    17: { type: 'number', meta: { min: 1, max: 4096, default: 128, description: 'Maximum concurrent tunnels this machine serves.' } },
    20: {
      type: 'string',
      meta: {
        default: '',
        description: 'JSON file that stores saved connections and forwards (it holds access tokens, mode 0600). Empty uses $DSH_HOME/remote-connect/state.json.',
      },
    },
    23: {
      type: 'boolean',
      meta: { default: true, description: 'On startup, reconnect saved connections marked auto-connect and re-open forwards marked auto-start.' },
    },
    28: { type: 'number', meta: { min: 1000, max: 120000, default: 10000, description: 'Timeout for reaching a remote DSH or its forwarded target (ms).' } },
    33: { type: 'number', meta: { min: 5, max: 300, default: 25, description: 'Interval of tunnel and connection health checks (seconds).' } },
    36: {
      type: 'boolean',
      meta: { default: true, description: 'Register the remote_connect agent tool (operates on saved connections only; tokens are never exposed to the model).' },
    },
    39: {
      type: 'boolean',
      meta: {
        default: true,
        description:
          'Offer "Share this computer" in the panel: a dedicated listener with its own forwarding-only token, for machines (such as the DSH desktop app) whose own web server is reachable from this machine only. Off until the user switches it on.',
      },
    },
    41: {
      type: 'boolean',
      meta: {
        default: true,
        description:
          "Allow another computer to open this computer's DSH (all sessions, with the agent able to run commands) through Remote Connect. Over the share listener it additionally needs the user's own switch in the panel; over DSH's own port it is implied by the owner login. Turn off to forbid it completely.",
      },
    },
    43: {
      type: 'boolean',
      meta: {
        default: false,
        description:
          "Allow switching this computer's DSH window onto another computer whose DSH release differs from this one's (or cannot be determined). The window reuses this computer's UI against the other computer's API, so a different release can misbehave or corrupt data: leave off unless you know what you are doing.",
      },
    },
    37: {
      type: 'object',
      meta: { default: {} },
      dict: {
        serverEnabled: 2,
        allowedHosts: 7,
        allowedPorts: 12,
        maxTunnels: 17,
        dataFile: 20,
        restore: 23,
        connectTimeoutMs: 28,
        keepAliveSeconds: 33,
        agentTool: 36,
        shareAllowed: 39,
        remoteControlAllowed: 41,
        allowVersionMismatch: 43,
      },
    },
  },
}

/** The same rows as plain nodes, which is the shape the settings form projects values through. */
function inlineNode(uid, refs) {
  const ref = refs[uid]
  const node = { ...ref }
  if (ref.dict) node.dict = Object.fromEntries(Object.entries(ref.dict).map(([key, value]) => [key, inlineNode(value, refs)]))
  if (ref.inner !== undefined) node.inner = inlineNode(ref.inner, refs)
  if (ref.list) node.list = ref.list.map((value) => inlineNode(value, refs))
  return node
}

/** Exported as the row's Config so Settings can describe the fields. */
export const Config = {
  ...SCHEMA,
  type: 'object',
  dict: inlineNode(SCHEMA.uid, SCHEMA.refs).dict,
  meta: { default: {} },
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-remote-connect',
    validate(value) {
      return { value: value !== null && typeof value === 'object' ? value : {} }
    },
  },
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function number(value, fallback, low, high) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback
}

function strings(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
}

/** Fully-defaulted settings from whatever the row's `config` held. */
export function resolveSettings(config) {
  const c = config !== null && typeof config === 'object' ? config : {}
  return {
    serverEnabled: bool(c.serverEnabled, true),
    allowedHosts: strings(c.allowedHosts, DEFAULT_ALLOWED_HOSTS),
    allowedPorts: strings(c.allowedPorts, []),
    maxTunnels: Math.floor(number(c.maxTunnels, 128, 1, 4096)),
    dataFile: typeof c.dataFile === 'string' ? c.dataFile.trim() : '',
    restore: bool(c.restore, true),
    connectTimeoutMs: Math.floor(number(c.connectTimeoutMs, 10000, 1000, 120000)),
    keepAliveSeconds: Math.floor(number(c.keepAliveSeconds, 25, 5, 300)),
    agentTool: bool(c.agentTool, true),
    shareAllowed: bool(c.shareAllowed, true),
    remoteControlAllowed: bool(c.remoteControlAllowed, true),
    allowVersionMismatch: bool(c.allowVersionMismatch, false),
  }
}
