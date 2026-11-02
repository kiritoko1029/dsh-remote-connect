# dsh-remote-connect · 远程连接

Switch this computer's DSH between **this computer** and **another computer's DSH**, and forward that computer's ports to this one. It works with the DSH desktop app and with `dsh --profile web`.

在本机 DSH 里一键**切换使用本机或另一台电脑上的 DSH**（切换后会话、工作区、文件、agent 都是对方的），并把对方的端口转发到本机。支持 DSH 客户端，也支持命令行 Web 版。

```
 this computer                                          other computer
 ┌────────────────────────────────┐                    ┌───────────────────────────────────┐
 │ DSH window  (this UI)          │                    │ DSH desktop app / dsh web         │
 │  [⇄] switch ─ local │ remote   │                    │                                   │
 │   /api + /api/remote.mux ──────┼── tunnel (?gui=1) ►│ gui bridge ─► its own DSH /api    │
 │  Remote Connect panel          │                    │                                   │
 │   127.0.0.1:5173 ──────────────┼── tunnel (port) ──►│ share listener ─► 127.0.0.1:5173  │
 └────────────────────────────────┘   token → cookie   └───────────────────────────────────┘
```

## Quick start · 快速使用

**Install the same plugin on both computers, and the same DSH release on both**, restart both, then:

### Other computer runs the DSH desktop app · 对方用 DSH 客户端

The desktop app's own web server listens on `127.0.0.1` only, on a random port, and its URL/token are handed to its window over IPC: there is nothing to copy and nothing a second computer could reach. **Share this computer** fixes that.

1. On the *other* computer: **Remote Connect → Share this computer → Turn on sharing**.
2. Tick **Allow remote control of this computer's DSH** (read the warning, see Security).
3. Click **Copy connection address**.
4. On *this* computer: **Add connection**, paste, **Save and connect**.
5. Click the **⇄ switch button** at the foot of the sidebar and pick the remote DSH (or press **Switch to this DSH** on the connection card).

The window reloads and is now that computer's DSH: its sessions, workspaces, files and agent. A banner at the top says which computer you are on and has **Switch back to this computer's DSH**. The same ⇄ menu switches back.

The port is remembered and the token stored, so the address stays valid after restarts. In the sharing card pick which of its IPs to hand out (LAN, VPN such as Tailscale, …). **Reset token** revokes every address handed out so far.

Without "Allow remote control" the same connection still forwards ports, but cannot be switched to.

### Other computer runs `dsh --profile web` · 对方用命令行 Web 版

```sh
dsh --profile web --no-open --host 192.168.1.20      # bind one concrete LAN IP (wildcards are rejected by DSH)
# or keep it on loopback and reach it through a trusted name / proxy:
dsh --profile web --no-open --trusted-host dsh.example.com
```

It prints `http://192.168.1.20:3080/?token=…`; paste that into **Add connection**. This door carries DSH's owner login, so switching needs no extra switch there.

### Ports · 端口转发

- **Add forward**: remote `127.0.0.1:5173` → local `5173` (blank local port = same as remote, `0` = free port).
- **Detect remote ports**: lists what the other computer is listening on, one click to forward.
- Forwards bind `127.0.0.1`. Sharing one on your LAN (`0.0.0.0`) needs an explicit checkbox.
- **Disconnect** stops the connection's forwards and switches back if you were on it.

## Same release on both computers · 版本

The window keeps **this computer's UI** and only changes where its data comes from, so both computers must run the **same DSH release**. Each side reports its release (`@deepseek-ai/dsh`, read from the installation the Host was started from) and the connection card shows both:

```
DSH release: this computer 0.2.1-rc.5 · that computer 0.2.1-rc.5 · same release
```

If they differ (or one cannot be determined), switching is refused with both versions in the message. `allowVersionMismatch: true` skips the check at your own risk; a different release can misbehave or corrupt data. An older Remote Connect that reports no release is treated as "too old: update the plugin there".

## How switching works · 切换原理

Every request the UI sends to its Host's `/api` (RPC, uploads, attachments) and the `/api/remote.mux` WebSocket (live events and streams) is relayed to the other computer's Host instead of being answered locally:

