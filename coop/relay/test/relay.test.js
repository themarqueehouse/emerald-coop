'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { Relay } = require('../server');
const proto = require('../protocol');

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Start a relay on an ephemeral port. */
async function startRelay() {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  return { relay, port };
}

/**
 * A test client that records every message in arrival order, so a test can
 * wait for a condition rather than guess at timing.
 */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = 'nodebuffer';
  const control = [];
  const frames = [];
  const waiters = [];

  function pump() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate()) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) frames.push(proto.decodeServerFrame(data));
    else control.push(JSON.parse(data.toString('utf8')));
    pump();
  });

  const client = {
    ws,
    control,
    frames,
    open: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    /** Resolve once `predicate()` is true, or reject after `ms`. */
    until(predicate, ms = 2000, label = 'condition') {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          reject(
            new Error(
              `timeout waiting for ${label}; control=${JSON.stringify(control)} frames=${frames.length}`
            )
          );
        }, ms);
        waiters.push(w);
      });
    },
    lastControl(type) {
      return [...control].reverse().find((m) => m.t === type);
    },
    join(session, extra = {}) {
      ws.send(
        JSON.stringify({ t: proto.MSG_JOIN, v: proto.NET_PROTOCOL_VERSION, session, ...extra })
      );
    },
    sendFrame(seq, words) {
      const cmd = Buffer.alloc(proto.CMD_BYTES);
      words.forEach((w, i) => cmd.writeUInt16LE(w, i * 2));
      ws.send(proto.encodeClientFrame(seq, cmd));
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', resolve);
        ws.close();
      });
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// protocol round-trips
// ---------------------------------------------------------------------------

test('client frame round-trips', () => {
  const cmd = Buffer.alloc(proto.CMD_BYTES);
  for (let i = 0; i < proto.CMD_LENGTH; i++) cmd.writeUInt16LE(0x1000 + i, i * 2);

  const decoded = proto.decodeClientFrame(proto.encodeClientFrame(1234, cmd));
  assert.equal(decoded.seq, 1234);
  assert.deepEqual([...decoded.cmd], [...cmd]);
});

test('server frame round-trips and carries playerId', () => {
  const cmd = Buffer.alloc(proto.CMD_BYTES, 0xab);
  const decoded = proto.decodeServerFrame(proto.encodeServerFrame(1, 7, cmd));
  assert.equal(decoded.playerId, 1);
  assert.equal(decoded.seq, 7);
  assert.deepEqual([...decoded.cmd], [...cmd]);
});

test('seq wraps at 16 bits rather than throwing', () => {
  const cmd = Buffer.alloc(proto.CMD_BYTES);
  const decoded = proto.decodeClientFrame(proto.encodeClientFrame(0x10000 + 5, cmd));
  assert.equal(decoded.seq, 5);
});

test('malformed frames decode to null, never throw', () => {
  assert.equal(proto.decodeClientFrame(Buffer.alloc(4)), null);
  assert.equal(proto.decodeClientFrame(Buffer.alloc(100)), null);
  assert.equal(proto.decodeClientFrame('not a buffer'), null);
  assert.equal(proto.decodeServerFrame(Buffer.alloc(0)), null);
});

test('session codes are validated', () => {
  assert.ok(proto.isValidSessionCode('ABCD'));
  assert.ok(proto.isValidSessionCode('HOENN123'));
  assert.ok(!proto.isValidSessionCode('abc'), 'too short');
  assert.ok(!proto.isValidSessionCode('abcd'), 'lowercase');
  assert.ok(!proto.isValidSessionCode('ABC-DEF'), 'punctuation');
  assert.ok(!proto.isValidSessionCode('A'.repeat(13)), 'too long');
  assert.ok(!proto.isValidSessionCode(null));
});

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

test('two players pair into slots 0 and 1 and reach READY', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('HOENN');
  await a.until(() => a.lastControl(proto.MSG_HELLO), 2000, 'hello A');

  const helloA = a.lastControl(proto.MSG_HELLO);
  assert.equal(helloA.localId, 0);
  assert.equal(helloA.status, proto.HOST_CONNECTING, 'alone means CONNECTING');

  const b = connect(port);
  await b.open;
  b.join('HOENN');
  await b.until(() => b.lastControl(proto.MSG_HELLO), 2000, 'hello B');

  assert.equal(b.lastControl(proto.MSG_HELLO).localId, 1);

  // Both sides must learn the session went READY.
  await a.until(
    () => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_READY,
    2000,
    'A sees READY'
  );
  await b.until(
    () => b.lastControl(proto.MSG_STATUS)?.status === proto.HOST_READY,
    2000,
    'B sees READY'
  );

  assert.equal(relay.stats().players, 2);

  await a.close();
  await b.close();
});

