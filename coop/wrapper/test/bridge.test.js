'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { Mailbox, RING_CAPACITY } from '../src/mailbox.js';
import { Bridge, HOST_CONNECTING, HOST_READY, HOST_LOST, MAX_PEER_BACKLOG } from '../src/bridge.js';
import { RomSim, initMailbox, wordsToBytes, bytesToWords } from './rom-sim.js';

const HEAP_BYTES = 128 * 1024;
const AT = 0x4000;

/** A transport that records what was sent, standing in for the net client. */
function fakeLink() {
  const sent = [];
  return { sent, send: (cmd) => sent.push(cmd) };
}

function makeConsole(offset = AT) {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  initMailbox(buffer, offset);
  const mailbox = new Mailbox(buffer, offset);
  const rom = new RomSim(buffer, offset);
  const link = fakeLink();
  const events = [];
  const bridge = new Bridge({ mailbox, link, onEvent: (e) => events.push(e) });
  return { buffer, mailbox, rom, link, bridge, events };
}

function cmd(n) {
  return [n & 0xffff, 0, 0, 0, 0, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// gating and identity
// ---------------------------------------------------------------------------

test('the bridge does not pump until the session is READY', () => {
  const c = makeConsole();
  c.bridge.setStatus(HOST_CONNECTING);
  c.rom.sendCmd(cmd(1));

  const r = c.bridge.pump();
  assert.deepEqual(r, { sent: 0, delivered: 0, stalled: false });
  assert.equal(c.link.sent.length, 0, 'nothing goes on the wire before READY');
  assert.equal(c.mailbox.outPending, 1, 'and the frame stays with the ROM');
});

test('identity sets the peer id and is published to the ROM', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 1, playerCount: 2 });

  assert.equal(c.bridge.peerId, 0, 'peer is the other slot');
  assert.equal(c.mailbox.localId, 1, 'ROM can read its own id');
  assert.equal(c.rom.playerCount, 2);
});

test('becoming READY clears stale link time', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_CONNECTING);

  // Rubbish left over from a previous, abandoned session.
  c.rom.sendCmd(cmd(99));
  c.bridge.onPeerFrame(wordsToBytes(cmd(98)));

  c.bridge.setStatus(HOST_READY);

  assert.equal(c.mailbox.outPending, 0, 'rings reset');
  assert.equal(c.bridge.peerQueue.length, 0, 'peer queue dropped');
  assert.ok(c.events.some((e) => e.type === 'session-ready'));
});

test('losing the peer is reported once', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);
  c.bridge.setStatus(HOST_LOST);
  c.bridge.setStatus(HOST_LOST);

  assert.equal(c.events.filter((e) => e.type === 'peer-lost').length, 1);
});

// ---------------------------------------------------------------------------
// the basic loop
// ---------------------------------------------------------------------------

test('a ROM command is sent on the wire and looped back locally', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  c.rom.sendCmd(cmd(0x1234));
  const r = c.bridge.pump();

  assert.equal(r.sent, 1);
  assert.equal(c.link.sent.length, 1, 'went to the relay');
  assert.deepEqual(bytesToWords(c.link.sent[0]), cmd(0x1234));
  assert.equal(c.mailbox.inPending(0), 1, 'and into our own ring by loopback');
  assert.equal(c.mailbox.inPending(1), 0, 'peer ring still empty');

  // Lockstep: the ROM must not advance on our frame alone.
  assert.equal(c.rom.recvCmds(), null);
});

test('a peer frame completes the link frame', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  c.rom.sendCmd(cmd(0xaaa));
  c.bridge.pump();
  c.bridge.onPeerFrame(wordsToBytes(cmd(0xbbb)));
  const r = c.bridge.pump();

  assert.equal(r.delivered, 1);

  const got = c.rom.recvCmds();
  assert.ok(got, 'both rings populated, link advances');
  assert.equal(got[0][0], 0xaaa, 'slot 0 is us');
  assert.equal(got[1][0], 0xbbb, 'slot 1 is the peer');
});

test('an all-zero ROM frame never reaches the wire', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  c.rom.sendCmd([0, 0, 0, 0, 0, 0, 0, 0]);
  c.bridge.pump();

  assert.equal(c.link.sent.length, 0);
});

// ---------------------------------------------------------------------------
// backpressure: the bug this design exists to avoid
// ---------------------------------------------------------------------------