- HTTP: DSH's official `connection/request` hook (runs after this window's own sign-in, before the body is read).
- WebSocket: the event stream is claimed by DSH's gateway with no hook, so the plugin stands in front of the HTTP server's `upgrade` listeners and relays only that one path. Everything else reaches the original listeners untouched. If the server cannot be reached, switching is reported as unavailable instead of failing half way.
- Everything outside `/api` (the page, plugin bundles, this plugin's own `/remote-connect/*` routes, the desktop shell) stays local, which is why switching back always works.

The relay rides a `?gui=1` tunnel that ends in the other computer's **gui bridge** (`lib/gui-bridge.js`). It does what the desktop app does between its window and its Host: it logs in to its own DSH once with its launch token, then serves each request with the session cookie attached and `Host` / `Origin` rewritten to the DSH listener's own loopback authority. It has no listening socket: each tunnel is wrapped in a Duplex and handed to an in-process `http.Server`. The other DSH's login token never leaves that computer. Requests that already crossed a bridge carry `x-remote-connect-hop` and are never relayed again, so chains and loops cannot form.

Switching is not persistent: restarting this DSH starts on this computer. Changing the data source reloads the window (everything on screen came from the other source).

## Opening remote files with local programs · 用本机程序打开远程文件

While the window uses another computer's DSH, the file controls ("Open", "Open with", "Show file location" in the document preview) would ask the *remote* Host to open the path on *its* desktop. Remote Connect answers those three calls (`session/canOpenWorkspacePath`, `session/workspacePathApplications`, `session/openWorkspacePath`) on this computer instead (`lib/remote-open.js`):

1. The program list is this computer's own for that file type (asked about an empty probe file of the same extension).
2. Opening copies the file to a private temporary folder (`<tmp>/dsh-remote-open-<uid>/<id>/<original name>`, mode `0700`/`0600`) and has this computer's DSH open **the copy** with the program you picked, or the default one for the type.
3. When you save, the copy is sent back (`PUT /remote-connect/file`, `If-Match` with the etag of the version you opened). Editors that save by replacing the file are handled. If the file changed on the other computer meanwhile, nothing is overwritten; the edited copy is kept and listed in `pendingFiles` of the panel state.
4. A copy that is in sync, not held open by any program (`lsof`, macOS/Linux) and untouched for `openCleanupMinutes` is deleted. When this DSH quits it sends unsent edits, then deletes every synced copy. Copies that are not on the other computer yet are never deleted. Leftovers of a crash older than a day are purged at the next copy.

Needs this plugin (same version) on the other computer, with `remoteControlAllowed` on. Limits: regular files up to `fileMaxMB`; folders are refused. Only the file controls that use the session calls above are covered: the Session-header "Open In…" folder button and the delivery cards use separate routes and still act on this computer.

## Agent tool

`remote_connect` works on **saved** connections only: `list`, `connect`, `disconnect`, `forward`, `unforward`, `ports`. Tokens are typed into the panel and never pass through the model or the session log; `list` reports whether sharing is on and which DSH the window is on, but never an address. `connect` and `forward` ask for approval; `forward` only listens on `127.0.0.1`. Turning sharing, remote control or switching on or off is user-only.

## Configuration

Edit the `remote-connect` row's `config` in `cordis.patch.yml` (or the profile's patch layer). All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `serverEnabled` | `true` | Let remote clients tunnel to this machine (both doors). Turn off on pure clients. |
| `shareAllowed` | `true` | Offer **Share this computer**. It stays off until the user switches it on. |
| `remoteControlAllowed` | `true` | Allow another computer to switch onto this computer's DSH (needs the user's own switch on the share door). `false` forbids it completely. |
| `allowVersionMismatch` | `false` | Allow switching onto a different DSH release (unsafe). |
| `allowedHosts` | `[127.0.0.1, localhost, '::1']` | Target hosts a remote client may reach from this machine. `'*'` = any. |
| `allowedPorts` | `[]` | `"5173"` or `"3000-3999"` entries; empty = any port. |
| `maxTunnels` | `128` | Concurrent tunnels served per door. |
| `dataFile` | `$DSH_HOME/remote-connect/state[-profile].json` | Saved connections, forwards and sharing settings (holds tokens, mode `0600`). |
| `restore` | `true` | At startup reconnect connections, restart forwards and re-open sharing that were on. |
| `connectTimeoutMs` | `10000` | Timeout reaching a remote or its target. |
| `keepAliveSeconds` | `25` | Health-check and tunnel ping interval. |
| `agentTool` | `true` | Register `remote_connect`. |
| `openRemoteFiles` | `true` | Open the other computer's files with this computer's programs while switched onto it. |
| `fileMaxMB` | `512` | Largest file copied either way for opening or saving. |
| `openCleanupMinutes` | `60` | Minutes without changes after which a synced temporary copy is deleted. |

