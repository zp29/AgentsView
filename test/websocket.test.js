import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocketHub } from '../src/websocket.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writableLength = 0;
    this.writeResult = true;
    this.writes = [];
    this.ended = false;
    this.destroyed = false;
  }

  setNoDelay() {}

  write(value) {
    this.writes.push(Buffer.from(value));
    return this.writeResult;
  }

  end(value) {
    if (value) this.writes.push(Buffer.from(value));
    this.writable = false;
    this.ended = true;
    this.emit('close');
  }

  destroy() {
    this.writable = false;
    this.destroyed = true;
    this.emit('close');
  }
}

function upgradeRequest(overrides = {}) {
  return {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
      ...overrides,
    },
  };
}

function closeCode(socket) {
  const message = socket.writes.at(-1);
  assert.equal(message[0] & 0x0f, 0x8);
  return message.readUInt16BE(2);
}

test('validates the complete WebSocket handshake', () => {
  const hub = new WebSocketHub({ heartbeatIntervalMs: 0 });
  const socket = new FakeSocket();
  const client = hub.accept(upgradeRequest(), socket, Buffer.alloc(0));
  assert.ok(client);
  assert.match(socket.writes[0].toString(), /^HTTP\/1\.1 101 Switching Protocols/);

  for (const request of [
    upgradeRequest({ 'sec-websocket-key': 'not-base64' }),
    upgradeRequest({ 'sec-websocket-version': '12' }),
    upgradeRequest({ connection: 'keep-alive' }),
    { ...upgradeRequest(), method: 'POST' },
  ]) {
    assert.equal(hub.accept(request, new FakeSocket(), Buffer.alloc(0)), false);
  }
  hub.closeAll();
});

test('closes every socket tied to a revoked session only', () => {
  const hub = new WebSocketHub({ heartbeatIntervalMs: 0 });
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  hub.accept(upgradeRequest(), firstSocket, Buffer.alloc(0), { sessionId: 'one' });
  hub.accept(upgradeRequest(), secondSocket, Buffer.alloc(0), { sessionId: 'two' });

  hub.closeSession('one');
  assert.equal(firstSocket.ended, true);
  assert.equal(closeCode(firstSocket), 4001);
  assert.equal(secondSocket.ended, false);
  assert.equal(hub.clients.size, 1);
  hub.closeAll();
});

test('heartbeat closes expired sessions and unresponsive clients', () => {
  const expiredHub = new WebSocketHub({ heartbeatIntervalMs: 0 });
  const expiredSocket = new FakeSocket();
  expiredHub.accept(upgradeRequest(), expiredSocket, Buffer.alloc(0), { isAuthorized: () => false });
  expiredHub.heartbeat();
  assert.equal(closeCode(expiredSocket), 4001);

  const idleHub = new WebSocketHub({ heartbeatIntervalMs: 0 });
  const idleSocket = new FakeSocket();
  idleHub.accept(upgradeRequest(), idleSocket, Buffer.alloc(0));
  idleHub.heartbeat();
  assert.equal(idleSocket.writes.at(-1)[0] & 0x0f, 0x9);
  assert.equal(idleSocket.ended, false);
  idleHub.heartbeat();
  assert.equal(closeCode(idleSocket), 1001);
});

test('disconnects clients that exceed the outbound buffer budget', () => {
  const hub = new WebSocketHub({ heartbeatIntervalMs: 0, maxBufferedBytes: 64 });
  const socket = new FakeSocket();
  const client = hub.accept(upgradeRequest(), socket, Buffer.alloc(0));
  socket.writableLength = 64;

  assert.equal(client.send({ type: 'state.changed' }), false);
  assert.equal(socket.ended, true);
  assert.equal(closeCode(socket), 1013);
});

test('disconnects when another message arrives while a write is backpressured', () => {
  const hub = new WebSocketHub({ heartbeatIntervalMs: 0 });
  const socket = new FakeSocket();
  const client = hub.accept(upgradeRequest(), socket, Buffer.alloc(0));
  socket.writeResult = false;

  assert.equal(client.send({ sequence: 1 }), true);
  assert.equal(client.send({ sequence: 2 }), false);
  assert.equal(closeCode(socket), 1013);
});
