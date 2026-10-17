/**
 * Standards-Compliant RFC 6455 WebSocket Server & Client
 *
 * Features:
 * - Origin verification during HTTP Upgrade handshake (`verifyOrigin`)
 * - RFC 6455 handshake (`Sec-WebSocket-Accept` SHA-1 digest)
 * - Masked client frame decoding & server frame encoding (text, ping, pong, close)
 * - Max frame size guard (64 KB) to prevent memory exhaustion
 * - Per-connection token-bucket rate limiting
 * - Heartbeat ping/pong dead-peer detection
 */
'use strict';

const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const http = require('node:http');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 64 * 1024;

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = 1; // OPEN
    this.isAlive = true;
    this.buffer = Buffer.alloc(0);
    this.rateTokens = 40;
    this.lastRateRefill = Date.now();

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => {
      this.readyState = 3;
      this.emit('close');
    });
    socket.on('error', err => {
      this.emit('error', err);
    });
  }

  _checkRateLimit() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRateRefill) / 1000;
    if (elapsedSec > 0) {
      this.rateTokens = Math.min(40, this.rateTokens + elapsedSec * 25);
      this.lastRateRefill = now;
    }
    if (this.rateTokens < 1) return false;
    this.rateTokens -= 1;
    return true;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = Boolean(secondByte & 0x80);
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        payloadLen = high * 0x100000000 + low;
        offset = 10;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        this.close(1009, 'Payload too large');
        return;
      }

      const maskLen = isMasked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xA, payload);
      } else if (opcode === 0xA) {
        this.isAlive = true;
      } else if (opcode === 0x1) {
        if (!this._checkRateLimit()) {
          this.sendJSON({ type: 'ERROR', code: 'RATE_LIMIT', error: 'Too many messages. Slow down.' });
          continue;
        }
        const text = payload.toString('utf8');
        this.emit('message', text);
      }
    }
  }

  _sendFrame(opcode, payloadBuffer, maskClientFrame) {
    if (this.readyState !== 1) return;
    const len = payloadBuffer.length;
    let headerLen = 2;
    if (len >= 126 && len <= 65535) headerLen = 4;
    else if (len > 65535) headerLen = 10;

    const maskBit = maskClientFrame ? 0x80 : 0x00;
    const maskBytes = maskClientFrame ? crypto.randomBytes(4) : null;
    const frame = Buffer.allocUnsafe(headerLen + (maskClientFrame ? 4 : 0) + len);

    frame[0] = 0x80 | (opcode & 0x0f);
    if (len < 126) {
      frame[1] = maskBit | len;
    } else if (len <= 65535) {
      frame[1] = maskBit | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = maskBit | 127;
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(len, 6);
    }

    let offset = headerLen;
    if (maskClientFrame && maskBytes) {
      maskBytes.copy(frame, offset);
      offset += 4;
      for (let i = 0; i < len; i++) {
        frame[offset + i] = payloadBuffer[i] ^ maskBytes[i & 3];
      }
    } else {
      payloadBuffer.copy(frame, offset);
    }

    try {
      this.socket.write(frame);
    } catch (e) {}
  }

  send(text) {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    this._sendFrame(0x1, buf, false);
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    this._sendFrame(0x9, Buffer.alloc(0), false);
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code || 1000, 0);
      this._sendFrame(0x8, payload, false);
      this.socket.end();
    } catch (e) {}
  }
}

class NativeWebSocketServer extends EventEmitter {
  constructor(httpServer, options) {
    super();
    this.options = options || {};
    this.clients = new Set();

    httpServer.on('upgrade', (req, socket, head) => {
      // 1. Validate Origin header if verifyOrigin hook is configured
      if (typeof this.options.verifyOrigin === 'function') {
        const check = this.options.verifyOrigin(req);
        if (!check || !check.allowed) {
          const status = (check && check.statusCode) || 403;
          const body = JSON.stringify({
            ok: false,
            code: (check && check.code) || 'INVALID_ORIGIN',
            error: (check && check.error) || 'WebSocket upgrade rejected due to untrusted Origin.'
          });
          socket.write(
            `HTTP/1.1 ${status} Forbidden\r\n` +
            `Content-Type: application/json; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n` +
            body
          );
          socket.destroy();
          return;
        }
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ];
      socket.write(responseHeaders.join('\r\n'));

      const ws = new WebSocketConnection(socket, req);
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      if (head && head.length) ws._onData(head);
      this.emit('connection', ws, req);
    });

    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          ws.close(1001, 'Ping timeout');
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 25000);
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  close() {
    clearInterval(this.heartbeatInterval);
    for (const ws of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}

/**
 * Lightweight RFC 6455 WebSocket Client for automated integration tests.
 * Supports custom `origin` and `headers`, and rejects with HTTP `statusCode` when upgrade is denied (e.g. 403).
 */
function connectWebSocketClient(url, clientOptions) {
  const opts = clientOptions || {};
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const headers = Object.assign({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key
    }, opts.headers || {});

    if (opts.origin !== undefined) {
      if (opts.origin === null) {
        delete headers.Origin;
      } else {
        headers.Origin = opts.origin;
      }
    }

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers
    });

    req.on('upgrade', (res, socket, head) => {
      const conn = new WebSocketConnection(socket, res);
      conn.send = function (text) {
        const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
        this._sendFrame(0x1, buf, true);
      };
      if (head && head.length) conn._onData(head);
      resolve(conn);
    });

    req.on('response', (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        const err = new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}: ${raw}`);
        err.statusCode = res.statusCode;
        try {
          err.body = JSON.parse(raw);
        } catch (e) {
          err.body = raw;
        }
        reject(err);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  NativeWebSocketServer,
  WebSocketConnection,
  connectWebSocketClient
};