test('session codes are case-insensitive', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('hoenn');
  await a.until(() => a.lastControl(proto.MSG_HELLO));

  const b = connect(port);
  await b.open;
  b.join('HoEnN');
  await b.until(() => b.lastControl(proto.MSG_HELLO));

  // Same session, not two.
  assert.equal(relay.stats().sessions, 1);
  assert.equal(b.lastControl(proto.MSG_HELLO).localId, 1);

  await a.close();
  await b.close();
});

test('players in different sessions never see each other', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('AAAA');
  b.join('BBBB');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  await b.until(() => b.lastControl(proto.MSG_HELLO));

  // Both are slot 0 of their own session.
  assert.equal(a.lastControl(proto.MSG_HELLO).localId, 0);
  assert.equal(b.lastControl(proto.MSG_HELLO).localId, 0);
  assert.equal(relay.stats().sessions, 2);

  a.sendFrame(1, [0xdead, 0, 0, 0, 0, 0, 0, 0]);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(b.frames.length, 0, 'no cross-session leakage');

  await a.close();
  await b.close();
});

test('a third player is refused', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('FULL');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  b.join('FULL');
  await b.until(() => b.lastControl(proto.MSG_HELLO));

  const c = connect(port);
  await c.open;
  c.join('FULL');
  await c.until(() => c.lastControl(proto.MSG_ERROR), 2000, 'error for C');

  assert.equal(c.lastControl(proto.MSG_ERROR).code, proto.ERR_SESSION_FULL);

  await a.close();
  await b.close();
  await c.close();
});

test('an explicit slot request is honoured, and a taken slot refused', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  // Player 1 owns the save, so it must be able to reclaim slot 0 specifically.
  const a = connect(port);
  await a.open;
  a.join('SLOT', { slot: 1 });
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  assert.equal(a.lastControl(proto.MSG_HELLO).localId, 1, 'got requested slot');

  const b = connect(port);
  await b.open;
  b.join('SLOT', { slot: 1 });
  await b.until(() => b.lastControl(proto.MSG_ERROR));
  assert.equal(b.lastControl(proto.MSG_ERROR).code, proto.ERR_SLOT_TAKEN);

  const c = connect(port);
  await c.open;
  c.join('SLOT', { slot: 0 });
  await c.until(() => c.lastControl(proto.MSG_HELLO));
  assert.equal(c.lastControl(proto.MSG_HELLO).localId, 0);

  await a.close();
  await c.close();
});

// ---------------------------------------------------------------------------
// frame relay
// ---------------------------------------------------------------------------

test('frames reach the peer intact, tagged with the sender', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('RELAY');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  b.join('RELAY');
  await b.until(() => b.lastControl(proto.MSG_HELLO));

  const words = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888];
  a.sendFrame(42, words);

  await b.until(() => b.frames.length >= 1, 2000, 'B receives a frame');

  const got = b.frames[0];
  assert.equal(got.playerId, 0, 'tagged as from slot 0');
  assert.equal(got.seq, 42);
  for (let i = 0; i < proto.CMD_LENGTH; i++) {
    assert.equal(got.cmd.readUInt16LE(i * 2), words[i], `word ${i}`);
  }

  // A sender must not be echoed its own frame: the wrapper loops back locally,
  // and a server echo would double-fill the local ring.
  assert.equal(a.frames.length, 0, 'no echo to sender');

  await a.close();
  await b.close();
});

test('frames flow both directions and preserve order', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('BOTH');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  b.join('BOTH');
  await b.until(() => b.lastControl(proto.MSG_HELLO));

  const N = 30;
  for (let i = 0; i < N; i++) {
    a.sendFrame(i, [i, 0, 0, 0, 0, 0, 0, 0]);
    b.sendFrame(i, [0xf000 + i, 0, 0, 0, 0, 0, 0, 0]);
  }

  await b.until(() => b.frames.length >= N, 4000, `B receives ${N}`);
  await a.until(() => a.frames.length >= N, 4000, `A receives ${N}`);

  for (let i = 0; i < N; i++) {
    assert.equal(b.frames[i].seq, i, `B frame ${i} in order`);
    assert.equal(b.frames[i].cmd.readUInt16LE(0), i);
    assert.equal(a.frames[i].playerId, 1, 'A sees frames from slot 1');
    assert.equal(a.frames[i].cmd.readUInt16LE(0), 0xf000 + i);
  }

  await a.close();
  await b.close();
});

test('frames sent with no peer are dropped, not queued', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('ALONE');
  await a.until(() => a.lastControl(proto.MSG_HELLO));

  for (let i = 0; i < 10; i++) a.sendFrame(i, [i, 0, 0, 0, 0, 0, 0, 0]);
  await new Promise((r) => setTimeout(r, 150));

  // The peer joins afterwards and must NOT receive the backlog: those frames
  // belong to link time that has already passed.
  const b = connect(port);
  await b.open;
  b.join('ALONE');
  await b.until(() => b.lastControl(proto.MSG_HELLO));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(b.frames.length, 0, 'no stale frames delivered');

  await a.close();
  await b.close();
});

