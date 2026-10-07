'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Mailbox,
  findMailbox,
  findAllMailboxes,
  pickLiveMailbox,
  MAGIC,
  OFF,
  CMD_BYTES,
  RING_SLOTS,
  RING_CAPACITY,
  MAILBOX_SIZE,
  HOST_READY,
  HOST_CONNECTING,
  HOST_DOWN,
} from '../src/mailbox.js';

import { RomSim, initMailbox, wordsToBytes, bytesToWords } from './rom-sim.js';

// A stand-in for the emulator heap, big enough that the mailbox is genuinely
// somewhere inside it rather than at offset 0.
const HEAP_BYTES = 256 * 1024;
const MAILBOX_AT = 0x1a3d8 & ~3; // roughly where the real build put it

function makeHeap(offset = MAILBOX_AT) {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  initMailbox(buffer, offset);
  return { buffer, offset };
}

function makePair(offset = MAILBOX_AT) {
  const { buffer } = makeHeap(offset);
  return {
    buffer,
    host: new Mailbox(buffer, offset),
    rom: new RomSim(buffer, offset),
  };
}

const WORDS_A = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888];
const ZEROS = [0, 0, 0, 0, 0, 0, 0, 0];

// ---------------------------------------------------------------------------
// locating the mailbox
// ---------------------------------------------------------------------------

test('findMailbox locates the mailbox by magic', () => {
  const { buffer, offset } = makeHeap();
  assert.equal(findMailbox(buffer), offset);
});

test('findMailbox returns null when there is no mailbox', () => {
  assert.equal(findMailbox(new ArrayBuffer(HEAP_BYTES)), null);
});

test('findMailbox returns null for a heap too small to hold one', () => {
  assert.equal(findMailbox(new ArrayBuffer(16)), null);
});

test('findMailbox rejects a bare magic word with no valid header', () => {
  // A stray 'COOP' in ROM data or a save state must not be mistaken for the
  // mailbox; the version and cursor checks are what prevent that.
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0x400, MAGIC, true); // magic, but version stays 0
  assert.equal(findMailbox(buffer), null);
});

test('findMailbox rejects a candidate with out-of-range ring cursors', () => {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0x800 + OFF.magic, MAGIC, true);
  view.setUint8(0x800 + OFF.version, 1);
  view.setUint8(0x800 + OFF.outHead, 99); // impossible for a 8-slot ring
  assert.equal(findMailbox(buffer), null);
});

test('findAllMailboxes reports an ambiguous scan', () => {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  initMailbox(buffer, 0x1000);
  initMailbox(buffer, 0x8000);
  assert.deepEqual(findAllMailboxes(buffer), [0x1000, 0x8000]);
});

test('a found mailbox reads as valid, a zeroed region does not', () => {
  const { buffer, offset } = makeHeap();
  assert.ok(new Mailbox(buffer, offset).valid);
  assert.ok(!new Mailbox(buffer, 0x200).valid);
});

// ---------------------------------------------------------------------------
// host-owned fields
// ---------------------------------------------------------------------------

test('the ROM sees session fields the host publishes', () => {
  const { rom, host } = makePair();
  assert.equal(host.hostStatus, HOST_DOWN, 'starts DOWN so a plain emulator reads as unsupported');

  host.setSession({ status: HOST_READY, localId: 1, playerCount: 2 });

  assert.equal(host.hostStatus, HOST_READY);
  assert.equal(host.localId, 1);
  assert.equal(rom.playerCount, 2);
});

test('playerCount is clamped to MAX_PLAYERS on the ROM side', () => {
  const { rom, host } = makePair();
  host.playerCount = 9;
  assert.equal(rom.playerCount, 2, 'ROM must never index past its arrays');
});

// ---------------------------------------------------------------------------
// outbox: ROM -> host
// ---------------------------------------------------------------------------

