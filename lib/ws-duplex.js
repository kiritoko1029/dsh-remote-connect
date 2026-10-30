/**
 * A Node `Duplex` over a {@link WsPeer}, so an `http.Server` or an `http.Agent` can speak HTTP over a
 * tunnel without a network port: `server.emit('connection', new WsDuplex(ws))`, or an Agent whose
 * `createConnection` returns one.
 *
 * Same wire semantics as the TCP bridge: binary frames are the bytes, the text frame "eof" is a
 * half-close, the WebSocket close frame ends everything.
 */
import { Duplex } from 'node:stream'

export class WsDuplex extends Duplex {
  /** @param {import('./ws.js').WsPeer} ws */
  constructor(ws) {
    super({ allowHalfOpen: true })
    this.ws = ws
    this.remoteAddress = '127.0.0.1'
    this.remotePort = 0
    this.idleMs = 0
    this.idleTimer = undefined
    ws.on('data', (buffer) => {
      this.touch()
      if (!this.push(buffer)) ws.pause()
    })
    ws.on('text', (text) => {
      if (text === 'eof') this.push(null)
    })
    ws.on('close', () => this.destroy())
    ws.on('error', (error) => this.destroy(error))
  }

  _read() {
    this.ws.resume()
  }

  _write(chunk, _encoding, callback) {
    this.touch()
    if (this.ws.sendData(chunk)) callback()
    else this.ws.once('drain', () => callback())
  }

  _final(callback) {
    this.ws.sendText('eof')
    callback()
  }

  _destroy(error, callback) {
    clearTimeout(this.idleTimer)
    this.ws.close(1000)
    callback(error)
  }

  /** Restart the idle clock; `http.Agent` relies on 'timeout' to retire idle keep-alive sockets before the peer does. */
  touch() {
    if (this.idleMs <= 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMs)
    this.idleTimer.unref?.()
  }

  // `net.Socket` surface that `http` calls on whatever it is handed as a socket.
  setTimeout(ms, callback) {
    clearTimeout(this.idleTimer)
    this.idleMs = ms
    if (callback) this.once('timeout', callback)
    this.touch()
    return this
  }

  setNoDelay() {
    return this
  }

  setKeepAlive() {
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}