// ---------------------------------------------------------------------------
// failure handling
// ---------------------------------------------------------------------------

test('a dropout is reported as HOST_LOST, not CONNECTING', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('DROP');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  b.join('DROP');
  await a.until(
    () => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_READY,
    2000,
    'READY first'
  );

  await b.close();

  // This distinction is what lets the game say "your partner disconnected"
  // instead of "waiting for player 2".
  await a.until(
    () => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_LOST,
    2000,
    'A sees LOST'
  );
  assert.equal(a.lastControl(proto.MSG_STATUS).peerPresent, false);

  await a.close();
});

test('version skew is refused at the door', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.ws.send(JSON.stringify({ t: proto.MSG_JOIN, v: 999, session: 'VER' }));
  await a.until(() => a.lastControl(proto.MSG_ERROR));

  assert.equal(a.lastControl(proto.MSG_ERROR).code, proto.ERR_BAD_VERSION);
  assert.equal(relay.stats().sessions, 0, 'no session created');

  await a.close();
});

test('a bad session code is refused', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('no!');
  await a.until(() => a.lastControl(proto.MSG_ERROR));
  assert.equal(a.lastControl(proto.MSG_ERROR).code, proto.ERR_BAD_SESSION);

  await a.close();
});

test('a frame before join is refused without killing the socket', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.sendFrame(1, [1, 0, 0, 0, 0, 0, 0, 0]);
  await a.until(() => a.lastControl(proto.MSG_ERROR));
  assert.equal(a.lastControl(proto.MSG_ERROR).code, proto.ERR_MALFORMED);

  // Still usable: a client that made one mistake should be able to recover.
  a.join('AFTER');
  await a.until(() => a.lastControl(proto.MSG_HELLO), 2000, 'join still works');
  assert.equal(a.lastControl(proto.MSG_HELLO).localId, 0);

  await a.close();
});

test('a wrong-sized frame is refused', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('SIZE');
  await a.until(() => a.lastControl(proto.MSG_HELLO));

  a.ws.send(Buffer.alloc(7));
  await a.until(() => a.lastControl(proto.MSG_ERROR));
  assert.equal(a.lastControl(proto.MSG_ERROR).code, proto.ERR_MALFORMED);

  await a.close();
});

test('garbage text does not crash the relay', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.ws.send('{{{not json');
  await a.until(() => a.lastControl(proto.MSG_ERROR));
  assert.equal(a.lastControl(proto.MSG_ERROR).code, proto.ERR_MALFORMED);

  a.ws.send(JSON.stringify({ t: 'nonsense' }));
  await a.until(() => a.control.filter((m) => m.t === proto.MSG_ERROR).length >= 2);

  // Relay is alive and still serving.
  a.join('ALIVE');
  await a.until(() => a.lastControl(proto.MSG_HELLO));

  await a.close();
});

test('ping is answered with the caller timestamp echoed', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.ws.send(JSON.stringify({ t: proto.MSG_PING, ts: 12345 }));
  await a.until(() => a.lastControl(proto.MSG_PONG));
  assert.equal(a.lastControl(proto.MSG_PONG).ts, 12345, 'echoes ts for RTT math');

  await a.close();
});

test('empty sessions are reaped', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  await a.open;
  a.join('REAP');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  assert.equal(relay.stats().sessions, 1);

  await a.close();
  // Give the close handler a tick.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(relay.stats().sessions, 0, 'session cleaned up');
});

test('a slot freed by a dropout can be reclaimed', async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());

  const a = connect(port);
  const b = connect(port);
  await Promise.all([a.open, b.open]);
  a.join('RECON');
  await a.until(() => a.lastControl(proto.MSG_HELLO));
  b.join('RECON');
  await a.until(() => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_READY);

  await b.close();
  await a.until(() => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_LOST);

  // Reconnect into the same slot and the session must go READY again.
  const b2 = connect(port);
  await b2.open;
  b2.join('RECON', { slot: 1 });
  await b2.until(() => b2.lastControl(proto.MSG_HELLO));
  assert.equal(b2.lastControl(proto.MSG_HELLO).localId, 1);

  await a.until(
    () => a.lastControl(proto.MSG_STATUS)?.status === proto.HOST_READY,
    2000,
    'A sees READY again'
  );

  // And traffic resumes.
  a.sendFrame(99, [0xbeef, 0, 0, 0, 0, 0, 0, 0]);
  await b2.until(() => b2.frames.length >= 1, 2000, 'reconnected peer gets frames');
  assert.equal(b2.frames[0].cmd.readUInt16LE(0), 0xbeef);

  await a.close();
  await b2.close();
});
