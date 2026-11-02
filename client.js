/**
 * Client half of dsh-remote-connect: a "Remote Connect" panel in the sidebar.
 *
 * It lists saved connections to other computers' DSH (URL + token), shows their health, and
 * manages the port forwards that bring a remote machine's ports to this one. All state lives in the
 * Host half; this file only renders `GET remote-connect/api/state` and sends operations to
 * `POST remote-connect/api/call`. Tokens are typed here once and never come back from the Host.
 *
 * Styling uses only the host's `--dsw-alias-*` theme tokens, so light/dark follow the app.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-connect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useId } = React;

    const NS = 'dsh-remote-connect';
    const PANEL_ID = 'remote-connect';
    /** Document-relative, like the other Host routes the Web UI calls. */
    const API = 'remote-connect/api/';
    const POLL_MS = 2000;
    /** Poll rate while only the sidebar button and banner are on screen (the panel asks for POLL_MS). */
    const IDLE_POLL_MS = 6000;

    // ---------------------------------------------------------------------------------------
    // Text
    // ---------------------------------------------------------------------------------------

    const DICT = {
      en: {
        'panel': 'Remote Connect',
        'title': 'Remote Connect',
        'intro': "Connect to another computer's DSH with its URL and token, and bring that machine's ports to this one.",
        'addConnection': 'Add connection',
        'loadFailed': 'Cannot reach the plugin service. Retrying…',
        'loading': 'Loading…',
        'dismiss': 'Dismiss',
        'emptyTitle': 'No connections yet',
        'emptyBody': 'On the other computer, open Remote Connect, turn on "Share this computer" and click "Copy connection address", then add it here. That computer needs this plugin too. (A DSH started with `dsh --profile web --host <its IP>` also works: add the URL it prints.)',
        'status.idle': 'Not connected',
        'status.connecting': 'Connecting…',
        'status.connected': 'Connected',
        'status.error': 'Problem',
        'connect': 'Connect',
        'disconnect': 'Disconnect',
        'openDirect': 'Open in browser',
        'edit': 'Edit',
        'remove': 'Remove',
        'removeConfirm': 'Click again to remove',
        'cancel': 'Cancel',
        'save': 'Save',
        'saveConnect': 'Save and connect',
        'saving': 'Saving…',
        'latency': '{ms} ms',
        'tunnels': '{n} open tunnels',
        'serverOff': 'Port forwarding is turned off on that computer (serverEnabled: false).',
        'forwards': 'Port forwards',
        'noForwards': 'No port forwards yet. Add one, or detect the ports that computer is listening on.',
        'addForward': 'Add forward',
        'detectPorts': 'Detect remote ports',
        'hidePorts': 'Hide ports',
        'mode.menuTitle': 'DSH to use',
        'mode.local': "This computer's DSH",
        'mode.remote': 'Remote DSH',
        'mode.switchTo': 'Switch to this DSH',
        'mode.switchBack': "Switch back to this computer's DSH",
        'mode.switching': 'Switching…',
        'mode.using': 'In use now: this window shows this DSH',
        'mode.banner': 'Using the DSH on {name}',
        'mode.bannerDown': 'The connection to {name} is down',
        'mode.bannerNote': 'Sessions, workspaces, files and the agent are that computer\'s.',
        'mode.manage': 'Manage connections…',
        'mode.none': 'No saved connections yet.',
        'mode.versions': 'DSH release: this computer {local} · that computer {remote}',
        'mode.same': 'same release',
        'mode.different': 'The releases differ ({local} here, {remote} there). The window reuses this computer\'s UI against that computer\'s API, so install the same DSH release on both to switch.',
        'mode.unknown': 'One of the DSH releases could not be determined, so compatibility cannot be checked.',
        'mode.old': "That computer's Remote Connect is too old to be switched to. Update the plugin there.",
        'mode.unsupported': 'Switching is not available in this DSH: {reason}',
        'mode.notConnected': 'Connect first.',
        'mode.note': "After switching, this window shows that computer's DSH: its sessions, workspaces, files and agent. This computer's own sessions keep running but are hidden until you switch back.",
        'guiOffHint': 'To switch to it, turn on "Allow remote control" on that computer (Remote Connect > Share this computer).',
        'remoteHost': 'Remote host',
        'remotePort': 'Remote port',
        'localPort': 'Local port',
        'localPortHint': 'Blank: same as the remote port. 0: pick a free port.',
        'forwardName': 'Name (optional)',
        'lan': 'Let other devices on my network use this port',
        'lanWarn': 'Anyone who can reach this computer on that port gets the remote service, with no further sign-in.',
        'forward': 'Forward',
        'forwarding': 'Starting…',
        'start': 'Start',
        'stop': 'Stop',
        'openLocal': 'Open',
        'copy': 'Copy address',
        'copied': 'Copied',
        'removeForward': 'Remove',
        'fwd.stopped': 'Stopped',
        'fwd.starting': 'Starting…',
        'fwd.listening': 'Listening',
        'fwd.error': 'Failed',
        'conns': '{active} active · {total} total',
        'ports.title': 'Listening on that computer',
        'ports.loading': 'Looking up ports…',
        'ports.empty': 'No listening TCP ports reported.',
        'ports.port': 'Port',
        'ports.address': 'Address',
        'ports.process': 'Process',
        'ports.notAllowed': 'Blocked by that computer (allowedHosts / allowedPorts)',
        'ports.forwarded': 'Forwarded',
        'dialog.add': 'Add connection',
        'dialog.edit': 'Edit connection',
        'field.name': 'Name',
        'field.namePlaceholder': 'e.g. Office Mac',
        'field.url': 'DSH URL',
        'field.urlPlaceholder': 'http://192.168.1.20:3080  (pasting the full URL with ?token= works)',
        'field.token': 'Token',
        'field.tokenPlaceholder': 'The token from the URL that `dsh web` prints',
        'field.tokenKeep': 'Leave blank to keep the saved token',
        'field.insecure': 'Trust a self-signed or mismatched HTTPS certificate',
        'field.autoConnect': 'Reconnect automatically when DSH starts',
        'field.tokenNote': 'The token is stored on this computer only (owner-readable file) and is never shown again.',
        'err.unauthorized': 'The remote refused the token. If its DSH restarted, copy the new URL and edit this connection.',
        'err.no-token': 'No token saved. On the other computer open Remote Connect, turn on "Share this computer" and click "Copy connection address", then Edit this connection and paste it.',
        'err.refused': 'Connection refused. Is DSH running on that computer, and is the port reachable?',
        'err.dns': 'Host name not found.',
        'err.timeout': 'No answer in time.',
        'err.reset': 'The connection was reset.',
        'err.unreachable': 'That address is unreachable from this computer.',
        'err.tls': 'The HTTPS certificate is not trusted. Edit the connection and trust it if you know this server.',
        'err.no-plugin': 'Reached DSH, but it has no dsh-remote-connect plugin. Install and enable it on that computer to forward ports.',
        'err.port-in-use': 'That local port is already in use.',
        'err.port-denied': 'This computer does not allow listening on that port.',
        'err.bad-url': 'That is not a valid DSH URL.',
        'err.aborted': 'Cancelled.',
        'err.internal': 'Something went wrong in the plugin service.',
        'err.share-only': 'This is a sharing endpoint: it only forwards ports and does not serve the DSH web page.',
        'err.share-disabled': "Sharing is turned off by this plugin's configuration (shareAllowed / serverEnabled).",
        'err.no-address': 'No network address found on this computer. Connect to a network first.',
        'err.share-off': 'Sharing is not on.',
        'share.title': 'Share this computer',
        'share.intro': 'Let your other computers connect here and forward ports. This is how the DSH desktop app can be reached: its own web server is only open to this computer, on a random port, and shows no address.',
        'share.enable': 'Turn on sharing',
        'share.disable': 'Turn off sharing',
        'share.on': 'Sharing is on',
        'share.off': 'Sharing is off',
        'share.starting': 'Starting…',
        'share.copy': 'Copy connection address',
        'share.copied': 'Copied',
        'share.copyBlocked': 'Copying was blocked. Select the address below and copy it by hand.',
        'share.address': 'Connection address',
        'share.addressHint': 'On the other computer: Add connection, paste this. It contains the access token.',
        'share.show': 'Show token',
        'share.hide': 'Hide token',
        'share.via': 'Address to give out',
        'share.kind.lan': 'LAN',
        'share.kind.vpn': 'VPN',
        'share.kind.public': 'public',
        'share.kind.name': 'name',
        'share.kind.bound': 'listening address',
        'share.port': 'Port',
        'share.portHint': 'The port is remembered, so the address survives restarts. Blank or 0 picks a free one.',
        'share.apply': 'Apply',
        'share.rotate': 'Reset token',
        'share.rotateConfirm': 'Click again: old addresses stop working',
        'share.listening': 'Listening on {host}:{port}',
        'share.tunnels': '{n} open tunnels',
        'share.warn': 'Anyone on your network who has this address can reach ports on this computer. The connection is plain HTTP: use a trusted network or a VPN.',
        'share.scope': 'The token only allows port forwarding. It is not your DSH login.',
        'share.portChanged': 'The saved port was busy, so a new one was picked and the address changed. Copy it again.',
        'share.needsPlugin': 'The other computer also needs this plugin.',
        'share.gui': "Allow remote control of this computer's DSH",
        'share.guiHint': "With this on, your other computer can switch its DSH window onto this one: every session, settings, and the agent.",
        'share.guiWarn': 'Anyone with the connection address then controls this DSH completely, and its agent can run commands as you. Turn it on only for computers you own, and use Reset token to revoke.',
        'err.gui-off': 'Remote control is off on that computer. There, open Remote Connect > Share this computer and turn on "Allow remote control".',
        'err.remote-old': "That computer's Remote Connect is too old to be switched to. Update the plugin there.",
        'err.not-connected': 'The connection to that computer is not established.',
        'err.gui-disabled': "Remote control is forbidden by this plugin's configuration (remoteControlAllowed: false).",
      },
      zh: {
        'panel': '远程连接',
        'title': '远程连接',
        'intro': '用 URL 和 Token 连接另一台电脑上的 DSH，并把它的端口转发到本机。',
        'addConnection': '添加连接',
        'loadFailed': '无法连接插件服务，正在重试…',
        'loading': '加载中…',
        'dismiss': '关闭',
        'emptyTitle': '还没有连接',
        'emptyBody': '在另一台电脑上打开「远程连接」，开启「共享本机」并点「复制连接地址」，再到这里添加。对方也需要安装本插件。（用 `dsh --profile web --host <对方IP>` 启动的 DSH 也可以：添加它打印的 URL。）',
        'status.idle': '未连接',
        'status.connecting': '正在连接…',
        'status.connected': '已连接',
        'status.error': '异常',
        'connect': '连接',
        'disconnect': '断开',
        'openDirect': '在浏览器中打开',
        'edit': '编辑',
        'remove': '删除',
        'removeConfirm': '再点一次确认删除',
        'cancel': '取消',
        'save': '保存',
        'saveConnect': '保存并连接',
        'saving': '保存中…',
        'latency': '{ms} 毫秒',
        'tunnels': '{n} 条隧道',
        'serverOff': '对方电脑已关闭端口转发（serverEnabled: false）。',
        'forwards': '端口转发',
        'noForwards': '还没有端口转发。可以手动添加，或探测对方正在监听的端口。',
        'addForward': '添加转发',
        'detectPorts': '探测远程端口',
        'hidePorts': '收起端口',
        'mode.menuTitle': '使用哪个 DSH',
        'mode.local': '本机 DSH',
        'mode.remote': '远程 DSH',
        'mode.switchTo': '切换到此 DSH',
        'mode.switchBack': '切换回本机 DSH',
        'mode.switching': '切换中…',
        'mode.using': '当前正在使用：本窗口显示的是这台 DSH',
        'mode.banner': '正在使用 {name} 上的 DSH',
        'mode.bannerDown': '与 {name} 的连接已断开',
        'mode.bannerNote': '会话、工作区、文件和 agent 都是那台电脑的。',
        'mode.manage': '管理连接…',
        'mode.none': '还没有保存的连接。',
        'mode.versions': 'DSH 版本：本机 {local} · 对方 {remote}',
        'mode.same': '版本一致',
        'mode.different': '两边版本不同（本机 {local}，对方 {remote}）。本窗口会用本机的界面去访问对方的接口，所以必须两边安装同一版本的 DSH 才能切换。',
        'mode.unknown': '有一边的 DSH 版本无法确定，无法检查兼容性。',
        'mode.old': '对方的远程连接插件版本太旧，无法切换过去，请在对方更新插件。',
        'mode.unsupported': '当前 DSH 不支持切换：{reason}',
        'mode.notConnected': '请先连接。',
        'mode.note': '切换后，本窗口显示的就是对方电脑的 DSH：它的会话、工作区、文件和 agent。本机自己的会话照常运行，但在切回之前不可见。',
        'guiOffHint': '要切换过去，请在对方电脑的「远程连接 → 共享本机」里打开「允许远程控制」。',
        'remoteHost': '远程主机',
        'remotePort': '远程端口',
        'localPort': '本地端口',
        'localPortHint': '留空：与远程端口相同；0：自动选择空闲端口。',
        'forwardName': '名称（可选）',
        'lan': '允许本地网络里的其他设备使用该端口',
        'lanWarn': '任何能访问本机该端口的人都能直接使用远程服务，不再需要登录。',
        'forward': '转发',
        'forwarding': '启动中…',
        'start': '启动',
        'stop': '停止',
        'openLocal': '打开',
        'copy': '复制地址',
        'copied': '已复制',
        'removeForward': '删除',
        'fwd.stopped': '已停止',
        'fwd.starting': '启动中…',
        'fwd.listening': '监听中',
        'fwd.error': '失败',
        'conns': '{active} 个活动 · 共 {total} 个',
        'ports.title': '对方电脑正在监听',
        'ports.loading': '正在查询端口…',
        'ports.empty': '没有查到监听中的 TCP 端口。',
        'ports.port': '端口',
        'ports.address': '地址',
        'ports.process': '进程',
        'ports.notAllowed': '对方电脑不允许（allowedHosts / allowedPorts）',
        'ports.forwarded': '已转发',
        'dialog.add': '添加连接',
        'dialog.edit': '编辑连接',
        'field.name': '名称',
        'field.namePlaceholder': '例如：办公室 Mac',
        'field.url': 'DSH 地址',
        'field.urlPlaceholder': 'http://192.168.1.20:3080（直接粘贴带 ?token= 的完整 URL 也可以）',
        'field.token': 'Token',
        'field.tokenPlaceholder': '`dsh web` 打印的 URL 中的 token',
        'field.tokenKeep': '留空则保留已保存的 Token',
        'field.insecure': '信任自签名或域名不匹配的 HTTPS 证书',
        'field.autoConnect': 'DSH 启动时自动重连',
        'field.tokenNote': 'Token 只保存在本机（仅所有者可读的文件），之后不会再显示。',
        'err.unauthorized': '对方拒绝了该 Token。若对方 DSH 重启过，请复制新的 URL 并编辑此连接。',
        'err.no-token': '还没有保存 Token。请在对方电脑打开「远程连接」，开启「共享本机」并点「复制连接地址」，然后回到这里点「编辑」粘贴。',
        'err.refused': '连接被拒绝。对方的 DSH 是否在运行、端口是否可达？',
        'err.dns': '找不到主机名。',
        'err.timeout': '等待超时。',
        'err.reset': '连接被重置。',
        'err.unreachable': '本机无法到达该地址。',
        'err.tls': 'HTTPS 证书不受信任。若确认是你的服务器，请编辑连接并选择信任。',
        'err.no-plugin': '已连上 DSH，但对方没有 dsh-remote-connect 插件。请在对方安装并启用后再转发端口。',
        'err.port-in-use': '该本地端口已被占用。',
        'err.port-denied': '本机不允许监听该端口。',
        'err.bad-url': '不是有效的 DSH 地址。',
        'err.aborted': '已取消。',
        'err.internal': '插件服务出错。',
        'err.share-only': '这是共享端点：只支持端口转发，不提供 DSH 网页。',
        'err.share-disabled': '插件配置已禁用共享（shareAllowed / serverEnabled）。',
        'err.no-address': '本机没有找到可用的网络地址，请先连接网络。',
        'err.share-off': '共享未开启。',
        'share.title': '共享本机',
        'share.intro': '让你的其他电脑连接到这里并转发端口。DSH 客户端就是靠它被访问的：客户端自带的 Web 服务只对本机开放、端口随机，也不显示地址。',
        'share.enable': '开启共享',
        'share.disable': '关闭共享',
        'share.on': '共享已开启',
        'share.off': '共享未开启',
        'share.starting': '启动中…',
        'share.copy': '复制连接地址',
        'share.copied': '已复制',
        'share.copyBlocked': '复制被拦截了。请选中下面的地址手动复制。',
        'share.address': '连接地址',
        'share.addressHint': '在另一台电脑上点“添加连接”，把它粘贴进去。地址里含访问令牌。',
        'share.show': '显示令牌',
        'share.hide': '隐藏令牌',
        'share.via': '对外使用的地址',
        'share.kind.lan': '局域网',
        'share.kind.vpn': 'VPN',
        'share.kind.public': '公网',
        'share.kind.name': '主机名',
        'share.kind.bound': '监听地址',
        'share.port': '端口',
        'share.portHint': '端口会被记住，重启后地址不变。留空或 0：自动选一个空闲端口。',
        'share.apply': '应用',
        'share.rotate': '重置令牌',
        'share.rotateConfirm': '再点一次确认：旧地址将失效',
        'share.listening': '正在监听 {host}:{port}',
        'share.tunnels': '{n} 条隧道',
        'share.warn': '网络里拿到该地址的人都能访问本机的端口。连接是明文 HTTP，请只在可信网络或 VPN 中使用。',
        'share.scope': '这个令牌只允许端口转发，不是你的 DSH 登录凭证。',
        'share.portChanged': '原来保存的端口被占用，已换用新端口，地址有变化，请重新复制。',
        'share.needsPlugin': '另一台电脑也需要安装本插件。',
        'share.gui': '允许远程控制本机 DSH',
        'share.guiHint': '开启后，你的另一台电脑可以把它的 DSH 窗口切换到本机：所有会话、设置，以及 agent。',
        'share.guiWarn': '开启后，拿到连接地址的人将完整控制本机 DSH，它的 agent 能以你的身份执行命令。只对你自己的电脑开启，需要收回时点「重置令牌」。',
        'err.gui-off': '对方没有开启远程控制。请在对方电脑的「远程连接 → 共享本机」里打开「允许远程控制」。',
        'err.remote-old': '对方的远程连接插件版本太旧，无法切换过去，请在对方更新插件。',
        'err.not-connected': '与对方电脑的连接尚未建立。',
        'err.gui-disabled': '插件配置禁止远程控制（remoteControlAllowed: false）。',
      },
    };

    /** Codes whose raw message is already the most useful text (it names the target or the setting). */
    const FRIENDLY = new Set(['unauthorized', 'no-token', 'refused', 'dns', 'timeout', 'reset', 'unreachable', 'tls', 'no-plugin', 'port-in-use', 'port-denied', 'bad-url', 'aborted', 'internal', 'share-only', 'share-disabled', 'no-address', 'share-off', 'gui-off', 'remote-old', 'not-connected', 'gui-disabled']);

    function errText(t, error) {
      if (!error) return '';
      const code = error.code;
      if (code && FRIENDLY.has(code)) return t(`err.${code}`);
      return error.message || t('err.internal');
    }

    // ---------------------------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------------------------

    function apiError(error) {
      return Object.assign(new Error((error && error.message) || 'Request failed'), { code: (error && error.code) || 'internal' });
    }

    async function fetchState(signal) {
      const response = await fetch(`${API}state`, { headers: { accept: 'application/json' }, cache: 'no-store', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body.ok) throw apiError(body.error);
      return body.value;
    }

    async function callApi(method, params) {
      const response = await fetch(`${API}call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ method, params: params || {} }),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!body.ok) throw apiError(body.error);
      return body.value;
    }

    // ---------------------------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------------------------

    function fmtBytes(n) {
      if (!n) return '0 B';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    }

    /** Open a URL from an async handler without tripping popup blockers: open first, navigate after. */
    function openWindow(resolveUrl, onError) {
      const popup = window.open('', '_blank');
      Promise.resolve()
        .then(resolveUrl)
        .then((url) => {
          if (popup) {
            popup.opener = null;
            popup.location.href = url;
          } else {
            window.open(url, '_blank');
          }
        })
        .catch((error) => {
          if (popup) popup.close();
          onError(error);
        });
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        area.remove();
        return ok;
      }
    }

    // ---------------------------------------------------------------------------------------
    // Styles: theme tokens only
    // ---------------------------------------------------------------------------------------

    const CSS = `
.rc-page{box-sizing:border-box;height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.rc-page>*{width:100%;max-width:960px;box-sizing:border-box}
.rc-page *{box-sizing:border-box}
.rc-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px}
[data-platform=darwin] .rc-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.rc-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.rc-intro{margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
.rc-muted{color:var(--dsw-alias-label-secondary)}
.rc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.rc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap}
.rc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.rc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.rc-btn:disabled{opacity:.5;cursor:default}
.rc-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.rc-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.rc-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.rc-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.rc-btn.sm{height:24px;padding:0 9px;font-size:12px}
.rc-banner{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.rc-banner.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.rc-empty{display:flex;flex-direction:column;gap:6px;padding:28px 24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-secondary)}
.rc-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}
.rc-list{display:flex;flex-direction:column;gap:16px;margin:0;padding:0;list-style:none}
.rc-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.rc-cardhead{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.rc-ident{display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1 1 280px}
.rc-ident .rc-dot{margin-top:6px}
.rc-name{font-size:14px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-sub{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rc-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.rc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.rc-dot.connected,.rc-dot.listening{background:var(--dsw-alias-state-success-primary)}
.rc-dot.connecting,.rc-dot.starting{background:var(--dsw-alias-state-warn-primary);animation:rc-pulse 1.2s ease-in-out infinite}
.rc-dot.error{background:var(--dsw-alias-state-error-primary)}
@keyframes rc-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.rc-dot.connecting,.rc-dot.starting{animation:none}}
.rc-problem{color:var(--dsw-alias-state-error-primary)}
.rc-warn{color:var(--dsw-alias-state-warn-primary)}
.rc-sect{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.rc-secthead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.rc-secttitle{margin:0;font-size:13px;font-weight:500}
.rc-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.rc-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.rc-rowmain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 260px}
.rc-route{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.rc-route .rc-dot{margin-right:2px}
.rc-arrow{color:var(--dsw-alias-label-secondary)}
.rc-link{color:var(--dsw-alias-brand-primary);background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.rc-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.rc-form .wide{grid-column:1/-1}
.rc-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.rc-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.rc-input{width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.rc-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.rc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.rc-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.rc-check input{margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.rc-table{width:100%;border-collapse:collapse}
.rc-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 8px;font-size:12px}
.rc-table td{padding:5px 8px;border-top:1px solid var(--dsw-alias-border-l1)}
.rc-table td.num{font-variant-numeric:tabular-nums}
.rc-share{gap:12px}
.rc-using{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-brand-primary)}
.rc-versions{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.rc-ok{color:var(--dsw-alias-state-success-primary)}
.rc-addrrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rc-addr{flex:1 1 320px;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.rc-addr:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.rc-shareopts{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 16px}
.rc-shareopts .rc-field{flex:0 1 220px}
.rc-select{width:100%;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.rc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.rc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 65%,transparent)}
.rc-dialog{display:flex;flex-direction:column;gap:14px;width:100%;max-width:480px;max-height:100%;overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.rc-dialog h3{margin:0;font-size:16px;font-weight:500;line-height:24px}
.rc-dialogfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
`;

    // ---------------------------------------------------------------------------------------
    // Pieces
    // ---------------------------------------------------------------------------------------

    function Dot(props) {
      return h('span', { className: `rc-dot ${props.status}`, 'aria-hidden': true });
    }

    function Button(props) {
      const { kind, small, children, ...rest } = props;
      return h('button', { type: 'button', ...rest, className: `rc-btn${kind ? ` ${kind}` : ''}${small ? ' sm' : ''}` }, children);
    }

    function Field(props) {
      const id = useId();
      return h('div', { className: `rc-field${props.wide ? ' wide' : ''}` },
        h('label', { className: 'rc-label', htmlFor: id }, props.label),
        h('input', {
          id,
          className: 'rc-input',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          autoComplete: props.type === 'password' ? 'new-password' : 'off',
          spellCheck: false,
          autoFocus: props.autoFocus,
          inputMode: props.inputMode,
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'rc-label' }, props.hint) : null);
    }

    function Check(props) {
      return h('label', { className: `rc-check${props.wide ? ' wide' : ''}` },
        h('input', { type: 'checkbox', checked: props.checked, onChange: (event) => props.onChange(event.target.checked) }),
        h('span', null, props.label, props.note ? h('span', { className: 'rc-muted' }, ` ${props.note}`) : null));
    }

    // ---------------------------------------------------------------------------------------
    // Add / edit connection dialog
    // ---------------------------------------------------------------------------------------

    function ConnectionDialog(props) {
      const { t, existing, onClose, onDone } = props;
      const titleId = useId();
      const rootRef = useRef(null);
      const [name, setName] = useState(existing ? existing.name : '');
      const [url, setUrl] = useState(existing ? existing.url : '');
      const [token, setToken] = useState('');
      const [insecure, setInsecure] = useState(existing ? existing.insecure : false);
      const [autoConnect, setAutoConnect] = useState(existing ? existing.autoConnect : true);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);

      useEffect(() => {
        const previous = document.activeElement;
        return () => {
          if (previous && typeof previous.focus === 'function') previous.focus();
        };
      }, []);

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== 'Tab' || !rootRef.current) return;
        const nodes = rootRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled)');
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      const submit = async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          if (existing) {
            await callApi('updateConnection', { id: existing.id, name, url, token, insecure, autoConnect });
          } else {
            await callApi('addConnection', { name, url, token, insecure, autoConnect });
          }
          onDone();
        } catch (e) {
          setError(e);
          setSaving(false);
        }
      };

      return h('div', { className: 'rc-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('form', { ref: rootRef, className: 'rc-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, onSubmit: submit, onKeyDown },
          h('h3', { id: titleId }, existing ? t('dialog.edit') : t('dialog.add')),
          h(Field, { label: t('field.name'), value: name, onChange: setName, placeholder: t('field.namePlaceholder') }),
          h(Field, { label: t('field.url'), value: url, onChange: setUrl, placeholder: t('field.urlPlaceholder'), autoFocus: true, inputMode: 'url' }),
          h(Field, {
            label: t('field.token'),
            type: 'password',
            value: token,
            onChange: setToken,
            placeholder: existing && existing.hasToken ? t('field.tokenKeep') : t('field.tokenPlaceholder'),
            hint: t('field.tokenNote'),
          }),
          h(Check, { label: t('field.insecure'), checked: insecure, onChange: setInsecure }),
          h(Check, { label: t('field.autoConnect'), checked: autoConnect, onChange: setAutoConnect }),
          error ? h('div', { className: 'rc-problem', role: 'alert' }, errText(t, error)) : null,
          h('div', { className: 'rc-dialogfoot' },
            h(Button, { onClick: onClose, disabled: saving }, t('cancel')),
            h(Button, { kind: 'primary', type: 'submit', disabled: saving || url.trim() === '' }, saving ? t('saving') : existing ? t('save') : t('saveConnect')))));
    }

    // ---------------------------------------------------------------------------------------
    // Forwards
    // ---------------------------------------------------------------------------------------

    function ForwardForm(props) {
      const { t, onSubmit, onCancel, busy } = props;
      const [remoteHost, setRemoteHost] = useState('127.0.0.1');
      const [remotePort, setRemotePort] = useState(props.initialPort ? String(props.initialPort) : '');
      const [localPort, setLocalPort] = useState('');
      const [name, setName] = useState('');
      const [lan, setLan] = useState(false);
      const [error, setError] = useState(null);

      const submit = async (event) => {
        event.preventDefault();
        setError(null);
        const params = { remoteHost, remotePort: Number(remotePort), lan, name };
        if (localPort.trim() !== '') params.localPort = Number(localPort);
        try {
          await onSubmit(params);
        } catch (e) {
          setError(e);
        }
      };

      return h('form', { className: 'rc-form', onSubmit: submit },
        h(Field, { label: t('remoteHost'), value: remoteHost, onChange: setRemoteHost }),
        h(Field, { label: t('remotePort'), value: remotePort, onChange: setRemotePort, inputMode: 'numeric', autoFocus: true }),
        h(Field, { label: t('localPort'), value: localPort, onChange: setLocalPort, inputMode: 'numeric', hint: t('localPortHint') }),
        h(Field, { label: t('forwardName'), value: name, onChange: setName }),
        h(Check, { wide: true, label: t('lan'), checked: lan, onChange: setLan, note: lan ? t('lanWarn') : '' }),
        error ? h('div', { className: 'rc-problem wide', role: 'alert' }, errText(t, error)) : null,
        h('div', { className: 'wide rc-actions' },
          h(Button, { kind: 'primary', type: 'submit', disabled: busy || remotePort.trim() === '' }, busy ? t('forwarding') : t('forward')),
          h(Button, { onClick: onCancel, disabled: busy }, t('cancel'))));
    }

    function ForwardRow(props) {
      const { t, f, run, notify } = props;
      const [confirm, setConfirm] = useState(false);
      const [copied, setCopied] = useState(false);
      const toggle = () => run(`fwd:${f.id}`, () => callApi(f.status === 'listening' || f.status === 'starting' ? 'stopForward' : 'startForward', { id: f.id }));
      const label = f.name ? `${f.name} · ` : '';
      const local = f.status === 'listening' ? `${f.localHost === '0.0.0.0' ? '0.0.0.0' : f.localHost}:${f.boundPort}` : `${f.localHost}:${f.localPort === 0 ? 'auto' : f.localPort}`;
      const running = f.status === 'listening';
      const problem = f.error ? errText(t, f.error) : f.lastError ? errText(t, f.lastError) : '';

      useEffect(() => {
        if (!confirm) return undefined;
        const timer = window.setTimeout(() => setConfirm(false), 3500);
        return () => window.clearTimeout(timer);
      }, [confirm]);

      return h('li', { className: 'rc-row' },
        h('div', { className: 'rc-rowmain' },
          h('div', { className: 'rc-route' },
            h(Dot, { status: f.status }),
            h('span', { className: 'rc-mono' }, `${label}${f.remoteHost}:${f.remotePort}`),
            h('span', { className: 'rc-arrow', 'aria-hidden': true }, '→'),
            running
              ? h('button', { type: 'button', className: 'rc-link rc-mono', onClick: () => openWindow(() => f.url, (e) => notify(e)) }, local)
              : h('span', { className: 'rc-mono' }, local),
            f.lan ? h('span', { className: 'rc-warn' }, 'LAN') : null),
          h('div', { className: `rc-sub${problem ? ' rc-problem' : ''}` },
            problem
              ? problem
              : [t(`fwd.${f.status}`), f.total > 0 ? ` · ${t('conns', { active: f.active, total: f.total })} · ↓ ${fmtBytes(f.bytesIn)} ↑ ${fmtBytes(f.bytesOut)}` : ''].join(''))),
        h('div', { className: 'rc-actions' },
          running ? h(Button, { small: true, onClick: () => openWindow(() => f.url, (e) => notify(e)) }, t('openLocal')) : null,
          running ? h(Button, {
            small: true,
            onClick: async () => {
              if (await copyText(f.url)) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }
            },
          }, copied ? t('copied') : t('copy')) : null,
          h(Button, { small: true, onClick: toggle, disabled: !!props.pending[`fwd:${f.id}`] }, running || f.status === 'starting' ? t('stop') : t('start')),
          h(Button, {
            small: true,
            kind: 'danger',
            onClick: () => {
              if (!confirm) return setConfirm(true);
              return run(`fwd:${f.id}`, () => callApi('removeForward', { id: f.id }));
            },
          }, confirm ? t('removeConfirm') : t('removeForward'))));
    }

    function PortsList(props) {
      const { t, ports, forwards, onForward } = props;
      if (ports.loading) return h('div', { className: 'rc-muted' }, t('ports.loading'));
      if (ports.error && ports.list.length === 0) return h('div', { className: 'rc-problem' }, ports.error);
      if (ports.list.length === 0) return h('div', { className: 'rc-muted' }, t('ports.empty'));
      return h('div', null,
        h('table', { className: 'rc-table' },
          h('thead', null, h('tr', null, h('th', null, t('ports.port')), h('th', null, t('ports.address')), h('th', null, t('ports.process')), h('th', null, ''))),
          h('tbody', null, ports.list.map((p) => {
            const already = forwards.some((f) => f.remotePort === p.port && f.remoteHost === p.host);
            return h('tr', { key: `${p.host}:${p.port}` },
              h('td', { className: 'num rc-mono' }, String(p.port)),
              h('td', { className: 'rc-mono' }, p.host),
              h('td', { className: 'rc-muted' }, p.process || ''),
              h('td', { style: { textAlign: 'right' } },
                already
                  ? h('span', { className: 'rc-muted' }, t('ports.forwarded'))
                  : h(Button, { small: true, disabled: p.allowed === false, title: p.allowed === false ? t('ports.notAllowed') : undefined, onClick: () => onForward(p) }, t('forward'))));
          }))),
        ports.error ? h('div', { className: 'rc-muted', style: { marginTop: 6 } }, ports.error) : null);
    }

    // ---------------------------------------------------------------------------------------
    // Share this computer: the address another computer pastes into "Add connection"
    // ---------------------------------------------------------------------------------------

    function SharePanel(props) {
      const { t, share, run, pending, notify } = props;
      const busy = !!pending.share;
      const listening = share.status === 'listening';
      const selectId = useId();
      const portId = useId();
      const addrRef = useRef(null);
      const [copied, setCopied] = useState(false);
      const [full, setFull] = useState('');
      const [manual, setManual] = useState(false);
      const [portText, setPortText] = useState(share.port ? String(share.port) : '');
      const [confirm, setConfirm] = useState(false);

      useEffect(() => {
        setPortText(share.port ? String(share.port) : '');
      }, [share.port]);
      // A different address (new token, new port, other interface) makes any revealed copy stale.
      useEffect(() => {
        setFull('');
        setManual(false);
      }, [share.maskedUrl]);
      useEffect(() => {
        if (!confirm) return undefined;
        const timer = window.setTimeout(() => setConfirm(false), 3500);
        return () => window.clearTimeout(timer);
      }, [confirm]);
      useEffect(() => {
        if (manual && full && addrRef.current) {
          addrRef.current.focus();
          addrRef.current.select();
        }
      }, [manual, full]);

      const fetchUrl = async () => (await callApi('shareAddress')).url;

      /** One click: ask the Host for the full address (token included) and put it on the clipboard. */
      const copy = async () => {
        try {
          const url = await fetchUrl();
          if (await copyText(url)) {
            setCopied(true);
            setManual(false);
            setFull('');
            window.setTimeout(() => setCopied(false), 1800);
          } else {
            // Clipboard blocked: show the address selected so Cmd/Ctrl+C finishes the job.
            setFull(url);
            setManual(true);
          }
        } catch (e) {
          notify(e);
        }
      };

      const toggleToken = async () => {
        if (full) {
          setFull('');
          setManual(false);
          return;
        }
        try {
          setFull(await fetchUrl());
        } catch (e) {
          notify(e);
        }
      };

      const kindLabel = (option) => (option.kind && option.kind !== 'bound' ? t(`share.kind.${option.kind}`) : '');
      const optionText = (option) => {
        const kind = kindLabel(option);
        return kind ? `${option.host} · ${kind}${option.iface ? ` (${option.iface})` : ''}` : option.host;
      };

      return h('section', { className: 'rc-card rc-share', 'aria-label': t('share.title') },
        h('div', { className: 'rc-cardhead' },
          h('div', { className: 'rc-ident' },
            h(Dot, { status: share.status }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'rc-name' }, `${t('share.title')} · ${share.enabled ? t('share.on') : t('share.off')}`),
              h('div', { className: 'rc-sub' }, t('share.intro')))),
          h('div', { className: 'rc-actions' },
            share.enabled
              ? h(Button, { disabled: busy, onClick: () => run('share', () => callApi('shareDisable')) }, t('share.disable'))
              : h(Button, { kind: 'primary', disabled: busy || !share.allowed, onClick: () => run('share', () => callApi('shareEnable', {})) }, busy ? t('share.starting') : t('share.enable')))),
        !share.allowed ? h('div', { className: 'rc-warn' }, t('err.share-disabled')) : null,
        share.enabled && share.error ? h('div', { className: 'rc-problem', role: 'alert' }, errText(t, share.error)) : null,
        share.notice === 'port-changed' ? h('div', { className: 'rc-warn' }, t('share.portChanged')) : null,
        share.enabled && listening
          ? h('div', { className: 'rc-sect', style: { gap: 12 } },
            h('div', { className: 'rc-field' },
              h('span', { className: 'rc-label' }, t('share.address')),
              h('div', { className: 'rc-addrrow' },
                h('input', {
                  ref: addrRef,
                  className: 'rc-addr',
                  readOnly: true,
                  spellCheck: false,
                  'aria-label': t('share.address'),
                  value: full || share.maskedUrl,
                  onFocus: (event) => event.target.select(),
                }),
                h(Button, { kind: 'primary', onClick: copy }, copied ? t('share.copied') : t('share.copy')),
                h(Button, { onClick: toggleToken }, full ? t('share.hide') : t('share.show'))),
              manual
                ? h('span', { className: 'rc-warn', role: 'status' }, t('share.copyBlocked'))
                : h('span', { className: 'rc-label' }, `${t('share.addressHint')} ${t('share.needsPlugin')}`)),
            h('div', { className: 'rc-shareopts' },
              share.addresses.length > 1
                ? h('div', { className: 'rc-field' },
                  h('label', { className: 'rc-label', htmlFor: selectId }, t('share.via')),
                  h('select', {
                    id: selectId,
                    className: 'rc-select',
                    value: share.advertise,
                    disabled: busy,
                    onChange: (event) => run('share', () => callApi('shareUpdate', { advertise: event.target.value })),
                  }, share.addresses.map((option) => h('option', { key: option.host, value: option.host }, optionText(option)))))
                : null,
              h('div', { className: 'rc-field' },
                h('label', { className: 'rc-label', htmlFor: portId }, t('share.port')),
                h('div', { className: 'rc-actions' },
                  h('input', {
                    id: portId,
                    className: 'rc-input',
                    style: { width: 110 },
                    value: portText,
                    inputMode: 'numeric',
                    autoComplete: 'off',
                    onChange: (event) => setPortText(event.target.value),
                  }),
                  h(Button, {
                    disabled: busy || portText.trim() === String(share.port || ''),
                    onClick: () => run('share', () => callApi('shareUpdate', { port: portText.trim() === '' ? 0 : Number(portText) })),
                  }, t('share.apply')))),
              h(Button, {
                kind: 'danger',
                disabled: busy,
                onClick: () => {
                  if (!confirm) return setConfirm(true);
                  setConfirm(false);
                  return run('share', () => callApi('shareRotate'));
                },
              }, confirm ? t('share.rotateConfirm') : t('share.rotate'))),
            h('div', { className: 'rc-label' }, t('share.portHint')),
            h('div', { className: 'rc-sub' },
              [t('share.listening', { host: share.host, port: share.boundPort }), share.tunnels > 0 ? ` · ${t('share.tunnels', { n: share.tunnels })}` : ''].join('')),
            share.guiAllowed
              ? h('div', { className: 'rc-field' },
                h(Check, {
                  label: t('share.gui'),
                  checked: share.gui,
                  onChange: (checked) => run('share', () => callApi('shareUpdate', { gui: checked })),
                }),
                h('span', { className: share.gui ? 'rc-warn' : 'rc-label', role: share.gui ? 'status' : undefined }, share.gui ? t('share.guiWarn') : t('share.guiHint')))
              : null,
            h('div', { className: 'rc-warn' }, share.gui ? t('share.warn') : `${t('share.warn')} ${t('share.scope')}`))
          : null);
    }

    // ---------------------------------------------------------------------------------------
    // Connection card
    // ---------------------------------------------------------------------------------------

    function ConnectionCard(props) {
      const { t, c, forwards, run, pending, notify, onEdit, store, mode } = props;
      const [adding, setAdding] = useState(false);
      const [ports, setPorts] = useState(null);
      const [confirm, setConfirm] = useState(false);
      const busy = !!pending[`conn:${c.id}`];
      const connected = c.status === 'connected';
      /** The remote-session listener is plumbing for the session view, not a port the user forwards. */
      const portForwards = forwards.filter((f) => f.kind !== 'gui');

      useEffect(() => {
        if (!confirm) return undefined;
        const timer = window.setTimeout(() => setConfirm(false), 3500);
        return () => window.clearTimeout(timer);
      }, [confirm]);

      const detect = async () => {
        if (ports) {
          setPorts(null);
          return;
        }
        setPorts({ loading: true, list: [], error: '' });
        try {
          const listing = await callApi('listRemotePorts', { id: c.id });
          setPorts({ loading: false, list: Array.isArray(listing.ports) ? listing.ports : [], error: listing.error || '' });
        } catch (e) {
          setPorts({ loading: false, list: [], error: errText(t, e) });
        }
      };

      const addForward = async (params) => {
        const { forward } = await callApi('addForward', { ...params, connectionId: c.id });
        if (forward.status === 'error') {
          const error = new Error(forward.error.message);
          error.code = forward.error.code;
          throw error;
        }
        setAdding(false);
      };

      /** Switching: this window's whole DSH (sessions, files, agent) comes from the other computer. */
      const gui = c.info ? c.info.gui : null;
      const compat = c.compat || { status: 'unknown', local: null, remote: null };
      const blocked = blockReason(t, c, mode);
      const switching = !!pending[`switch:${c.id}`];
      const doSwitch = () => run(`switch:${c.id}`, () => switchMode(store, c.active ? null : c.id));
      /** Without the plugin on the other side there is no tunnel, but a `dsh web` URL still opens directly. */
      const noPlugin = c.status === 'error' && !!c.error && c.error.code === 'no-plugin';
      const sub = [c.url];
      if (c.info) sub.push(`${c.info.hostname} (${c.info.platform}/${c.info.arch})`);
      if (connected && c.latencyMs != null) sub.push(t('latency', { ms: c.latencyMs }));
      if (c.tunnels > 0) sub.push(t('tunnels', { n: c.tunnels }));

      return h('li', { className: 'rc-card', 'data-connection': c.id },
        h('div', { className: 'rc-cardhead' },
          h('div', { className: 'rc-ident' },
            h(Dot, { status: c.status }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'rc-name' }, c.name),
              h('div', { className: 'rc-sub' }, sub.join(' · ')),
              h('div', { className: c.status === 'error' ? 'rc-problem' : 'rc-sub' }, c.status === 'error' ? errText(t, c.error) : t(`status.${c.status}`)),
              connected && c.info && c.info.server && c.info.server.enabled === false ? h('div', { className: 'rc-warn' }, t('serverOff')) : null,
              connected && c.info
                ? h('div', { className: 'rc-versions' },
                  h('span', { className: compat.status === 'same' ? 'rc-ok' : compat.status === 'different' ? 'rc-warn' : 'rc-sub' },
                    compat.local && compat.remote
                      ? `${t('mode.versions', { local: compat.local, remote: compat.remote })}${compat.status === 'same' ? ` · ${t('mode.same')}` : ''}`
                      : (compat.status === 'unknown' ? t('mode.unknown') : '')))
                : null,
              connected && c.info && gui && gui.enabled === false ? h('div', { className: 'rc-sub' }, t('guiOffHint')) : null,
              connected && blocked && gui && gui.enabled !== false ? h('div', { className: 'rc-warn' }, blocked) : null,
              c.active ? h('div', { className: 'rc-using' }, h('span', { className: 'rcm-dotl', 'aria-hidden': true }), t('mode.using')) : null)),
          h('div', { className: 'rc-actions' },
            connected || c.active
              ? h(Button, { kind: c.active ? undefined : 'primary', title: t('mode.note'), disabled: switching || (!c.active && !!blocked), onClick: doSwitch },
                switching ? t('mode.switching') : c.active ? t('mode.switchBack') : t('mode.switchTo'))
              : null,
            h(Button, {
              kind: c.wanted ? undefined : 'primary',
              disabled: busy,
              onClick: () => run(`conn:${c.id}`, () => callApi(c.wanted ? 'disconnect' : 'connect', { id: c.id })),
            }, c.wanted ? t('disconnect') : t('connect')),
            noPlugin ? h(Button, { onClick: () => openWindow(async () => (await callApi('openUrl', { id: c.id })).url, notify) }, t('openDirect')) : null,
            h(Button, { onClick: () => onEdit(c) }, t('edit')),
            h(Button, {
              kind: 'danger',
              onClick: () => {
                if (!confirm) return setConfirm(true);
                return run(`conn:${c.id}`, () => callApi('removeConnection', { id: c.id }));
              },
            }, confirm ? t('removeConfirm') : t('remove')))),
        h('div', { className: 'rc-sect' },
          h('div', { className: 'rc-secthead' },
            h('h3', { className: 'rc-secttitle' }, t('forwards')),
            h('div', { className: 'rc-actions' },
              h(Button, { small: true, onClick: detect, disabled: !c.wanted && !connected }, ports ? t('hidePorts') : t('detectPorts')),
              h(Button, { small: true, kind: 'primary', onClick: () => setAdding(!adding) }, t('addForward')))),
          adding ? h(ForwardForm, { t, onSubmit: addForward, onCancel: () => setAdding(false), busy: false }) : null,
          ports ? h('div', { className: 'rc-sect', style: { paddingTop: 10 } },
            h('h3', { className: 'rc-secttitle' }, t('ports.title')),
            h(PortsList, {
              t,
              ports,
              forwards: portForwards,
              onForward: (p) => run(`conn:${c.id}`, () => callApi('addForward', { connectionId: c.id, remoteHost: p.host, remotePort: p.port })),
            })) : null,
          portForwards.length === 0 && !adding
            ? h('div', { className: 'rc-muted' }, t('noForwards'))
            : h('ul', { className: 'rc-rows' }, portForwards.map((f) => h(ForwardRow, { key: f.id, t, f, run, pending, notify })))));
    }

    // ---------------------------------------------------------------------------------------
    // Switching between this computer's DSH and a remote one
    // ---------------------------------------------------------------------------------------

    const MODE_CSS = `
.rcm-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.rcm-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rcm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.rcm-btn.remote{color:var(--dsw-alias-brand-primary)}
.rcm-wrap{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.rcm-conn{min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-success-primary,#22a05a);font-size:12px;line-height:18px;font-weight:500}
.rcm-conn.down{color:var(--dsw-alias-state-error-primary)}
.rcm-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rcm-menu{position:fixed;z-index:2100;box-sizing:border-box;min-width:280px;max-width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.rcm-menu *{box-sizing:border-box}
.rcm-title{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.rcm-item{display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.rcm-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.rcm-item:disabled{opacity:.55;cursor:default}
.rcm-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rcm-check{flex:none;width:16px;color:var(--dsw-alias-brand-primary)}
.rcm-main{display:flex;flex-direction:column;min-width:0;flex:1}
.rcm-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcm-sub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.rcm-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;overflow-wrap:anywhere}
.rcm-sep{height:1px;margin:6px 4px;background:var(--dsw-alias-border-l1)}
.rcm-err{padding:6px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.rcm-banner{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2000;box-sizing:border-box;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 160px);padding:5px 6px 5px 12px;border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;-webkit-app-region:no-drag}
.rcm-banner.down{border-color:var(--dsw-alias-state-error-primary)}
.rcm-dotl{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rcm-banner.down .rcm-dotl{background:var(--dsw-alias-state-error-primary)}
.rcm-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcm-action{flex:none;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.rcm-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.rcm-action:disabled{opacity:.5;cursor:default}
.rcm-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;

    /**
     * One shared view of the Host's state for everything this plugin draws (the sidebar button, the banner
     * and the panel): they poll once and always agree. When the DSH this window is using changes, the window
     * reloads, because everything it shows came from the other data source.
     */
    function createStore() {
      let snapshot = { state: null, failed: false };
      let baseline;
      let timer = 0;
      let inflight = null;
      let disposed = false;
      const listeners = new Set();
      const holds = new Set();

      const emit = () => {
        for (const listener of [...listeners]) listener();
      };
      const interval = () => (holds.size > 0 ? Math.min(...[...holds].map((hold) => hold.ms)) : IDLE_POLL_MS);

      let lastKey = '';
      /** The Host stamps every answer with the time; that alone is not a change. */
      const keyOf = (state, failed) => JSON.stringify([failed, state], (name, value) => (name === 'now' ? undefined : value));

      function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
          let changed = true;
          try {
            const state = await fetchState();
            const active = state.mode ? state.mode.active : null;
            const key = keyOf(state, false);
            changed = key !== lastKey;
            lastKey = key;
            snapshot = { state, failed: false };
            if (baseline === undefined) baseline = active;
            else if (active !== baseline) {
              baseline = active;
              emit();
              // Everything on screen came from the other data source: start over on the new one.
              window.location.reload();
              return;
            }
          } catch {
            const key = keyOf(snapshot.state, true);
            changed = key !== lastKey;
            lastKey = key;
            snapshot = { state: snapshot.state, failed: true };
          }
          if (changed) emit();
        })().finally(() => {
          inflight = null;
        });
        return inflight;
      }

      function schedule() {
        window.clearTimeout(timer);
        if (disposed || (listeners.size === 0 && holds.size === 0)) return;
        timer = window.setTimeout(async () => {
          if (document.visibilityState === 'visible') await refresh();
          schedule();
        }, interval());
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) refresh();
          schedule();
          return () => {
            listeners.delete(listener);
            schedule();
          };
        },
        refresh,
        /** Ask for faster polling while something (the panel) is on screen. */
        hold(ms) {
          const hold = { ms };
          holds.add(hold);
          schedule();
          return () => {
            holds.delete(hold);
            schedule();
          };
        },
        dispose() {
          disposed = true;
          window.clearTimeout(timer);
          listeners.clear();
          holds.clear();
        },
      };
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    /** Switch to connection `id`, or back to this computer with `null`. The refresh sees the change and reloads the window. */
    async function switchMode(store, id) {
      await callApi(id ? 'modeEnter' : 'modeLeave', id ? { id } : {});
      await store.refresh();
    }

    /** Why connection `c` cannot be switched to right now, as text ('' when it can). */
    function blockReason(t, c, mode) {
      if (c.status !== 'connected') return t('mode.notConnected');
      if (!mode || !mode.supported) return t('mode.unsupported', { reason: (mode && mode.reason) || '?' });
      const compat = c.compat || { status: 'unknown', local: null, remote: null };
      if (!c.info || !c.info.gui || compat.status === 'remote-old') return t('mode.old');
      if (mode.allowVersionMismatch) return '';
      if (compat.status === 'different') return t('mode.different', { local: compat.local, remote: compat.remote });
      if (compat.status === 'unknown') return t('mode.unknown');
      return '';
    }

    function SwitchIcon(props) {
      const size = props.size || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      },
        h('path', { d: 'M4 8h14' }),
        h('path', { d: 'M14.5 4.5 18 8l-3.5 3.5' }),
        h('path', { d: 'M20 16H6' }),
        h('path', { d: 'M9.5 12.5 6 16l3.5 3.5' }));
    }

    /** The switch button in the sidebar foot: this computer's DSH or a remote one. */
    function ModeSwitch(props) {
      const { t, store, openPanel } = props;
      const { state } = useStore(store);
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [pos, setPos] = useState({ left: 8, bottom: 8 });
      const buttonRef = useRef(null);
      const menuRef = useRef(null);
      const mode = state && state.mode ? state.mode : null;
      const connections = state ? state.connections : [];
      const remote = !!(mode && mode.active);
      const title = remote ? `${t('mode.remote')} · ${mode.name}` : t('mode.local');

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (menuRef.current && menuRef.current.contains(event.target)) return;
          if (buttonRef.current && buttonRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          setOpen(false);
          if (buttonRef.current) buttonRef.current.focus();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      const toggle = () => {
        if (!open && buttonRef.current) {
          const rect = buttonRef.current.getBoundingClientRect();
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - 300));
          setPos(rect.top > 320 ? { left, bottom: Math.max(8, window.innerHeight - rect.top + 6) } : { left, top: rect.bottom + 6 });
          setError('');
        }
        setOpen(!open);
      };

      const choose = async (id) => {
        setBusy(true);
        setError('');
        try {
          await switchMode(store, id);
          setOpen(false);
        } catch (e) {
          setError(errText(t, e));
        } finally {
          setBusy(false);
        }
      };

      const manage = () => {
        setOpen(false);
        try {
          openPanel();
        } catch {
          /* the panel is not available in this layout */
        }
      };

      return h('div', { className: 'rcm-wrap' },
        h('style', null, MODE_CSS),
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: `rcm-btn${remote ? ' remote' : ''}`,
          title,
          'aria-label': title,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: toggle,
        }, h(SwitchIcon, { size: 16 }), remote ? h('span', { className: 'rcm-dot', 'aria-hidden': true }) : null),
        remote ? h('span', { className: `rcm-conn${mode.connected ? '' : ' down'}`, title }, mode.name) : null,
        open ? h('div', { ref: menuRef, className: 'rcm-menu', role: 'menu', style: pos },
          h('div', { className: 'rcm-title' }, t('mode.menuTitle')),
          h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': !remote, className: 'rcm-item', disabled: busy || !remote, onClick: () => choose(null) },
            h('span', { className: 'rcm-check' }, remote ? '' : '✓'),
            h('span', { className: 'rcm-main' },
              h('span', { className: 'rcm-name' }, t('mode.local')),
              mode && mode.localVersion ? h('span', { className: 'rcm-sub' }, `DSH ${mode.localVersion}`) : null)),
          connections.length === 0 ? h('div', { className: 'rcm-sub', style: { padding: '6px 10px' } }, t('mode.none')) : null,
          connections.map((c) => {
            const blocked = blockReason(t, c, mode);
            const guiOff = !blocked && c.info && c.info.gui && c.info.gui.enabled === false && !c.active;
            const compat = c.compat || {};
            return h('button', {
              key: c.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': c.active,
              className: 'rcm-item',
              disabled: busy || (!c.active && !!blocked),
              onClick: () => (c.active ? undefined : choose(c.id)),
            },
              h('span', { className: 'rcm-check' }, c.active ? '✓' : ''),
              h('span', { className: 'rcm-main' },
                h('span', { className: 'rcm-name' }, `${t('mode.remote')} · ${c.name}`),
                h('span', { className: 'rcm-sub' }, [c.info ? c.info.hostname : c.host, compat.remote ? `DSH ${compat.remote}` : ''].filter(Boolean).join(' · ')),
                blocked && !c.active ? h('span', { className: 'rcm-warn' }, blocked) : null,
                guiOff ? h('span', { className: 'rcm-sub' }, t('guiOffHint')) : null));
          }),
          h('div', { className: 'rcm-sep' }),
          h('button', { type: 'button', role: 'menuitem', className: 'rcm-item', onClick: manage },
            h('span', { className: 'rcm-check' }),
            h('span', { className: 'rcm-main' }, h('span', { className: 'rcm-name' }, t('mode.manage')))),
          error ? h('div', { className: 'rcm-err', role: 'alert' }, error) : null) : null);
    }

    /** While the window runs on a remote DSH, say so on every page and offer the way back. */
    function ModeBanner(props) {
      const { t, store } = props;
      const { state } = useStore(store);
      const [busy, setBusy] = useState(false);
      const mode = state && state.mode ? state.mode : null;
      if (!mode || !mode.active) return null;
      const down = !mode.connected;
      return h('div', { className: `rcm-banner${down ? ' down' : ''}`, role: 'status' },
        h('style', null, MODE_CSS),
        h('span', { className: 'rcm-dotl', 'aria-hidden': true }),
        h('span', { className: 'rcm-text', title: t('mode.bannerNote') }, down ? t('mode.bannerDown', { name: mode.name }) : t('mode.banner', { name: mode.name })),
        h('button', {
          type: 'button',
          className: 'rcm-action',
          disabled: busy,
          onClick: async () => {
            setBusy(true);
            try {
              await switchMode(store, null);
            } catch {
              setBusy(false);
            }
          },
        }, busy ? t('mode.switching') : t('mode.switchBack')));
    }

    // ---------------------------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------------------------

    function Page(props) {
      const { t, store } = props;
      const { state, failed: loadFailed } = useStore(store);
      const [notice, setNotice] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [pending, setPending] = useState({});
      const alive = useRef(true);

      // The panel is on screen: poll faster than the idle rate so health and traffic stay current.
      useEffect(() => {
        alive.current = true;
        const release = store.hold(POLL_MS);
        store.refresh();
        return () => {
          alive.current = false;
          release();
        };
      }, [store]);

      const refresh = store.refresh;

      const notify = useCallback((error) => {
        if (alive.current) setNotice({ text: errText(t, error) });
      }, [t]);

      const run = useCallback(async (key, fn) => {
        setPending((p) => ({ ...p, [key]: true }));
        setNotice(null);
        try {
          return await fn();
        } catch (e) {
          notify(e);
          return undefined;
        } finally {
          if (alive.current) {
            setPending((p) => {
              const next = { ...p };
              delete next[key];
              return next;
            });
          }
          await refresh();
        }
      }, [notify, refresh]);

      const connections = state ? state.connections : [];
      const forwards = state ? state.forwards : [];
      const mode = state ? state.mode : null;

      return h('div', { className: 'rc-page' },
        h('style', null, CSS),
        h('header', { className: 'rc-head' },
          h('div', null,
            h('h2', { className: 'rc-title' }, t('title')),
            h('p', { className: 'rc-intro' }, t('intro'))),
          h('div', { className: 'rc-actions' },
            h(Button, { kind: 'primary', onClick: () => setDialog({ mode: 'add' }) }, t('addConnection')))),
        loadFailed ? h('div', { className: 'rc-banner warn', role: 'status' }, t('loadFailed')) : null,
        state && state.loadError ? h('div', { className: 'rc-banner warn', role: 'status' }, state.loadError) : null,
        notice ? h('div', { className: 'rc-banner', role: 'alert' },
          h('span', null, notice.text),
          h(Button, { small: true, onClick: () => setNotice(null) }, t('dismiss'))) : null,
        state && state.share ? h(SharePanel, { t, share: state.share, run, pending, notify }) : null,
        !state
          ? (loadFailed ? null : h('div', { className: 'rc-muted' }, t('loading')))
          : connections.length === 0
            ? h('div', { className: 'rc-empty' }, h('strong', null, t('emptyTitle')), h('span', null, t('emptyBody')))
            : h('ul', { className: 'rc-list' }, connections.map((c) => h(ConnectionCard, {
              key: c.id,
              t,
              c,
              forwards: forwards.filter((f) => f.connectionId === c.id),
              run,
              pending,
              notify,
              onEdit: (connection) => setDialog({ mode: 'edit', connection }),
              store,
              mode,
            }))),
        dialog ? h(ConnectionDialog, {
          t,
          existing: dialog.mode === 'edit' ? dialog.connection : null,
          onClose: () => setDialog(null),
          onDone: () => {
            setDialog(null);
            refresh();
          },
        }) : null);
    }

    /** Sidebar glyph: two machines joined by a two-way link. Inherits the sidebar's colour. */
    function PanelIcon(props) {
      const size = props.size || 20;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      },
        h('circle', { cx: 5, cy: 12, r: 2.4 }),
        h('circle', { cx: 19, cy: 12, r: 2.4 }),
        h('path', { d: 'M8.2 12h7.6' }),
        h('path', { d: 'M10.4 9.8 8.2 12l2.2 2.2' }),
        h('path', { d: 'M13.6 9.8 15.8 12l-2.2 2.2' }));
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-remote-connect: dictionaries');
        const t = ctx.locale.bind(NS);
        const store = createStore();
        ctx.effect(() => () => store.dispose(), 'dsh-remote-connect: state');
        const openPanel = () => ctx.layout.selectPanel(PANEL_ID);

        // The panel: connections, sharing, forwards.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ store }),
        }, Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('panel'), locale: NS,
        }, PanelIcon));

        // The switch: this computer's DSH or a remote one, one click from anywhere.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'remote-connect.mode', order: 0, label: () => t('mode.menuTitle'), locale: NS,
          inject: () => ({ store, openPanel }),
        }, ModeSwitch));
        // No top banner any more: the connection name is shown (green) beside the switch button above.
      },
    };
  },
});
