'use strict';

// Reader/writer for the co-op mailbox the ROM publishes in emulated EWRAM.
//
// Layout and ring semantics mirror `struct NetMailbox` in include/net_link.h
// exactly. If you change one, change both — a mismatch here does not throw, it
// silently garbles link commands, which is the worst possible failure mode.

export const MAGIC = 0x504f4f43; // 'COOP'
export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 2;
export const CMD_LENGTH = 8;
export const CMD_BYTES = CMD_LENGTH * 2; // 16
export const RING_SLOTS = 8;
export const RING_MASK = RING_SLOTS - 1;
export const MAILBOX_SIZE = 0x1a0; // 416

// Byte offsets within the mailbox. Mirrors struct NetMailbox.
export const OFF = {
  magic: 0x00,
  version: 0x04,
  hostStatus: 0x05,
  localId: 0x06,
  playerCount: 0x07,
  outHead: 0x08,
  outTail: 0x09,
  inHead: 0x0a, // [MAX_PLAYERS]
  inTail: 0x0c, // [MAX_PLAYERS]
  heartbeat: 0x0e,
  out: 0x10, // NetFrame[RING_SLOTS]
  in: 0x90, // NetFrame[MAX_PLAYERS][RING_SLOTS]
  // Diagnostics written by the ROM. There is no console on a phone and no
  // debugger on a GBA, so this is the only way to see why co-op is not working.
  coopState: 0x190,
  linkFlags: 0x191,
  posSent: 0x192,
  posRecv: 0x194,
  peerMap: 0x196,
  peerX: 0x198,
  peerY: 0x19a,
  selfMap: 0x19c,
  peerObjectId: 0x19e,
};

export const COOP_STATE_NAMES = ['off', 'opening', 'exchanging', 'ACTIVE', 'lost'];

export const DIAG = {
  LINK_OPEN: 1 << 0,
  PLAYERS_RECEIVED: 1 << 1,
  CALLBACK_ARMED: 1 << 2,
  PEER_VALID: 1 << 3,
  PEER_SAME_MAP: 1 << 4,
};

// Mirrors enum NetHostStatus.
export const HOST_DOWN = 0;
export const HOST_CONNECTING = 1;
export const HOST_READY = 2;
export const HOST_LOST = 3;

/**
 * The ROM reserves one ring slot, so capacity is RING_SLOTS - 1. This matches
 * NetEnqueueSendCmd's `RingCount(...) >= NET_RING_MASK` check; treating the
 * ring as holding 8 would let the host overrun the ROM's view of it.
 */
export const RING_CAPACITY = RING_MASK; // 7

function ringCount(head, tail) {
  return (head - tail) & RING_MASK;
}

/**
 * Locate the mailbox inside an emulator heap.
 *
 * This deliberately scans rather than trusting a fixed address. Two reasons:
 * the mailbox's EWRAM address moves whenever the ROM is rebuilt, and where the
 * emulator maps emulated EWRAM inside its own heap is an implementation detail
 * we would rather not depend on. Scanning for the magic word sidesteps both.
 *
 * @param {ArrayBuffer|SharedArrayBuffer} buffer emulator heap
 * @param {{from?: number, to?: number}} [range] optional bounds to narrow the scan
 * @returns {number|null} byte offset of the mailbox, or null
 */
export function findMailbox(buffer, range = {}) {
  const from = Math.max(0, range.from ?? 0);
  const to = Math.min(buffer.byteLength, range.to ?? buffer.byteLength);
  if (to - from < MAILBOX_SIZE) return null;

  const view = new DataView(buffer);
  // The magic is u32-aligned in EWRAM, and emulators map that region aligned
  // within their heap, so stepping 4 bytes is both correct and 4x faster.
  const limit = to - MAILBOX_SIZE;

  for (let off = from - (from % 4); off <= limit; off += 4) {
    if (view.getUint32(off + OFF.magic, true) !== MAGIC) continue;
    // Guard against a stray copy of the magic in ROM data or a save state by
    // also requiring a plausible version and in-range cursors.
    if (view.getUint8(off + OFF.version) !== PROTOCOL_VERSION) continue;
    if (view.getUint8(off + OFF.outHead) > RING_MASK) continue;
    if (view.getUint8(off + OFF.outTail) > RING_MASK) continue;
    return off;
  }

  return null;
}

