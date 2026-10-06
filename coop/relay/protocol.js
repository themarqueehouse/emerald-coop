'use strict';

// Wire protocol shared by the relay and the browser wrapper.
//
// Control messages are JSON text frames: rare, and worth being readable when
// something goes wrong. Link frames are binary: 60 per second per player, and
// the whole point is to keep them small.
//
// Keep NET_* in sync with include/net_link.h.

const NET_PROTOCOL_VERSION = 1;
const NET_MAX_PLAYERS = 2;
const CMD_LENGTH = 8; // u16 words per link command
const CMD_BYTES = CMD_LENGTH * 2; // 16

// Mirrors enum NetHostStatus in include/net_link.h.
const HOST_DOWN = 0;
const HOST_CONNECTING = 1;
const HOST_READY = 2;
const HOST_LOST = 3;

// Binary frame layout, client -> server:
//   [0]     seq low byte
//   [1]     seq high byte
//   [2..17] 16 bytes of link command (8 u16, little-endian)
const C2S_FRAME_BYTES = 2 + CMD_BYTES; // 18

// Binary frame layout, server -> client (playerId prepended):
//   [0]     playerId of the sender
//   [1]     seq low byte
//   [2]     seq high byte
//   [3..18] 16 bytes of link command
const S2C_FRAME_BYTES = 1 + 2 + CMD_BYTES; // 19

const SEQ_MODULO = 0x10000;

/** Build the binary frame a client sends. */
function encodeClientFrame(seq, cmdBytes) {
  if (cmdBytes.length !== CMD_BYTES) {
    throw new Error(`cmd must be ${CMD_BYTES} bytes, got ${cmdBytes.length}`);
  }
  const buf = Buffer.allocUnsafe(C2S_FRAME_BYTES);
  buf.writeUInt16LE(seq % SEQ_MODULO, 0);
  Buffer.from(cmdBytes).copy(buf, 2);
  return buf;
}

/** Parse a client frame. Returns null if malformed — never throws on input. */
function decodeClientFrame(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== C2S_FRAME_BYTES) return null;
  return { seq: b.readUInt16LE(0), cmd: b.subarray(2, 2 + CMD_BYTES) };
}

/** Build the binary frame the server forwards to the peer. */
function encodeServerFrame(playerId, seq, cmdBytes) {
  const buf = Buffer.allocUnsafe(S2C_FRAME_BYTES);
  buf.writeUInt8(playerId, 0);
  buf.writeUInt16LE(seq % SEQ_MODULO, 1);
  Buffer.from(cmdBytes).copy(buf, 3);
  return buf;
}

/** Parse a server frame. Returns null if malformed. */
function decodeServerFrame(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== S2C_FRAME_BYTES) return null;
  return {
    playerId: b.readUInt8(0),
    seq: b.readUInt16LE(1),
    cmd: b.subarray(3, 3 + CMD_BYTES),
  };
}

// Control message types (JSON `t` field).
const MSG_JOIN = 'join'; // client -> server
const MSG_HELLO = 'hello'; // server -> client, once, on accept
const MSG_STATUS = 'status'; // server -> client, whenever the session changes
const MSG_ERROR = 'error'; // server -> client, terminal
const MSG_PING = 'ping';
const MSG_PONG = 'pong';

const ERR_BAD_VERSION = 'bad_version';
const ERR_BAD_SESSION = 'bad_session';
const ERR_SESSION_FULL = 'session_full';
const ERR_MALFORMED = 'malformed';
const ERR_SLOT_TAKEN = 'slot_taken';

// Session codes: short enough to read over the phone, no ambiguous characters.
const SESSION_CODE_RE = /^[A-Z0-9]{4,12}$/;

function isValidSessionCode(code) {
  return typeof code === 'string' && SESSION_CODE_RE.test(code);
}

module.exports = {
  NET_PROTOCOL_VERSION,
  NET_MAX_PLAYERS,
  CMD_LENGTH,
  CMD_BYTES,
  C2S_FRAME_BYTES,
  S2C_FRAME_BYTES,
  SEQ_MODULO,
  HOST_DOWN,
  HOST_CONNECTING,
  HOST_READY,
  HOST_LOST,
  encodeClientFrame,
  decodeClientFrame,
  encodeServerFrame,
  decodeServerFrame,
  MSG_JOIN,
  MSG_HELLO,
  MSG_STATUS,
  MSG_ERROR,
  MSG_PING,
  MSG_PONG,
  ERR_BAD_VERSION,
  ERR_BAD_SESSION,
  ERR_SESSION_FULL,
  ERR_MALFORMED,
  ERR_SLOT_TAKEN,
  isValidSessionCode,
};