test('a lagging peer stalls the drain instead of dropping our own frames', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  // The peer sends nothing at all. We keep producing.
  let stalls = 0;
  for (let i = 0; i < 40; i++) {
    c.rom.sendCmd(cmd(i + 1));
    if (c.bridge.pump().stalled) stalls++;
  }

  assert.ok(stalls > 0, 'the bridge stalled rather than racing ahead');
  // The critical invariant: we never lost a frame of our own. Every frame we
  // put on the wire is also in our own ring, because the peer has it and we
  // must end the link frame in the same state they do.
  assert.equal(
    c.bridge.stats.sentFrames,
    c.bridge.stats.loopbackFrames,
    'every sent frame was also looped back'
  );
  assert.equal(
    c.events.filter((e) => e.type === 'loopback-lost').length,
    0,
    'no frame of ours was ever dropped'
  );
  assert.ok(c.mailbox.inPending(0) <= RING_CAPACITY, 'local ring never overrun');
});

test('backpressure reaches the ROM as a full send ring', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  // Peer silent; produce far more than either ring can hold.
  for (let i = 0; i < 60; i++) {
    c.rom.sendCmd(cmd(i + 1));
    c.bridge.pump();
  }

  // The game learns about the stall through its own mechanism, which is what
  // makes it throttle the overworld rather than desync.
  assert.equal(c.rom.queueFull, 1, 'ROM raised queueFull');
});

test('the stall clears once the peer catches up', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  for (let i = 0; i < 20; i++) {
    c.rom.sendCmd(cmd(i + 1));
    c.bridge.pump();
  }
  assert.ok(c.bridge.stats.stalledPumps > 0);

  // Peer floods in; the ROM drains both rings and we resume.
  for (let i = 0; i < 20; i++) c.bridge.onPeerFrame(wordsToBytes(cmd(0x500 + i)));

  let advanced = 0;
  for (let i = 0; i < 40; i++) {
    c.bridge.pump();
    if (c.rom.recvCmds()) advanced++;
  }

  assert.ok(advanced > 0, 'link frames resumed');
  assert.equal(c.bridge.stats.sentFrames, c.bridge.stats.loopbackFrames);
});

test('a peer burst is absorbed in the JS queue, not dropped', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  // Far more than the 7-slot ring can hold, arriving at once.
  for (let i = 0; i < 50; i++) c.bridge.onPeerFrame(wordsToBytes(cmd(i + 1)));

  assert.equal(c.bridge.stats.peerDropped, 0, 'nothing discarded');
  c.bridge.pump();
  assert.equal(c.mailbox.inPending(1), RING_CAPACITY, 'ring filled to capacity');
  assert.equal(c.bridge.peerQueue.length, 50 - RING_CAPACITY, 'rest held in JS');
});

test('an unbounded peer backlog is capped and reported', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);

  for (let i = 0; i < MAX_PEER_BACKLOG + 25; i++) {
    c.bridge.onPeerFrame(wordsToBytes(cmd(i + 1)));
  }

  assert.equal(c.bridge.peerQueue.length, MAX_PEER_BACKLOG, 'queue is bounded');
  assert.equal(c.bridge.stats.peerDropped, 25);
  assert.equal(
    c.events.filter((e) => e.type === 'peer-backlog-overflow').length,
    1,
    'reported once, not per frame'
  );
});

// ---------------------------------------------------------------------------
// two consoles, end to end
// ---------------------------------------------------------------------------

/**
 * Wire two bridges together through a relay that can delay delivery, and run
 * both ROMs for N frames. The assertion that matters is that the two consoles
 * consume an identical sequence of link frames: that is precisely what "not
 * desynced" means.
 */