/** Find every candidate — used by diagnostics to detect an ambiguous scan. */
export function findAllMailboxes(buffer, range = {}) {
  const found = [];
  let from = range.from ?? 0;
  for (;;) {
    const off = findMailbox(buffer, { ...range, from });
    if (off === null) break;
    found.push(off);
    from = off + 4;
  }
  return found;
}

/**
 * Given several candidates, find the one the ROM is actually running in.
 *
 * An emulator may hold more than one copy of EWRAM -- rewind snapshots and
 * save states both contain a full image, magic word and all. Picking wrongly
 * means reading and writing a dead buffer: the session would look connected
 * and simply never exchange anything.
 *
 * The live copy is the one whose heartbeat advances. `sample` is called with
 * no arguments to read each candidate's heartbeat at a point in time; the
 * caller is responsible for letting at least one frame elapse between rounds.
 *
 * @param {ArrayBuffer|SharedArrayBuffer} buffer
 * @param {number[]} offsets candidate offsets
 * @param {number[][]} rounds heartbeat readings, one array per round
 * @returns {number|null} the live offset, or null if it cannot be decided
 */
export function pickLiveMailbox(offsets, rounds) {
  if (offsets.length === 0) return null;
  if (offsets.length === 1) return offsets[0];
  if (rounds.length < 2) return null;

  const moved = offsets.filter((_, i) => {
    const first = rounds[0][i];
    // A u16 wraps, so "changed at all" is the test, not "increased".
    return rounds.some((r) => r[i] !== first);
  });

  // Exactly one ticking candidate is the answer. Zero means the emulator is
  // paused or none of them are live; more than one means something is copying
  // memory continuously and we should not guess.
  return moved.length === 1 ? moved[0] : null;
}

export class Mailbox {
  /**
   * @param {ArrayBuffer|SharedArrayBuffer} buffer emulator heap
   * @param {number} offset byte offset of the mailbox within it
   */
  constructor(buffer, offset) {
    this.offset = offset;
    this.rebind(buffer);
  }

