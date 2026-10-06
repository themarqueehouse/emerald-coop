'use strict';

// Co-op relay.
//
// Deliberately dumb: it pairs two players into a session, assigns them slots
// 0 and 1, forwards link frames between them, and tells each side whether the
// other is present. It holds no game state and makes no decisions about the
// world — the save lives on player 1's device by design.
//
// Lockstep is NOT enforced here. The ROM-side mailbox only pops a frame when
// both players have one waiting (see NetDequeueRecvCmds in src/net_link.c), so
// pacing is handled where it belongs: next to the code that consumes it. The
// relay's only pacing duty is to not buffer without bound.

const { WebSocketServer } = require('ws');
const proto = require('./protocol');

// Per-player send backlog. If a client stops reading, frames pile up in the
// kernel socket buffer and then in ws's internal queue; past this many we drop
// the oldest rather than grow forever. One second of frames is already far
// more lag than the game tolerates, so anything beyond it is dead weight.
const MAX_BACKLOG_FRAMES = 60;

// A client that sends nothing at all for this long is gone, whatever the socket
// thinks. Mobile browsers suspend background tabs without closing sockets, so
// this is the detection that actually fires in practice.
const IDLE_TIMEOUT_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 5000;

class Session {
  constructor(code) {
    this.code = code;
    this.slots = [null, null]; // index === localId
    this.createdAt = Date.now();
  }

  get playerCount() {
    return this.slots.filter(Boolean).length;
  }

  get isEmpty() {
    return this.playerCount === 0;
  }

  freeSlot() {
    const i = this.slots.findIndex((s) => s === null);
    return i === -1 ? null : i;
  }

  status() {
    return this.playerCount === proto.NET_MAX_PLAYERS
      ? proto.HOST_READY
      : proto.HOST_CONNECTING;
  }

  peerOf(localId) {
    return this.slots[localId === 0 ? 1 : 0];
  }
}

class Relay {
  constructor({ port = 8787, logger = console } = {}) {
    this.port = port;
    this.log = logger;
    this.sessions = new Map();
    this.wss = null;
    this.heartbeat = null;
    // Set once a session has been full, so a later drop reads as LOST rather
        // than CONNECTING. Without this the surviving player sees "waiting for
    // player 2" and cannot tell a dropout from a session that never started.
    this.everReady = new Set();
  }