test('a command the ROM sends is drained by the host intact', () => {
  const { rom, host } = makePair();
  rom.sendCmd(WORDS_A);

  const frames = host.drainOutbox();
  assert.equal(frames.length, 1);
  assert.deepEqual(bytesToWords(frames[0]), WORDS_A);
  assert.equal(host.outPending, 0, 'drained');
});

test('an all-zero command is not transmitted', () => {
  const { rom, host } = makePair();
  rom.sendCmd(ZEROS);
  // This is the behaviour that makes command-counting state machines above the
  // transport run at the right rate; relaying the zeros would speed them up.
  assert.equal(host.drainOutbox().length, 0, 'zeros must never reach the wire');
});

test("the ROM's send buffer is cleared on accept and retained when full", () => {
  const { rom } = makePair();
  const after = rom.sendCmd(WORDS_A);
  assert.deepEqual(after, ZEROS, 'accepted command is consumed');

  // Fill the ring; capacity is RING_SLOTS - 1.
  const fresh = makePair();
  for (let i = 0; i < RING_CAPACITY; i++) {
    fresh.rom.sendCmd([i + 1, 0, 0, 0, 0, 0, 0, 0]);
  }
  const retained = fresh.rom.sendCmd(WORDS_A);
  assert.deepEqual(retained, WORDS_A, 'full ring leaves the command with the game');
  assert.equal(fresh.rom.queueFull, 1, 'and raises queueFull');
});

test('the outbox ring holds exactly RING_SLOTS - 1 commands', () => {
  const { rom, host } = makePair();
  for (let i = 0; i < RING_CAPACITY; i++) {
    rom.sendCmd([0xa000 + i, 0, 0, 0, 0, 0, 0, 0]);
  }
  assert.equal(host.outPending, RING_CAPACITY);

  rom.sendCmd([0xdead, 0, 0, 0, 0, 0, 0, 0]); // refused
  assert.equal(host.outPending, RING_CAPACITY, 'does not overrun');

  const frames = host.drainOutbox();
  assert.equal(frames.length, RING_CAPACITY);
  for (let i = 0; i < RING_CAPACITY; i++) {
    assert.equal(bytesToWords(frames[i])[0], 0xa000 + i, `frame ${i} in order`);
  }
});

test('the outbox wraps correctly over many cycles', () => {
  const { rom, host } = makePair();
  let expected = 1;

  // Several times round the ring, which is where off-by-one masking bugs show.
  for (let cycle = 0; cycle < 20; cycle++) {
    const batch = (cycle % RING_CAPACITY) + 1;
    for (let i = 0; i < batch; i++) rom.sendCmd([expected + i, 0, 0, 0, 0, 0, 0, 0]);

    const frames = host.drainOutbox();
    assert.equal(frames.length, batch, `cycle ${cycle} count`);
    for (let i = 0; i < batch; i++) {
      assert.equal(bytesToWords(frames[i])[0], expected + i, `cycle ${cycle} frame ${i}`);
    }
    expected += batch;
  }
});

test('drained frames are copies, not aliases into the heap', () => {
  const { rom, host } = makePair();
  rom.sendCmd(WORDS_A);
  const frame = host.drainOutbox()[0];

  // The ROM reuses the slot; a view would mutate under the socket's feet.
  rom.sendCmd([0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]);
  assert.deepEqual(bytesToWords(frame), WORDS_A, 'earlier frame unchanged');
});

// ---------------------------------------------------------------------------
// inbox: host -> ROM
// ---------------------------------------------------------------------------

test('nothing is delivered until every player has a frame', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  host.pushInbox(0, wordsToBytes([1, 0, 0, 0, 0, 0, 0, 0]));

  // This is the lockstep rule. One player's frame alone must not advance the
  // link, or the two games run at different link times and desync.
  assert.equal(rom.recvCmds(), null, 'half a frame delivers nothing');
  assert.ok(rom.receivedNothing);

  host.pushInbox(1, wordsToBytes([2, 0, 0, 0, 0, 0, 0, 0]));

  const got = rom.recvCmds();
  assert.ok(got, 'both present, so the link advances');
  assert.equal(got[0][0], 1);
  assert.equal(got[1][0], 2);
  assert.ok(!rom.receivedNothing);
});