  /**
   * Re-point at a (possibly new) heap buffer. WASM memory growth detaches
   * typed-array views, so the bridge calls this whenever the emulator reports
   * a new buffer rather than caching a view forever.
   */
  rebind(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer, this.offset, MAILBOX_SIZE);
    this.bytes = new Uint8Array(buffer, this.offset, MAILBOX_SIZE);
  }

  get valid() {
    return (
      this.view.getUint32(OFF.magic, true) === MAGIC &&
      this.view.getUint8(OFF.version) === PROTOCOL_VERSION
    );
  }

  // --- fields the host owns -------------------------------------------------

  /**
   * Ticks every emulated frame from boot. The only reliable way to tell the
   * live mailbox from a rewind snapshot or save state, all of which carry a
   * valid magic word.
   */
  get heartbeat() {
    return this.view.getUint16(OFF.heartbeat, true);
  }

  get hostStatus() {
    return this.view.getUint8(OFF.hostStatus);
  }
  set hostStatus(v) {
    this.view.setUint8(OFF.hostStatus, v & 0xff);
  }

  get localId() {
    return this.view.getUint8(OFF.localId);
  }
  set localId(v) {
    this.view.setUint8(OFF.localId, v & 0xff);
  }

  get playerCount() {
    return this.view.getUint8(OFF.playerCount);
  }
  set playerCount(v) {
    this.view.setUint8(OFF.playerCount, v & 0xff);
  }

  /** Publish the whole host-owned block at once. */
  setSession({ status, localId, playerCount }) {
    if (localId !== undefined) this.localId = localId;
    if (playerCount !== undefined) this.playerCount = playerCount;
    // Status last: it is the field the ROM gates on, so everything it might
    // read alongside must already be in place.
    if (status !== undefined) this.hostStatus = status;
  }

  // --- outbox: ROM -> host --------------------------------------------------

  get outPending() {
    return ringCount(this.view.getUint8(OFF.outHead), this.view.getUint8(OFF.outTail));
  }

  /**
   * Drain up to `max` commands the ROM has queued for transmission.
   *
   * The limit matters: the caller must be able to loop each drained frame back
   * into its own inbox ring, and that ring is smaller than the number of
   * frames this can return. Draining more than there is loopback room for
   * means discarding frames the peer already has, which is a desync. Callers
   * should pass the room they actually have.
   *
   * @param {number} [max] maximum frames to take; default is all of them
   * @returns {Uint8Array[]} zero or more 16-byte link commands, oldest first
   */
  drainOutbox(max = Infinity) {
    const head = this.view.getUint8(OFF.outHead);
    let tail = this.view.getUint8(OFF.outTail);
    const out = [];

    while (tail !== head && out.length < max) {
      const base = OFF.out + (tail & RING_MASK) * CMD_BYTES;
      // Copy, don't alias: the ROM will reuse this slot, and a SharedArrayBuffer
      // view handed to the socket could be mutated mid-send.
      out.push(this.bytes.slice(base, base + CMD_BYTES));
      tail = (tail + 1) & RING_MASK;
    }

    // Publish the new tail only after reading, so the ROM cannot refill a slot
    // we have not copied yet.
    this.view.setUint8(OFF.outTail, tail);
    return out;
  }

  // --- inbox: host -> ROM ---------------------------------------------------

  inPending(playerId) {
    return ringCount(
      this.view.getUint8(OFF.inHead + playerId),
      this.view.getUint8(OFF.inTail + playerId)
    );
  }

  inFull(playerId) {
    return this.inPending(playerId) >= RING_CAPACITY;
  }

  /**
   * Hand the ROM one link command for a given player.
   * @returns {boolean} false if that player's ring is full (caller should drop)
   */
  pushInbox(playerId, cmdBytes) {
    if (playerId < 0 || playerId >= MAX_PLAYERS) {
      throw new RangeError(`playerId ${playerId} out of range`);
    }
    if (cmdBytes.length !== CMD_BYTES) {
      throw new RangeError(`cmd must be ${CMD_BYTES} bytes, got ${cmdBytes.length}`);
    }
    if (this.inFull(playerId)) return false;

    const head = this.view.getUint8(OFF.inHead + playerId);
    const base = OFF.in + (playerId * RING_SLOTS + (head & RING_MASK)) * CMD_BYTES;
    this.bytes.set(cmdBytes, base);
    // Advance head last: until it moves, the ROM will not read this slot.
    this.view.setUint8(OFF.inHead + playerId, (head + 1) & RING_MASK);
    return true;
  }

  /** Clear both rings. Used on session reset so stale link time is discarded. */
  resetRings() {
    this.view.setUint8(OFF.outHead, 0);
    this.view.setUint8(OFF.outTail, 0);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.view.setUint8(OFF.inHead + i, 0);
      this.view.setUint8(OFF.inTail + i, 0);
    }
  }

  /** Everything the ROM reports about the co-op session. */
  diagnostics() {
    const v = this.view;
    const flags = v.getUint8(OFF.linkFlags);
    const mapStr = (m) => `${m & 0xff}.${(m >> 8) & 0xff}`;
    return {
      state: COOP_STATE_NAMES[v.getUint8(OFF.coopState)] ?? v.getUint8(OFF.coopState),
      linkOpen: Boolean(flags & DIAG.LINK_OPEN),
      playersReceived: Boolean(flags & DIAG.PLAYERS_RECEIVED),
      callbackArmed: Boolean(flags & DIAG.CALLBACK_ARMED),
      peerValid: Boolean(flags & DIAG.PEER_VALID),
      peerSameMap: Boolean(flags & DIAG.PEER_SAME_MAP),
      posSent: v.getUint16(OFF.posSent, true),
      posRecv: v.getUint16(OFF.posRecv, true),
      selfMap: mapStr(v.getUint16(OFF.selfMap, true)),
      peerMap: mapStr(v.getUint16(OFF.peerMap, true)),
      peerAt: `${v.getUint16(OFF.peerX, true)},${v.getUint16(OFF.peerY, true)}`,
      spawned: v.getUint8(OFF.peerObjectId) < 16,
    };
  }

  snapshot() {
    return {
      valid: this.valid,
      offset: this.offset,
      hostStatus: this.hostStatus,
      localId: this.localId,
      playerCount: this.playerCount,
      heartbeat: this.heartbeat,
      outPending: this.outPending,
      inPending: [this.inPending(0), this.inPending(1)],
    };
  }
}
