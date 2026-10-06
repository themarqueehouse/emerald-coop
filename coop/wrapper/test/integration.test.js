'use strict';

// Full-stack test: the real relay, two real NetClients over real sockets, two
// real Bridges, two ROM simulators sharing bytes with two real Mailboxes.
//
// Everything in the co-op path is exercised here except the emulator itself
// and the UI. If this passes, the remaining risk is concentrated in the two
// things that genuinely cannot be tested from here: whether mGBA's heap layout
// is what we assume, and whether the page works on a phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Mailbox } from '../src/mailbox.js';
import { Bridge, HOST_READY } from '../src/bridge.js';
import { NetClient } from '../src/netclient.js';
import * as wire from '../src/wire.js';
import { RomSim, initMailbox } from './rom-sim.js';

const require = createRequire(import.meta.url);
const WebSocketImpl = require('ws');
const { Relay } = require('../../relay/server.js');
const relayProto = require('../../relay/protocol.js');

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const HEAP_BYTES = 128 * 1024;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for `fn()` to be true, polling, with a deadline. */
async function waitFor(fn, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// drift guard: the ESM codec must agree with the relay's CommonJS one
// ---------------------------------------------------------------------------

test('wire.js and the relay protocol agree on every constant', () => {
  assert.equal(wire.PROTOCOL_VERSION, relayProto.NET_PROTOCOL_VERSION);
  assert.equal(wire.CMD_BYTES, relayProto.CMD_BYTES);
  assert.equal(wire.C2S_FRAME_BYTES, relayProto.C2S_FRAME_BYTES);
  assert.equal(wire.S2C_FRAME_BYTES, relayProto.S2C_FRAME_BYTES);
  assert.equal(wire.SEQ_MODULO, relayProto.SEQ_MODULO);
  assert.equal(wire.MSG_JOIN, relayProto.MSG_JOIN);
  assert.equal(wire.MSG_HELLO, relayProto.MSG_HELLO);
  assert.equal(wire.MSG_STATUS, relayProto.MSG_STATUS);
  assert.equal(wire.MSG_ERROR, relayProto.MSG_ERROR);
  assert.equal(wire.MSG_PING, relayProto.MSG_PING);
  assert.equal(wire.MSG_PONG, relayProto.MSG_PONG);
});

test('wire.js and the relay protocol produce identical bytes', () => {
  const cmd = new Uint8Array(16);
  for (let i = 0; i < 16; i++) cmd[i] = i * 7;

  // Client encoding must be byte-identical or the relay would misparse it.
  const mine = wire.encodeFrame(0x1234, cmd);
  const theirs = relayProto.encodeClientFrame(0x1234, cmd);
  assert.deepEqual([...mine], [...theirs], 'client frame encoding');

  // And we must parse what the relay emits.
  const forwarded = relayProto.encodeServerFrame(1, 0x4321, cmd);
  const decoded = wire.decodeFrame(new Uint8Array(forwarded));
  assert.equal(decoded.playerId, 1);
  assert.equal(decoded.seq, 0x4321);
  assert.deepEqual([...decoded.cmd], [...cmd]);
});

test('decodeFrame returns null rather than throwing on junk', () => {
  assert.equal(wire.decodeFrame(new Uint8Array(0)), null);
  assert.equal(wire.decodeFrame(new Uint8Array(18)), null);
  assert.equal(wire.decodeFrame(new Uint8Array(64)), null);
});

// ---------------------------------------------------------------------------
// one full console: emulator-less, but everything else real
// ---------------------------------------------------------------------------

/** Build a console: heap + mailbox + ROM sim + bridge + live net client. */
function makeConsole({ port, session, slot, offset }) {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  initMailbox(buffer, offset);
  const mailbox = new Mailbox(buffer, offset);
  const rom = new RomSim(buffer, offset);
  const events = [];

  const bridge = new Bridge({
    mailbox,
    link: { send: (cmd) => client.send(cmd) },
    onEvent: (e) => events.push(e),
  });

  const client = new NetClient({
    url: `ws://127.0.0.1:${port}`,
    session,
    slot,
    WebSocketImpl,
    onFrame: (f) => bridge.onPeerFrame(f.cmd),
    onSession: ({ status, localId, playerCount }) => {
      bridge.setIdentity({ localId, playerCount });
      bridge.setStatus(status);
    },
    onEvent: (e) => events.push(e),
  });

  return { buffer, mailbox, rom, bridge, client, events };
}

test('two consoles pair through the real relay and exchange link frames', async (t) => {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  t.after(() => relay.close());

  const a = makeConsole({ port, session: 'LIVE', slot: 0, offset: 0x2000 });
  const b = makeConsole({ port, session: 'LIVE', slot: 1, offset: 0x6000 });
  t.after(() => {
    a.client.close();
    b.client.close();
  });

  a.client.connect();
  b.client.connect();

  await waitFor(() => a.bridge.status === HOST_READY, 'A ready');
  await waitFor(() => b.bridge.status === HOST_READY, 'B ready');

  assert.equal(a.bridge.localId, 0);
  assert.equal(b.bridge.localId, 1);
  // The ROM reads these straight out of the mailbox.
  assert.equal(a.mailbox.playerCount, 2);
  assert.equal(b.mailbox.playerCount, 2);

  // Each ROM emits one command, as the game does each frame.
  a.rom.sendCmd([0xa001, 1, 2, 3, 4, 5, 6, 7]);
  b.rom.sendCmd([0xb001, 7, 6, 5, 4, 3, 2, 1]);
  a.bridge.pump();
  b.bridge.pump();

  // Arrival lands the frame in the bridge's JS queue; only a pump moves it
  // into the mailbox. The game pumps every emulated frame, so wait for the
  // queue and then pump, rather than expecting the mailbox to fill by itself.
  await waitFor(() => a.bridge.peerQueue.length > 0, "B's frame reaches A");
  await waitFor(() => b.bridge.peerQueue.length > 0, "A's frame reaches B");

  a.bridge.pump();
  b.bridge.pump();

  assert.equal(a.mailbox.inPending(1), 1, "A's peer ring filled");
  assert.equal(b.mailbox.inPending(0), 1, "B's peer ring filled");

  const gotA = a.rom.recvCmds();
  const gotB = b.rom.recvCmds();

  assert.ok(gotA, 'A advanced a link frame');
  assert.ok(gotB, 'B advanced a link frame');
  // The whole point: both consoles end the link frame holding the same state.
  assert.deepEqual(gotA, gotB, 'identical link state across the network');
  assert.equal(gotA[0][0], 0xa001);
  assert.equal(gotA[1][0], 0xb001);
});

test('a sustained session stays in lockstep over hundreds of frames', async (t) => {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  t.after(() => relay.close());

  const a = makeConsole({ port, session: 'SUSTAIN', slot: 0, offset: 0x2000 });
  const b = makeConsole({ port, session: 'SUSTAIN', slot: 1, offset: 0x6000 });
  t.after(() => {
    a.client.close();
    b.client.close();
  });

  a.client.connect();
  b.client.connect();
  await waitFor(() => a.bridge.status === HOST_READY, 'A ready');
  await waitFor(() => b.bridge.status === HOST_READY, 'B ready');

  const seqA = [];
  const seqB = [];
  let pendingA = null;
  let pendingB = null;

  // 300 "frames". Real sockets mean real async delivery, so yield each tick.
  for (let tick = 0; tick < 300; tick++) {
    const wantA = pendingA ?? [0x1000 + (tick & 0xfff), 0, 0, 0, 0, 0, 0, 0];
    const wantB = pendingB ?? [0x2000 + (tick & 0xfff), 0, 0, 0, 0, 0, 0, 0];
    pendingA = a.rom.sendCmd(wantA)[0] !== 0 ? wantA : null;
    pendingB = b.rom.sendCmd(wantB)[0] !== 0 ? wantB : null;

    a.bridge.pump();
    b.bridge.pump();

    const gA = a.rom.recvCmds();
    const gB = b.rom.recvCmds();
    if (gA) seqA.push(gA);
    if (gB) seqB.push(gB);

    await sleep(1);
  }

  // Let anything still in flight land and be consumed.
  for (let i = 0; i < 60; i++) {
    a.bridge.pump();
    b.bridge.pump();
    const gA = a.rom.recvCmds();
    const gB = b.rom.recvCmds();
    if (gA) seqA.push(gA);
    if (gB) seqB.push(gB);
    await sleep(2);
  }

  assert.ok(seqA.length > 100, `A advanced ${seqA.length} link frames`);
  assert.ok(seqB.length > 100, `B advanced ${seqB.length} link frames`);

  const n = Math.min(seqA.length, seqB.length);
  for (let i = 0; i < n; i++) {
    assert.deepEqual(seqA[i], seqB[i], `link frame ${i} identical over the network`);
  }

  // The local-safety invariant must hold over a real socket too.
  assert.equal(a.bridge.stats.sentFrames, a.bridge.stats.loopbackFrames);
  assert.equal(b.bridge.stats.sentFrames, b.bridge.stats.loopbackFrames);
  assert.equal(a.events.filter((e) => e.type === 'loopback-lost').length, 0);
  assert.equal(b.events.filter((e) => e.type === 'loopback-lost').length, 0);
  assert.equal(a.bridge.stats.peerDropped, 0, 'no peer frames discarded');
  assert.equal(b.bridge.stats.peerDropped, 0);
});

test('a player alone never reaches READY, so the ROM will not start', async (t) => {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  t.after(() => relay.close());

  const a = makeConsole({ port, session: 'SOLO', slot: 0, offset: 0x2000 });
  t.after(() => a.client.close());

  a.client.connect();
  await waitFor(() => a.events.some((e) => e.type === 'joined'), 'joined');
  await sleep(100);

  // Two-players-required is the design decision that kills save divergence.
  assert.notEqual(a.bridge.status, HOST_READY, 'solo must not be READY');
  assert.equal(a.mailbox.playerCount, 1);

  a.rom.sendCmd([0x1234, 0, 0, 0, 0, 0, 0, 0]);
  a.bridge.pump();
  assert.equal(a.mailbox.outPending, 1, 'frame stays with the ROM');
  assert.equal(a.rom.recvCmds(), null, 'link never advances');
});

test('the surviving player is told the peer was lost, not that it never arrived', async (t) => {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  t.after(() => relay.close());

  const a = makeConsole({ port, session: 'LOST', slot: 0, offset: 0x2000 });
  const b = makeConsole({ port, session: 'LOST', slot: 1, offset: 0x6000 });
  t.after(() => a.client.close());

  a.client.connect();
  b.client.connect();
  await waitFor(() => a.bridge.status === HOST_READY, 'ready');

  b.client.close();

  await waitFor(() => a.events.some((e) => e.type === 'peer-lost'), 'A told peer lost');
  // HOST_LOST reaches the ROM, which surfaces it as a link error it already
  // knows how to report, rather than hanging forever.
  assert.equal(a.mailbox.hostStatus, 3 /* HOST_LOST */);
});

test('version skew is fatal and is not retried forever', async (t) => {
  const relay = new Relay({ port: 0, logger: silent });
  const port = await relay.listen();
  t.after(() => relay.close());

  const buffer = new ArrayBuffer(HEAP_BYTES);
  initMailbox(buffer, 0x2000);
  const events = [];
  const client = new NetClient({
    url: `ws://127.0.0.1:${port}`,
    session: 'SKEW',
    WebSocketImpl,
    onFrame: () => {},
    onSession: () => {},
    onEvent: (e) => events.push(e),
  });
  t.after(() => client.close());

  // Pretend to be a build that speaks a different protocol.
  const realOpen = client.open.bind(client);
  client.open = () => {
    realOpen();
    const ws = client.ws;
    const onopen = ws.onopen;
    ws.onopen = () => {
      void onopen;
      ws.send(JSON.stringify({ t: 'join', v: 999, session: 'SKEW' }));
    };
  };

  client.connect();
  await waitFor(() => events.some((e) => e.type === 'fatal'), 'fatal reported');

  const fatal = events.find((e) => e.type === 'fatal');
  assert.equal(fatal.code, 'bad_version');

  // Retrying a terminal protocol error would spin forever against a relay that
  // will refuse identically every time.
  await sleep(1200);
  assert.equal(
    events.filter((e) => e.type === 'reconnecting').length,
    0,
    'no reconnect attempts after a fatal error'
  );
});