test('frames are delivered in order across many link frames', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  const N = 5;
  for (let i = 0; i < N; i++) {
    host.pushInbox(0, wordsToBytes([0x100 + i, 0, 0, 0, 0, 0, 0, 0]));
    host.pushInbox(1, wordsToBytes([0x200 + i, 0, 0, 0, 0, 0, 0, 0]));
  }

  for (let i = 0; i < N; i++) {
    const got = rom.recvCmds();
    assert.ok(got, `frame ${i} delivered`);
    assert.equal(got[0][0], 0x100 + i);
    assert.equal(got[1][0], 0x200 + i);
  }
  assert.equal(rom.recvCmds(), null, 'and then nothing');
});

test('a full inbox ring is reported rather than overrunning', () => {
  const { host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  for (let i = 0; i < RING_CAPACITY; i++) {
    assert.ok(host.pushInbox(0, wordsToBytes([i, 0, 0, 0, 0, 0, 0, 0])), `push ${i}`);
  }
  assert.ok(host.inFull(0));
  assert.equal(
    host.pushInbox(0, wordsToBytes(WORDS_A)),
    false,
    'caller is told to drop, not silently corrupt'
  );
});

test('the two players have independent inbox rings', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  for (let i = 0; i < RING_CAPACITY; i++) {
    host.pushInbox(0, wordsToBytes([i, 0, 0, 0, 0, 0, 0, 0]));
  }
  assert.ok(host.inFull(0));
  assert.ok(!host.inFull(1), 'player 1 unaffected');
  assert.equal(host.inPending(1), 0);

  // A laggy peer fills one ring; the other must stay usable.
  assert.ok(host.pushInbox(1, wordsToBytes(WORDS_A)));
  assert.equal(host.inPending(1), 1);
  assert.equal(rom.recvCmds()[1][0], WORDS_A[0]);
});

test('the inbox wraps correctly over many cycles', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  let n = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    const batch = (cycle % RING_CAPACITY) + 1;
    for (let i = 0; i < batch; i++) {
      host.pushInbox(0, wordsToBytes([n + i, 0, 0, 0, 0, 0, 0, 0]));
      host.pushInbox(1, wordsToBytes([0x8000 + n + i, 0, 0, 0, 0, 0, 0, 0]));
    }
    for (let i = 0; i < batch; i++) {
      const got = rom.recvCmds();
      assert.ok(got, `cycle ${cycle} frame ${i}`);
      assert.equal(got[0][0], n + i);
      assert.equal(got[1][0], (0x8000 + n + i) & 0xffff);
    }
    n += batch;
  }
});

test('pushInbox rejects a bad player id and a wrong-sized command', () => {
  const { host } = makePair();
  assert.throws(() => host.pushInbox(2, wordsToBytes(WORDS_A)), RangeError);
  assert.throws(() => host.pushInbox(-1, wordsToBytes(WORDS_A)), RangeError);
  assert.throws(() => host.pushInbox(0, new Uint8Array(4)), RangeError);
});

// ---------------------------------------------------------------------------
// full round trip and housekeeping
// ---------------------------------------------------------------------------

