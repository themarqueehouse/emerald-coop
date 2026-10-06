'use strict';

// Browser-side (ESM) wire codec.
//
// This mirrors coop/relay/protocol.js, which is CommonJS and therefore not
// importable here. The duplication is deliberate but guarded:
// test/wire.test.js requires the relay module and asserts every constant and
// every encoding matches byte for byte, so drift fails the suite rather than
// corrupting a session.

export const PROTOCOL_VERSION = 1;
export const CMD_BYTES = 16;
export const C2S_FRAME_BYTES = 2 + CMD_BYTES; // 18
export const S2C_FRAME_BYTES = 1 + 2 + CMD_BYTES; // 19
export const SEQ_MODULO = 0x10000;

export const MSG_JOIN = 'join';
export const MSG_HELLO = 'hello';
export const MSG_STATUS = 'status';
export const MSG_ERROR = 'error';
export const MSG_PING = 'ping';
export const MSG_PONG = 'pong';

/** Encode a link command for transmission. */
export function encodeFrame(seq, cmdBytes) {
  if (cmdBytes.length !== CMD_BYTES) {
    throw new RangeError(`cmd must be ${CMD_BYTES} bytes, got ${cmdBytes.length}`);
  }
  const buf = new Uint8Array(C2S_FRAME_BYTES);
  const s = seq % SEQ_MODULO;
  buf[0] = s & 0xff;
  buf[1] = (s >> 8) & 0xff;
  buf.set(cmdBytes, 2);
  return buf;
}

/**
 * Decode a frame forwarded by the relay.
 * Returns null on anything malformed — a bad frame must never throw into the
 * socket's message handler and tear down a live session.
 */
export function decodeFrame(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length !== S2C_FRAME_BYTES) return null;
  return {
    playerId: b[0],
    seq: b[1] | (b[2] << 8),
    cmd: b.slice(3, 3 + CMD_BYTES),
  };
}
