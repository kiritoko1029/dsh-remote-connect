/**
 * Minimal RFC 6455 WebSocket peer over an already-upgraded socket.
 *
 * The tunnel only needs binary data frames, one tiny text control message ("eof"), ping/pong and
 * close, so this is a small purpose-built codec instead of a dependency (a profile-installed
 * bundle cannot resolve packages from the DSH installation).
 *
 * Why WebSocket at all instead of a bare `Upgrade: tunnel`: reverse proxies and tunnels in front
 * of a remote DSH (nginx, Caddy, Cloudflare, ...) pass WebSocket upgrades through, and nothing else.
 */
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BIN = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** One outgoing data frame carries at most this many payload bytes. */
const CHUNK = 64 * 1024
/** Largest incoming payload accepted in one frame. */
const MAX_PAYLOAD = 4 * 1024 * 1024
/** Text messages are control signals ("eof"); anything longer is a protocol violation. */
const MAX_TEXT = 1024

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** A fresh client `Sec-WebSocket-Key`. */
export function newKey() {
  return randomBytes(16).toString('base64')
}

/**
 * Encode one unfragmented frame.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask clients must mask, servers must not
 */
export function encodeFrame(opcode, payload, mask) {
  const len = payload.length
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8
  const out = Buffer.allocUnsafe(2 + ext + (mask ? 4 : 0) + len)
  const maskBit = mask ? 0x80 : 0
  out[0] = 0x80 | opcode
  let offset = 2
  if (len < 126) {
    out[1] = maskBit | len
  } else if (len < 65536) {
    out[1] = maskBit | 126
    out.writeUInt16BE(len, 2)
    offset = 4
  } else {
    out[1] = maskBit | 127
    out.writeBigUInt64BE(BigInt(len), 2)
    offset = 10
  }
  if (mask) {
    const key = randomBytes(4)
    key.copy(out, offset)
    offset += 4
    for (let i = 0; i < len; i++) out[offset + i] = payload[i] ^ key[i & 3]
  } else {
    payload.copy(out, offset)
  }
  return out
}

/** Incremental frame parser. Calls `onFrame({fin, opcode, payload})`; reports violations through `onViolation(code, reason)`. */
class FrameParser {
  constructor({ expectMask, onFrame, onViolation }) {
    this.expectMask = expectMask
    this.onFrame = onFrame
    this.onViolation = onViolation
    this.buffer = Buffer.alloc(0)
    this.failed = false
  }

  push(chunk) {
    if (this.failed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  fail(code, reason) {
    this.failed = true
    this.buffer = Buffer.alloc(0)
    this.onViolation(code, reason)
  }

  drain() {
    for (;;) {
      const buf = this.buffer
      if (buf.length < 2) return
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if ((b0 & 0x70) !== 0) return this.fail(1002, 'reserved bits set')
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_PAYLOAD)) return this.fail(1009, 'frame too large')
        len = Number(big)
        offset = 10
      }
      if (len > MAX_PAYLOAD) return this.fail(1009, 'frame too large')
      if (masked !== this.expectMask) return this.fail(1002, masked ? 'unexpected mask' : 'missing mask')
      if (opcode >= 0x8 && (!fin || len > 125)) return this.fail(1002, 'invalid control frame')
      if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode !== OP_BIN && opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
        return this.fail(1002, 'unknown opcode')
      }
      const maskLen = masked ? 4 : 0
      const total = offset + maskLen + len
      if (buf.length < total) return
      let payload = buf.subarray(offset + maskLen, total)
      if (masked) {
        const key = buf.subarray(offset, offset + 4)
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3]
        payload = out
      }
      this.buffer = buf.subarray(total)
      this.onFrame({ fin, opcode, payload })
      if (this.failed) return
    }
  }
}

/**
 * One end of an established WebSocket. Events:
 *  - `data` (Buffer)   binary payload, in order
 *  - `text` (string)   short control message
 *  - `drain`           the underlying socket can take more writes
 *  - `error` (Error)   transport failure or protocol violation (only emitted while someone listens)
 *  - `close` ({code})  the connection is gone; emitted exactly once
 */