test('a command survives the whole loop: ROM -> host -> peer -> ROM', () => {
  // Two independent "consoles", each with its own heap, wired through what the
  // relay would do. This is the end-to-end path a real session takes.
  const a = makePair(0x1000);
  const b = makePair(0x9000);

  for (const side of [a, b]) {
    side.host.setSession({ status: HOST_READY, playerCount: 2 });
  }
  a.host.localId = 0;
  b.host.localId = 1;

  const fromA = [0xcafe, 1, 2, 3, 4, 5, 6, 7];
  const fromB = [0xbeef, 7, 6, 5, 4, 3, 2, 1];

  a.rom.sendCmd(fromA);
  b.rom.sendCmd(fromB);

  // Each host drains its ROM and ships the frame to the peer, while looping its
  // own frame back locally — exactly the split the relay tests assert.
  const aOut = a.host.drainOutbox();
  const bOut = b.host.drainOutbox();
  assert.equal(aOut.length, 1);
  assert.equal(bOut.length, 1);

  a.host.pushInbox(0, aOut[0]); // local loopback
  a.host.pushInbox(1, bOut[0]); // from relay
  b.host.pushInbox(1, bOut[0]); // local loopback
  b.host.pushInbox(0, aOut[0]); // from relay

  const gotA = a.rom.recvCmds();
  const gotB = b.rom.recvCmds();

  // Both consoles must see an identical view of this link frame.
  assert.deepEqual(gotA[0], fromA);
  assert.deepEqual(gotA[1], fromB);
  assert.deepEqual(gotB[0], fromA);
  assert.deepEqual(gotB[1], fromB);
  assert.deepEqual(gotA, gotB, 'identical link state on both sides');
});

test('resetRings discards stale link time', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 0, playerCount: 2 });

  rom.sendCmd(WORDS_A);
  host.pushInbox(0, wordsToBytes(WORDS_A));
  host.pushInbox(1, wordsToBytes(WORDS_A));

  host.resetRings();

  assert.equal(host.outPending, 0);
  assert.equal(host.inPending(0), 0);
  assert.equal(host.inPending(1), 0);
  assert.equal(rom.recvCmds(), null, 'nothing carried over a reconnect');
});

test('rebind survives a heap the emulator has replaced', () => {
  const { buffer, offset } = makeHeap();
  const host = new Mailbox(buffer, offset);
  host.setSession({ status: HOST_CONNECTING, localId: 0, playerCount: 1 });

  // WASM memory growth hands us a new, larger buffer; the old views are dead.
  const grown = new ArrayBuffer(HEAP_BYTES * 2);
  new Uint8Array(grown).set(new Uint8Array(buffer));
  host.rebind(grown);

  assert.ok(host.valid, 'still pointed at a real mailbox');
  assert.equal(host.hostStatus, HOST_CONNECTING, 'state carried over');
  host.hostStatus = HOST_READY;
  assert.equal(new Mailbox(grown, offset).hostStatus, HOST_READY, 'writes land in the new heap');
});

test('snapshot reports the state a diagnostics panel needs', () => {
  const { rom, host } = makePair();
  host.setSession({ status: HOST_READY, localId: 1, playerCount: 2 });
  rom.sendCmd(WORDS_A);
  host.pushInbox(0, wordsToBytes(WORDS_A));

  assert.deepEqual(host.snapshot(), {
    valid: true,
    offset: MAILBOX_AT,
    hostStatus: HOST_READY,
    localId: 1,
    playerCount: 2,
    heartbeat: 0,
    outPending: 1,
    inPending: [1, 0],
  });
});

test('the mailbox never writes outside its own 400 bytes', () => {
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const offset = MAILBOX_AT;
  initMailbox(buffer, offset);

  // Poison the bytes either side so any overrun is visible.
  const bytes = new Uint8Array(buffer);
  bytes.fill(0xa5, offset - 64, offset);
  bytes.fill(0x5a, offset + MAILBOX_SIZE, offset + MAILBOX_SIZE + 64);

  const host = new Mailbox(buffer, offset);
  const rom = new RomSim(buffer, offset);
  host.setSession({ status: HOST_READY, localId: 1, playerCount: 2 });

  for (let i = 0; i < 50; i++) {
    rom.sendCmd([i + 1, 0, 0, 0, 0, 0, 0, 0]);
    host.drainOutbox();
    host.pushInbox(0, wordsToBytes(WORDS_A));
    host.pushInbox(1, wordsToBytes(WORDS_A));
    rom.recvCmds();
  }

  for (let i = offset - 64; i < offset; i++) {
    assert.equal(bytes[i], 0xa5, `byte before mailbox at ${i} untouched`);
  }
  for (let i = offset + MAILBOX_SIZE; i < offset + MAILBOX_SIZE + 64; i++) {
    assert.equal(bytes[i], 0x5a, `byte after mailbox at ${i} untouched`);
  }
});