## Security model

- **Remote control is full control.** Whoever may switch onto a DSH uses it as its owner: every session, and its agent can run commands as that user. So over the share door it is a separate switch, **off by default**, with a warning, and it is forgotten when sharing is switched off. Turning it off (or **Reset token**) cuts the live connection immediately. `remoteControlAllowed: false` removes the capability altogether. Only enable it for computers you own.
- **Two doors, two credentials.** DSH's own port is guarded by DSH's owner login (launch token → signed cookie, Host/Origin fence). The share listener is guarded by its own 256-bit token that, by itself, only grants port forwarding.
- **Share listener hardening.** Off by default and opt-in per computer. Browsers are refused outright (any `Origin` / `Sec-Fetch-*` header), failed token exchanges are rate-limited per address (10 / minute), the token is compared in constant time, the cookie is HMAC-signed with a secret that **Reset token** rotates (which also drops every open tunnel).
- The relay only accepts requests this window's DSH has already authenticated; the live-event WebSocket is checked the same way before it is relayed.
- A port tunnel can reach whatever the server machine can reach, so the server restricts targets with `allowedHosts` / `allowedPorts` (loopback only by default).
- Tokens and cookies stay in the Host process and the `0600` state file. The API never returns them, except the share address on an explicit **Copy** / **Show token** click. They are never logged or shown to the model.
- **Plain HTTP.** Both doors speak HTTP unless DSH itself is served over TLS. On a LAN you trust that is fine; otherwise use a VPN (Tailscale, WireGuard) or an SSH hop. Binding `0.0.0.0` exposes the share port on every interface of that machine. Remote control over plain HTTP means anyone who can read the traffic can drive that DSH.

## Wire protocol (v1)

Both doors expose the same API; the client code path is identical.