export class WsPeer extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket upgraded socket (after the 101 response)
   * @param {{role: 'client'|'server', head?: Buffer, pingMs?: number, idleMs?: number}} options
   */
  constructor(socket, { role, head, pingMs = 25000, idleMs } = {}) {
    super()
    this.socket = socket
    this.role = role
    this.mask = role === 'client'
    this.lastRx = Date.now()
    this.closeSent = false
    this.closeCode = undefined
    this.closed = false
    this.destroyed = false
    this.fragment = undefined
    this.textParts = []
    this.textBytes = 0
    this.parser = new FrameParser({
      expectMask: role === 'server',
      onFrame: (frame) => this.onFrame(frame),
      onViolation: (code, reason) => {
        this.fire('error', new Error(`websocket protocol violation: ${reason}`))
        this.close(code)
      },
    })

    socket.setNoDelay?.(true)
    socket.setTimeout?.(0)
    socket.on('data', (chunk) => {
      this.lastRx = Date.now()
      this.parser.push(chunk)
    })
    socket.on('drain', () => this.emit('drain'))
    socket.on('error', (error) => this.fire('error', error))
    socket.on('end', () => {
      // The peer finished without (or right after) a close frame: finish our side too.
      if (!socket.destroyed) socket.end()
    })
    socket.on('close', () => this.onSocketClose())

    if (head && head.length > 0) queueMicrotask(() => this.parser.push(head))

    if (pingMs > 0) {
      const limit = idleMs ?? pingMs * 3
      this.timer = setInterval(() => {
        if (Date.now() - this.lastRx > limit) {
          this.fire('error', new Error('tunnel timed out (no traffic or pong)'))
          this.destroy()
          return
        }
        this.write(encodeFrame(OP_PING, Buffer.alloc(0), this.mask))
      }, pingMs)
      this.timer.unref?.()
    }
  }

  fire(event, value) {
    if (event === 'error' && this.listenerCount('error') === 0) return
    this.emit(event, value)
  }

  write(buffer) {
    if (this.destroyed || !this.socket.writable) return false
    return this.socket.write(buffer)
  }

  /** Send binary data; returns false when the caller should wait for `drain`. */
  sendData(buffer) {
    let ok = true
    for (let offset = 0; offset < buffer.length; offset += CHUNK) {
      ok = this.write(encodeFrame(OP_BIN, buffer.subarray(offset, offset + CHUNK), this.mask))
    }
    return ok
  }

  sendText(text) {
    return this.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), this.mask))
  }

  sendClose(code) {
    if (this.closeSent) return
    this.closeSent = true
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.write(encodeFrame(OP_CLOSE, payload, this.mask))
  }

  /** Graceful close: send a close frame, finish writing, and force-destroy if the peer never answers. */
  close(code = 1000) {
    if (this.destroyed) return
    this.sendClose(code)
    if (!this.socket.destroyed) this.socket.end()
    if (!this.forceTimer) {
      this.forceTimer = setTimeout(() => this.destroy(), 3000)
      this.forceTimer.unref?.()
    }
  }

  pause() {
    this.socket.pause()
  }

  resume() {
    this.socket.resume()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    clearInterval(this.timer)
    clearTimeout(this.forceTimer)
    this.socket.destroy()
  }

  onSocketClose() {
    clearInterval(this.timer)
    clearTimeout(this.forceTimer)
    this.destroyed = true
    if (this.closed) return
    this.closed = true
    this.emit('close', { code: this.closeCode ?? 1006 })
  }

  onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_PING:
        this.write(encodeFrame(OP_PONG, payload, this.mask))
        return
      case OP_PONG:
        return
      case OP_CLOSE: {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        this.sendClose(this.closeCode === 1005 ? 1000 : this.closeCode)
        if (!this.socket.destroyed) this.socket.end()
        return
      }
      case OP_TEXT:
        if (this.fragment) return this.parser.fail(1002, 'text frame inside a fragmented message')
        this.fragment = 'text'
        this.textParts = []
        this.textBytes = 0
        this.collectText(payload, fin)
        return
      case OP_BIN:
        if (this.fragment) return this.parser.fail(1002, 'binary frame inside a fragmented message')
        this.fragment = fin ? undefined : 'bin'
        if (payload.length > 0) this.emit('data', payload)
        return
      case OP_CONT:
        if (!this.fragment) return this.parser.fail(1002, 'unexpected continuation frame')
        if (this.fragment === 'bin') {
          if (fin) this.fragment = undefined
          if (payload.length > 0) this.emit('data', payload)
        } else {
          this.collectText(payload, fin)
        }
        return
      default:
    }
  }

  collectText(payload, fin) {
    this.textBytes += payload.length
    if (this.textBytes > MAX_TEXT) return this.parser.fail(1009, 'text message too large')
    this.textParts.push(payload)
    if (!fin) return
    this.fragment = undefined
    const text = Buffer.concat(this.textParts).toString('utf8')
    this.textParts = []
    this.emit('text', text)
  }
}