test('the struct size matches the C layout', () => {
  // in[] is followed by the diagnostics block, which ends the struct.
  assert.equal(OFF.in + 2 * RING_SLOTS * CMD_BYTES, OFF.coopState, 'in[] abuts diagnostics');
  assert.equal(OFF.out + RING_SLOTS * CMD_BYTES, OFF.in, 'out[] abuts in[]');
  assert.equal(MAILBOX_SIZE, 0x1a0);
  assert.ok(OFF.peerObjectId < MAILBOX_SIZE, 'diagnostics fit inside the struct');
});

// ---------------------------------------------------------------------------
// telling the live mailbox from a snapshot
// ---------------------------------------------------------------------------

test('a single candidate needs no disambiguation', () => {
  assert.equal(pickLiveMailbox([0x1000], []), 0x1000);
});

test('no candidates resolves to null', () => {
  assert.equal(pickLiveMailbox([], [[]]), null);
});

test('the ticking candidate is chosen over a frozen snapshot', () => {
  // An emulator holding a rewind snapshot presents two valid-looking
  // mailboxes. Only the live one's heartbeat advances.
  const offsets = [0x8e3d8, 0xbf33d8];
  const rounds = [
    [100, 4242],
    [101, 4242],
    [103, 4242],
  ];
  assert.equal(pickLiveMailbox(offsets, rounds), 0x8e3d8);
});

test('order does not matter — a later ticking candidate still wins', () => {
  const rounds = [
    [7, 50],
    [7, 51],
    [7, 53],
  ];
  assert.equal(pickLiveMailbox([0x2000, 0x9000], rounds), 0x9000);
});

test('a heartbeat that wraps past 16 bits still counts as ticking', () => {
  // The counter is u16 and the ROM runs at 60fps, so it wraps about every 18
  // minutes. "Changed" is the test, never "increased".
  const rounds = [
    [65534, 11],
    [65535, 11],
    [0, 11],
    [1, 11],
  ];
  assert.equal(pickLiveMailbox([0xaaa, 0xbbb], rounds), 0xaaa);
});

test('nothing ticking resolves to null rather than guessing', () => {
  // Emulator paused, or every candidate is a snapshot. Committing to a dead
  // buffer would look connected and silently exchange nothing.
  const rounds = [
    [5, 9],
    [5, 9],
  ];
  assert.equal(pickLiveMailbox([0x1000, 0x2000], rounds), null);
});

test('several ticking candidates resolve to null rather than guessing', () => {
  const rounds = [
    [1, 1],
    [2, 2],
  ];
  assert.equal(pickLiveMailbox([0x1000, 0x2000], rounds), null);
});

test('one round of samples is not enough to decide', () => {
  assert.equal(pickLiveMailbox([0x1000, 0x2000], [[5, 9]]), null);
});

test('the heartbeat is readable at the documented offset', () => {
  const { buffer, offset } = makeHeap();
  const host = new Mailbox(buffer, offset);
  assert.equal(host.heartbeat, 0, 'starts zeroed');

  // The ROM bumps this every VBlank; simulate one tick.
  new DataView(buffer).setUint16(offset + OFF.heartbeat, 1234, true);
  assert.equal(host.heartbeat, 1234);
  assert.equal(host.snapshot().heartbeat, 1234);
});

test('the heartbeat occupies former padding, so the struct size is unchanged', () => {
  assert.equal(OFF.heartbeat, 0x0e);
  assert.equal(OFF.out, 0x10, 'out[] still starts at 0x10');
  assert.equal(OFF.in + 2 * RING_SLOTS * CMD_BYTES, OFF.coopState);
});
