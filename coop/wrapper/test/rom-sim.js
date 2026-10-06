'use strict';

// A faithful JS port of the ROM half of the mailbox protocol, used only by
// tests. It mirrors NetEnqueueSendCmd and NetDequeueRecvCmds from
// src/net_link.c line for line.
//
// The point is to exercise both halves against the same bytes. If the C struct
// offsets and the JS offsets ever drift apart, or the ring arithmetic differs
// by one, these tests fail — whereas testing the host half alone would happily
// pass while garbling every link command on real hardware.

import {
  OFF,
  CMD_BYTES,
  CMD_LENGTH,
  RING_MASK,
  MAX_PLAYERS,
  MAGIC,
  PROTOCOL_VERSION,
  MAILBOX_SIZE,
  HOST_DOWN,
} from '../src/mailbox.js';

const QUEUE_FULL_NONE = 0;
const QUEUE_FULL_SEND = 1;

function ringCount(head, tail) {
  return (head - tail) & RING_MASK;
}

/** Lay down a mailbox exactly as NetLink_Init() does. */
export function initMailbox(buffer, offset) {
  const bytes = new Uint8Array(buffer, offset, MAILBOX_SIZE);
  bytes.fill(0);
  const view = new DataView(buffer, offset, MAILBOX_SIZE);
  view.setUint8(OFF.version, PROTOCOL_VERSION);
  view.setUint32(OFF.magic, MAGIC, true);
  view.setUint8(OFF.hostStatus, HOST_DOWN);
  return offset;
}

export class RomSim {
  constructor(buffer, offset) {
    this.view = new DataView(buffer, offset, MAILBOX_SIZE);
    this.bytes = new Uint8Array(buffer, offset, MAILBOX_SIZE);
    this.queueFull = QUEUE_FULL_NONE;
    this.receivedNothing = false;
  }

  get playerCount() {
    const n = this.view.getUint8(OFF.playerCount);
    return n > MAX_PLAYERS ? MAX_PLAYERS : n;
  }

  /**
   * NetEnqueueSendCmd. Note the two behaviours that matter:
   * an all-zero command is dropped, and on a full ring nothing is consumed.
   * @param {number[]} words CMD_LENGTH u16s, as the game would write gSendCmd
   * @returns {number[]} the caller's buffer after the call (zeroed if accepted)
   */
  sendCmd(words) {
    const buf = [...words];
    if (buf.length !== CMD_LENGTH) throw new Error('cmd must be 8 words');

    let nonzero = 0;
    for (const w of buf) nonzero |= w;
    if (nonzero === 0) return buf; // dropped, not transmitted

    const head = this.view.getUint8(OFF.outHead);
    const tail = this.view.getUint8(OFF.outTail);

    if (ringCount(head, tail) >= RING_MASK) {
      this.queueFull = QUEUE_FULL_SEND;
      return buf; // not zeroed: the game retains it
    }

    const base = OFF.out + (head & RING_MASK) * CMD_BYTES;
    for (let i = 0; i < CMD_LENGTH; i++) {
      this.view.setUint16(base + i * 2, buf[i], true);
      buf[i] = 0; // the game's gSendCmd is cleared on accept
    }
    this.view.setUint8(OFF.outHead, (head + 1) & RING_MASK);
    return buf;
  }

  /**
   * NetDequeueRecvCmds. Atomic across players: delivers a frame only when
   * every player has one waiting, otherwise nothing and receivedNothing.
   * @returns {number[][]|null} per-player commands, or null if nothing delivered
   */
  recvCmds() {
    let count = this.playerCount;
    if (count === 0) count = 1;

    for (let i = 0; i < count; i++) {
      const head = this.view.getUint8(OFF.inHead + i);
      const tail = this.view.getUint8(OFF.inTail + i);
      if (head === tail) {
        this.receivedNothing = true;
        return null;
      }
    }

    const out = [];
    for (let i = 0; i < count; i++) {
      const tail = this.view.getUint8(OFF.inTail + i);
      const base = OFF.in + (i * (RING_MASK + 1) + (tail & RING_MASK)) * CMD_BYTES;
      const words = [];
      for (let j = 0; j < CMD_LENGTH; j++) {
        words.push(this.view.getUint16(base + j * 2, true));
      }
      out.push(words);
      this.view.setUint8(OFF.inTail + i, (tail + 1) & RING_MASK);
    }

    this.receivedNothing = false;
    return out;
  }
}

/** Helper: words -> the 16 little-endian bytes the wire carries. */
export function wordsToBytes(words) {
  const b = new Uint8Array(CMD_BYTES);
  const v = new DataView(b.buffer);
  words.forEach((w, i) => v.setUint16(i * 2, w, true));
  return b;
}

/** Helper: wire bytes -> words. */
export function bytesToWords(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  for (let i = 0; i < CMD_LENGTH; i++) words.push(v.getUint16(i * 2, true));
  return words;
}
