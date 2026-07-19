import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_INBOUND = 64 * 1024;
const DEFAULT_MAX_BUFFERED = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL = 30_000;

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function validWebSocketKey(value) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  const decoded = Buffer.from(key, 'base64');
  return decoded.length === 16 && decoded.toString('base64') === key;
}

function validHandshake(request) {
  const connection = String(request.headers.connection || '')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  return request.method === 'GET'
    && String(request.headers.upgrade || '').toLowerCase() === 'websocket'
    && connection.includes('upgrade')
    && String(request.headers['sec-websocket-version'] || '') === '13'
    && validWebSocketKey(request.headers['sec-websocket-key']);
}

export class WebSocketClient extends EventEmitter {
  constructor(socket, { sessionId = null, isAuthorized = () => true, maxBufferedBytes = DEFAULT_MAX_BUFFERED } = {}) {
    super();
    this.socket = socket;
    this.sessionId = sessionId;
    this.isAuthorized = isAuthorized;
    this.maxBufferedBytes = maxBufferedBytes;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.alive = true;
    this.backpressured = false;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('drain', () => {
      this.backpressured = false;
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  send(value) {
    try {
      return this.writeFrame(0x1, JSON.stringify(value));
    } catch {
      return false;
    }
  }

  ping() {
    return this.writeFrame(0x9);
  }

  writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return false;
    const encoded = frame(opcode, payload);
    const buffered = Number(this.socket.writableLength) || 0;
    if (this.backpressured || buffered + encoded.length > this.maxBufferedBytes) {
      this.close(1013, 'Client too slow');
      return false;
    }
    try {
      if (!this.socket.write(encoded)) this.backpressured = true;
      return true;
    } catch {
      this.socket.destroy();
      this.finish();
      return false;
    }
  }

  consume(chunk) {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > MAX_INBOUND + 14) {
      this.close(1009, 'Message too large');
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      const control = opcode >= 0x8;
      let length = second & 0x7f;
      let offset = 2;

      if (first & 0x70) return this.close(1002, 'Reserved bits are not supported');
      if (!final) return this.close(control ? 1002 : 1003, 'Fragments are not supported');
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_INBOUND)) return this.close(1009, 'Message too large');
        length = Number(big);
        offset = 10;
      }
      if (control && length > 125) return this.close(1002, 'Invalid control frame');
      if (!masked) return this.close(1002, 'Client frames must be masked');
      if (length > MAX_INBOUND) return this.close(1009, 'Message too large');
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) return this.close(1000, 'Closing');
      if (opcode === 0x9) this.writeFrame(0xA, payload);
      else if (opcode === 0xA) this.alive = true;
      else if (opcode !== 0x1) return this.close(1003, 'Unsupported frame');
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const reasonBytes = Buffer.from(String(reason)).subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try {
      if (this.socket.writable) this.socket.end(frame(0x8, payload));
      else this.socket.destroy();
    } catch {
      this.socket.destroy();
    }
    this.emit('close');
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

export class WebSocketHub {
  constructor({
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED,
  } = {}) {
    this.clients = new Set();
    this.maxBufferedBytes = maxBufferedBytes;
    this.heartbeatTimer = heartbeatIntervalMs > 0
      ? setInterval(() => this.heartbeat(), heartbeatIntervalMs)
      : null;
    this.heartbeatTimer?.unref();
  }

  accept(request, socket, head, { sessionId = null, isAuthorized = () => true } = {}) {
    if (this.clients.size >= 100 || !validHandshake(request)) return false;
    const key = request.headers['sec-websocket-key'].trim();
    const accept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_MAGIC}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));
    const client = new WebSocketClient(socket, {
      sessionId,
      isAuthorized,
      maxBufferedBytes: this.maxBufferedBytes,
    });
    this.clients.add(client);
    client.once('close', () => this.clients.delete(client));
    if (head?.length) client.consume(head);
    return client;
  }

  broadcast(event) {
    for (const client of [...this.clients]) client.send(event);
  }

  heartbeat() {
    for (const client of [...this.clients]) {
      if (!client.isAuthorized()) {
        client.close(4001, 'Session expired');
      } else if (!client.alive) {
        client.close(1001, 'Heartbeat timeout');
      } else {
        client.alive = false;
        client.ping();
      }
    }
  }

  closeSession(sessionId, code = 4001, reason = 'Session ended') {
    if (!sessionId) return;
    for (const client of [...this.clients]) {
      if (client.sessionId === sessionId) client.close(code, reason);
    }
  }

  closeAll() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of [...this.clients]) client.close(1001, 'Server shutting down');
  }
}