  listen() {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        this.port = this.wss.address().port;
        this.log.info?.(`relay listening on :${this.port}`);
        resolve(this.port);
      });

      this.wss.on('connection', (ws) => this.onConnection(ws));

      this.heartbeat = setInterval(() => this.sweepIdle(), HEARTBEAT_INTERVAL_MS);
      // Don't hold the event loop open just for the sweep.
      this.heartbeat.unref?.();
    });
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const session of this.sessions.values()) {
      for (const player of session.slots) {
        if (player) player.ws.terminate();
      }
    }
    this.sessions.clear();
    if (!this.wss) return;
    await new Promise((resolve) => this.wss.close(resolve));
  }

  onConnection(ws) {
    // A socket that has not joined yet owns no slot and gets no frames.
    const player = {
      ws,
      session: null,
      localId: null,
      lastSeenAt: Date.now(),
      framesIn: 0,
      framesOut: 0,
      framesDropped: 0,
    };

    ws.binaryType = 'nodebuffer';

    ws.on('message', (data, isBinary) => {
      player.lastSeenAt = Date.now();
      try {
        if (isBinary) this.onFrame(player, data);
        else this.onControl(player, data);
      } catch (err) {
        // A malformed message is the client's problem, never the relay's.
        this.log.warn?.(`dropping message: ${err.message}`);
        this.sendError(player, proto.ERR_MALFORMED, err.message);
      }
    });

    ws.on('close', () => this.onDisconnect(player));
    ws.on('error', () => this.onDisconnect(player));
  }

  onControl(player, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.sendError(player, proto.ERR_MALFORMED, 'not JSON');
      return;
    }

    if (msg.t === proto.MSG_PING) {
      this.sendJson(player, { t: proto.MSG_PONG, ts: msg.ts });
      return;
    }

    if (msg.t === proto.MSG_JOIN) {
      this.onJoin(player, msg);
      return;
    }

    this.sendError(player, proto.ERR_MALFORMED, `unknown type ${msg.t}`);
  }

  onJoin(player, msg) {
    if (player.session) {
      this.sendError(player, proto.ERR_MALFORMED, 'already joined');
      return;
    }

    if (msg.v !== proto.NET_PROTOCOL_VERSION) {
      // Version skew between the two players would desync in confusing ways;
      // refuse at the door instead.
      this.sendError(
        player,
        proto.ERR_BAD_VERSION,
        `relay speaks v${proto.NET_PROTOCOL_VERSION}, client sent v${msg.v}`
      );
      player.ws.close();
      return;
    }

    const code = typeof msg.session === 'string' ? msg.session.toUpperCase() : null;
    if (!proto.isValidSessionCode(code)) {
      this.sendError(player, proto.ERR_BAD_SESSION, 'session code must be 4-12 chars A-Z0-9');
      player.ws.close();
      return;
    }

    let session = this.sessions.get(code);
    if (!session) {
      session = new Session(code);
      this.sessions.set(code, session);
    }

    // An explicit slot request lets player 1 reliably be player 1 across
    // reconnects, which matters because slot 0 owns the save file.
    let slot;
    if (msg.slot === 0 || msg.slot === 1) {
      if (session.slots[msg.slot]) {
        this.sendError(player, proto.ERR_SLOT_TAKEN, `slot ${msg.slot} is occupied`);
        player.ws.close();
        return;
      }
      slot = msg.slot;
    } else {
      slot = session.freeSlot();
      if (slot === null) {
        this.sendError(player, proto.ERR_SESSION_FULL, 'session already has two players');
        player.ws.close();
        return;
      }
    }

    session.slots[slot] = player;
    player.session = session;
    player.localId = slot;

    this.sendJson(player, {
      t: proto.MSG_HELLO,
      v: proto.NET_PROTOCOL_VERSION,
      localId: slot,
      session: code,
      playerCount: session.playerCount,
      status: session.status(),
    });

    if (session.playerCount === proto.NET_MAX_PLAYERS) this.everReady.add(code);

    this.broadcastStatus(session);
    this.log.info?.(
      `join: session=${code} slot=${slot} players=${session.playerCount}`
    );
  }

  onFrame(player, data) {
    if (!player.session) {
      this.sendError(player, proto.ERR_MALFORMED, 'frame before join');
      return;
    }

    const frame = proto.decodeClientFrame(data);
    if (!frame) {
      this.sendError(
        player,
        proto.ERR_MALFORMED,
        `frame must be ${proto.C2S_FRAME_BYTES} bytes, got ${data.length}`
      );
      return;
    }

    player.framesIn++;

    const peer = player.session.peerOf(player.localId);
    // No peer yet, or peer mid-reconnect: drop. The ROM treats a missing frame
    // as receivedNothing and simply waits, which is exactly right.
    if (!peer || peer.ws.readyState !== peer.ws.OPEN) return;

    if (peer.ws.bufferedAmount > MAX_BACKLOG_FRAMES * proto.S2C_FRAME_BYTES) {
      peer.framesDropped++;
      return;
    }

    peer.ws.send(proto.encodeServerFrame(player.localId, frame.seq, frame.cmd));
    peer.framesOut++;
  }

  onDisconnect(player) {
    const session = player.session;
    if (!session) return;
    if (session.slots[player.localId] !== player) return; // already replaced

    session.slots[player.localId] = null;
    player.session = null;
    this.log.info?.(
      `leave: session=${session.code} slot=${player.localId} ` +
        `in=${player.framesIn} out=${player.framesOut} dropped=${player.framesDropped}`
    );

    if (session.isEmpty) {
      this.sessions.delete(session.code);
      this.everReady.delete(session.code);
      return;
    }

    this.broadcastStatus(session);
  }

  broadcastStatus(session) {
    const wasReady = this.everReady.has(session.code);
    const status =
      session.playerCount < proto.NET_MAX_PLAYERS && wasReady
        ? proto.HOST_LOST
        : session.status();

    for (const p of session.slots) {
      if (!p || p.ws.readyState !== p.ws.OPEN) continue;
      this.sendJson(p, {
        t: proto.MSG_STATUS,
        status,
        playerCount: session.playerCount,
        peerPresent: Boolean(session.peerOf(p.localId)),
      });
    }
  }

  sweepIdle() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      for (const p of session.slots) {
        if (!p) continue;
        if (now - p.lastSeenAt > IDLE_TIMEOUT_MS) {
          this.log.warn?.(
            `idle timeout: session=${session.code} slot=${p.localId}`
          );
          p.ws.terminate();
          this.onDisconnect(p);
        }
      }
    }
  }

  sendJson(player, obj) {
    if (player.ws.readyState !== player.ws.OPEN) return;
    player.ws.send(JSON.stringify(obj));
  }

  sendError(player, code, detail) {
    this.sendJson(player, { t: proto.MSG_ERROR, code, detail });
  }

  stats() {
    return {
      sessions: this.sessions.size,
      players: [...this.sessions.values()].reduce((n, s) => n + s.playerCount, 0),
    };
  }
}

module.exports = { Relay, Session };

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const relay = new Relay({ port });
  relay.listen();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await relay.close();
      process.exit(0);
    });
  }
}