1. `GET /?token=<token>` → `303` + `Set-Cookie: dsh-auth-…` (the exchange a browser does with DSH; the share door mints its own signed cookie; `/connect` is the fallback on DSH's door).
2. `GET /remote-connect/info` (cookie) → `{plugin, protocol, version, dsh: {version}, via: 'dsh'|'share', hostname, platform, arch, web, gui: {enabled}, server: {…}}`. `web` is `null` on the share door; `gui.enabled` says whether a window can be switched onto this computer now.
3. `GET /remote-connect/ports` → listening TCP ports with an `allowed` flag.
4. `GET /remote-connect/tunnel?host=&port=` with `Upgrade: websocket`: a TCP tunnel. The server connects first and answers `101` only on success, otherwise a plain `403`/`502` whose body says why. `GET /remote-connect/tunnel?gui=1` is a window tunnel: no TCP target, the bytes are HTTP spoken to the server's own DSH. Binary frames carry the byte stream; a text frame `eof` is a half-close; ping/pong keeps proxies and dead-peer detection honest.

The WebSocket codec is in `lib/ws.js` (no dependencies: a profile-installed bundle cannot import DSH's packages). WebSocket rather than a bare `Upgrade` token so that nginx / Caddy / Cloudflare-style proxies in front of a remote DSH pass it through.

## Files

| File | Role |
|---|---|
| `index.js` | Host entry: routes on DSH's port, tunnel upgrade, `connection/request` hook, upgrade interceptor, agent tool |
| `lib/manager.js` | Saved connections, health loop, forward listeners, sharing, switching and version check; the one operation set shared by UI and tool |
| `lib/remote-mode.js` | Relays `/api` (HTTP) and `/api/remote.mux` (WebSocket) to the other computer while switched |
| `lib/gui-bridge.js` | Serves this computer's own DSH to a window tunnel: login, cookie injection, Host/Origin rewrite, WebSocket, hop mark |
| `lib/dsh-version.js` | Finds the installed DSH release |
| `lib/share.js` | "Share this computer": dedicated listener, remembered port, own token / cookie, remote-control switch, hardening |
| `lib/ws-duplex.js` | A Node Duplex over a tunnel (HTTP server / agent socket) |
| `lib/remote.js` | Client wire protocol: URL normalization, token→cookie, probe, open tunnel |
| `lib/tunnel.js` | Server-side tunnel handler and the TCP⇄WebSocket bridge (back-pressure, half-close) |
| `lib/server-api.js` | `info` / `ports` answers, shared by both doors |
| `lib/netinfo.js` | Addresses of this machine worth handing out (LAN, VPN, name) |
| `lib/ws.js` | Minimal RFC 6455 peer |
| `lib/ports.js` | Listening-port discovery (`ss` / `lsof` / `netstat`) |
| `lib/store.js` | Atomic `0600` JSON persistence |
| `lib/config.js` | Config schema (serialized) and normalizer |
| `client.js` | Sidebar switch button, banner and panel (React, host theme tokens, en/zh) |

### DSH desktop app compatibility

The panel and the switch talk to the Host through relative `fetch('remote-connect/api/…')`. The desktop app serves its window from a private `dsh-app://app/` origin and forwards every request that is not a static asset to its Host with the session cookie attached, so they work there unchanged; the event WebSocket gets the same cookie from the shell, which is what the relay's sign-in check sees.

## Tests

```sh
npm test        # node --test test/*.test.mjs
```

- `e2e.test.mjs`: the plugin's real `apply` behind a fake DSH web server: token rejection, a 6 MiB integrity round-trip, half-close, 30 concurrent connections, stale-cookie re-authentication, target allow-lists, port conflicts, restore after restart, secret non-leakage.
- `share.test.mjs`: the share door: connecting with the copied address, remembered port and token, port fallback, browser refusal, rate limiting, token reset, allow-lists, configuration off-switch, a missing token.
- `mode.test.mjs`: switching against a fake DSH with the real trust fence: only `/api` moves, Host/Origin rewrite and cookie injection, `Set-Cookie` stripping, 1.5 MiB POST, streaming, redirects, the `/api/remote.mux` WebSocket (and refusing it unauthenticated), re-login after the DSH drops its cookie, off until allowed, immediate cut-off when the other side turns it off, version match / mismatch / unknown / too-old, switching back on disconnect or removal, the upgrade interceptor, and release detection.

## Config schema

`lib/config.js` embeds the serialized form of this schemastery definition so Settings can describe the fields:

```js
z.object({
  serverEnabled: z.boolean().default(true),
  allowedHosts: z.array(String).default(['127.0.0.1', 'localhost', '::1']),
  allowedPorts: z.array(String).default([]),
  maxTunnels: z.number().min(1).max(4096).default(128),
  dataFile: z.string().default(''),
  restore: z.boolean().default(true),
  connectTimeoutMs: z.number().min(1000).max(120000).default(10000),
  keepAliveSeconds: z.number().min(5).max(300).default(25),
  agentTool: z.boolean().default(true),
  shareAllowed: z.boolean().default(true),
  remoteControlAllowed: z.boolean().default(true),
  allowVersionMismatch: z.boolean().default(false),
})
```

## Limitations

- **Local-only desktop features act on this computer, not the remote one.** While switched, the UI is this computer's, so things that go through the desktop shell still use local files: the native "choose folder" dialog and dragging a file into the chat both produce paths on *this* computer, which mean nothing on the remote. Type remote paths by hand, or use a browse-style picker if your DSH offers one.
- The window shows only the remote DSH while switched. This computer's own sessions keep running (the agent keeps working) but are hidden until you switch back. Terminal and other local-process features that live in the desktop shell are this computer's.
- Verified against stand-ins that reproduce DSH's trust fence and cookie rules, not against two real DSH installations; try a harmless switch first (see "First try" below).
- TCP only (no UDP). A `dsh web` remote must serve DSH over HTTP(S) and have this plugin enabled; a desktop-app remote needs this plugin with sharing switched on.
- Remote-port discovery needs `ss`, `lsof` or `netstat` on the remote and only sees what the OS lets that user list.
- Connections with a missing or rejected credential stop retrying until you edit them; other failures retry with backoff up to 30 s.
- Changes to the Host half (`index.js`, `lib/`) need a DSH restart to load; the panel (`client.js`) reloads on a page refresh. Update the plugin on **both** computers.

## First try · 第一次试用

1. Connect, then open the ⇄ menu: it lists each connection with its DSH release and says why one cannot be picked.
2. Switch, check the banner, open a session list, send a trivial message.
3. Click **Switch back to this computer's DSH** in the banner. If the window ever shows something wrong, the same button (or restarting this DSH) returns to this computer.

## License · 许可证

MIT © 2026 chenxc

See [LICENSE](LICENSE) for the full text.