function runSession({ frames, jitter }) {
  const a = makeConsole(0x2000);
  const b = makeConsole(0x6000);

  a.bridge.setIdentity({ localId: 0, playerCount: 2 });
  b.bridge.setIdentity({ localId: 1, playerCount: 2 });
  a.bridge.setStatus(HOST_READY);
  b.bridge.setStatus(HOST_READY);

  // The relay: frames in flight, each with a tick at which it lands.
  //
  // Arrival times are clamped to be monotonic per destination. A WebSocket runs
  // over TCP, so frames are ordered and reliable -- a later frame can never
  // overtake an earlier one. Letting jitter reorder them would be testing
  // against a network that cannot exist, and no lockstep scheme survives
  // reordering without sequence numbers and a reassembly buffer we have
  // deliberately not built.
  let inFlight = [];
  const lastArrival = new Map();
  // Patch the links to route into the relay rather than a bin.
  a.link.send = (c) => inFlight.push({ to: b, at: 0, cmd: c });
  b.link.send = (c) => inFlight.push({ to: a, at: 0, cmd: c });

  const seqA = [];
  const seqB = [];
  // Commands the ROM wants to send but the full ring refused; the real game
  // retains gSendCmd the same way.
  let pendingA = null;
  let pendingB = null;

  for (let tick = 0; tick < frames; tick++) {
    // Deliver anything whose time has come.
    const due = inFlight.filter((f) => f.at <= tick);
    inFlight = inFlight.filter((f) => f.at > tick);
    for (const f of due) f.to.bridge.onPeerFrame(f.cmd);

    // Each ROM produces one command per frame.
    const wantA = pendingA ?? cmd(0x1000 + tick);
    const wantB = pendingB ?? cmd(0x2000 + tick);
    pendingA = a.rom.sendCmd(wantA)[0] !== 0 ? wantA : null;
    pendingB = b.rom.sendCmd(wantB)[0] !== 0 ? wantB : null;

    // Pump, then stamp arrival times with jitter for anything newly sent.
    const beforeA = inFlight.length;
    a.bridge.pump();
    b.bridge.pump();
    for (let i = beforeA; i < inFlight.length; i++) {
      const f = inFlight[i];
      const want = tick + 1 + jitter(tick, i);
      const prev = lastArrival.get(f.to) ?? -1;
      // Same-tick arrivals keep array order, so >= prev is enough to preserve
      // ordering without forcing an artificial gap.
      f.at = Math.max(want, prev);
      lastArrival.set(f.to, f.at);
    }

    const gotA = a.rom.recvCmds();
    const gotB = b.rom.recvCmds();
    if (gotA) seqA.push(gotA);
    if (gotB) seqB.push(gotB);
  }

  return { a, b, seqA, seqB };
}

test('two consoles stay in lockstep with a steady link', () => {
  const { a, b, seqA, seqB } = runSession({ frames: 200, jitter: () => 0 });

  assert.ok(seqA.length > 100, `made progress (${seqA.length} link frames)`);
  const n = Math.min(seqA.length, seqB.length);
  assert.ok(Math.abs(seqA.length - seqB.length) <= 1, 'consoles within one frame');

  for (let i = 0; i < n; i++) {
    assert.deepEqual(seqA[i], seqB[i], `link frame ${i} identical on both consoles`);
  }
  assert.equal(a.bridge.stats.sentFrames, a.bridge.stats.loopbackFrames);
  assert.equal(b.bridge.stats.sentFrames, b.bridge.stats.loopbackFrames);
});

test('two consoles stay in lockstep with a jittery link', () => {
  // Deliberately uneven: one side's frames sometimes take several ticks, which
  // is what a phone on cell data actually does.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const { seqA, seqB } = runSession({
    frames: 400,
    jitter: () => Math.floor(rand() * 5),
  });

  assert.ok(seqA.length > 50, `made progress under jitter (${seqA.length} frames)`);
  const n = Math.min(seqA.length, seqB.length);
  for (let i = 0; i < n; i++) {
    assert.deepEqual(seqA[i], seqB[i], `link frame ${i} identical despite jitter`);
  }
});

test('two consoles stay in lockstep when one side stalls hard', () => {
  // One long freeze, as if a phone backgrounded the tab for a moment.
  const { seqA, seqB } = runSession({
    frames: 400,
    jitter: (tick) => (tick > 100 && tick < 140 ? 30 : 0),
  });

  const n = Math.min(seqA.length, seqB.length);
  assert.ok(n > 50, 'recovered after the freeze');
  for (let i = 0; i < n; i++) {
    assert.deepEqual(seqA[i], seqB[i], `link frame ${i} identical across the freeze`);
  }
});

test('no frame is ever lost on the local side, under any pacing', () => {
  for (const jitter of [() => 0, () => 3, (t) => t % 7]) {
    const { a, b } = runSession({ frames: 300, jitter });
    // This is the invariant that makes the whole scheme safe: what we put on
    // the wire and what we gave our own ROM are always the same set.
    assert.equal(a.bridge.stats.sentFrames, a.bridge.stats.loopbackFrames);
    assert.equal(b.bridge.stats.sentFrames, b.bridge.stats.loopbackFrames);
    assert.equal(a.events.filter((e) => e.type === 'loopback-lost').length, 0);
    assert.equal(b.events.filter((e) => e.type === 'loopback-lost').length, 0);
  }
});

test('snapshot exposes what a diagnostics overlay needs', () => {
  const c = makeConsole();
  c.bridge.setIdentity({ localId: 0, playerCount: 2 });
  c.bridge.setStatus(HOST_READY);
  c.rom.sendCmd(cmd(1));
  c.bridge.pump();

  const s = c.bridge.snapshot();
  assert.equal(s.status, HOST_READY);
  assert.equal(s.localId, 0);
  assert.equal(s.peerId, 1);
  assert.equal(s.stats.sentFrames, 1);
  assert.ok(s.mailbox.valid);
});
