'use strict';

// The per-frame pump that joins the ROM mailbox to the network link.
//
// Pacing is the whole job, and it is less obvious than it looks.
//
// The ROM only advances a link frame when BOTH players' inbox rings have a
// command waiting (NetDequeueRecvCmds). Our own commands go into our own ring
// by local loopback rather than round-tripping through the relay, which keeps
// latency off the local path. But that creates an asymmetry: if we loop our
// frames back as fast as the game produces them while the peer is lagging, our
// own ring fills to capacity and the peer's stays empty. The ROM pops nothing,
// and we are then forced to drop OUR OWN frames -- which is a guaranteed
// desync, because those frames exist on the peer's console and not on ours.
//
// The fix is to let backpressure travel backwards through the ROM's own
// mechanisms: only drain the outbox when there is room to loop the frame back.
// Frames then stay in the ROM's send ring, it raises queueFull, and the game
// throttles itself exactly as it would on a laggy cable. Nothing is ever
// dropped on the local side.
//
// Incoming peer frames get a JS-side holding queue for the same reason, so a
// network burst is absorbed rather than discarded.

import { HOST_DOWN, HOST_CONNECTING, HOST_READY, HOST_LOST, RING_CAPACITY } from './mailbox.js';

// If the peer runs this far ahead of what our ROM has consumed, something is
// structurally wrong (a stalled local emulator, or a peer not honouring
// lockstep). Past this we stop accepting and report, rather than growing a
// queue forever and pretending things are fine.
const MAX_PEER_BACKLOG = 120; // ~2s of link frames

export class Bridge {
  /**
   * @param {object} opts
   * @param {import('./mailbox.js').Mailbox} opts.mailbox
   * @param {{send: (cmd: Uint8Array) => void}} opts.link transport (the net client)
   * @param {(event: object) => void} [opts.onEvent] diagnostics sink
   */
  constructor({ mailbox, link, onEvent = () => {} }) {
    this.mailbox = mailbox;
    this.link = link;
    this.onEvent = onEvent;

    this.localId = 0;
    this.peerId = 1;
    this.status = HOST_DOWN;
    this.playerCount = 0;

    /** @type {Uint8Array[]} peer frames not yet handed to the ROM */
    this.peerQueue = [];

    this.stats = {
      sentFrames: 0,
      recvFrames: 0,
      loopbackFrames: 0,
      stalledPumps: 0,
      peerDropped: 0,
      maxPeerBacklog: 0,
    };
  }

  /** Called when the relay tells us who we are. */
  setIdentity({ localId, playerCount }) {
    if (localId !== undefined && localId !== this.localId) {
      this.localId = localId;
      this.peerId = localId === 0 ? 1 : 0;
    }
    if (playerCount !== undefined) this.playerCount = playerCount;
    this.publish();
  }

  setStatus(status) {
    const was = this.status;
    this.status = status;

    // A session starting fresh must not inherit link time from a previous one:
    // those frames belong to a link frame the peer has already passed.
    if (status === HOST_READY && was !== HOST_READY) {
      this.peerQueue.length = 0;
      this.mailbox.resetRings();
      this.onEvent({ type: 'session-ready', localId: this.localId });
    }

    if (status === HOST_LOST && was !== HOST_LOST) {
      this.onEvent({ type: 'peer-lost' });
    }

    this.publish();
  }

  /** Push host-owned state into the mailbox for the ROM to read. */
  publish() {
    this.mailbox.setSession({
      status: this.status,
      localId: this.localId,
      playerCount: this.playerCount,
    });
  }

  /** Called by the transport for each frame that arrives from the peer. */
  onPeerFrame(cmdBytes) {
    if (this.peerQueue.length >= MAX_PEER_BACKLOG) {
      // Dropping here is bad but bounded; the alternative is unbounded memory
      // and a session that can never catch up anyway.
      this.stats.peerDropped++;
      if (this.stats.peerDropped === 1) {
        this.onEvent({ type: 'peer-backlog-overflow', backlog: this.peerQueue.length });
      }
      return;
    }
    this.peerQueue.push(cmdBytes);
    this.stats.recvFrames++;
    if (this.peerQueue.length > this.stats.maxPeerBacklog) {
      this.stats.maxPeerBacklog = this.peerQueue.length;
    }
  }

  /**
   * Run one pump. Call this once per emulated frame, with the emulator halted.
   * @returns {{sent: number, delivered: number, stalled: boolean}}
   */
  pump() {
    if (this.status !== HOST_READY) {
      return { sent: 0, delivered: 0, stalled: false };
    }

    // 1. Hand the ROM as many peer frames as its ring will take.
    let delivered = 0;
    while (this.peerQueue.length > 0 && !this.mailbox.inFull(this.peerId)) {
      if (!this.mailbox.pushInbox(this.peerId, this.peerQueue[0])) break;
      this.peerQueue.shift();
      delivered++;
    }

    // 2. Drain our own outbox, but only while we can also loop the frame back.
    //    Leaving a frame in the ROM's ring is how backpressure reaches the
    //    game; dropping it would desync us from the peer.
    let sent = 0;
    let stalled = false;

    const pending = this.mailbox.outPending;
    if (pending > 0) {
      // Take only as many as we can loop back. Draining more would mean
      // discarding frames the peer already has, which desyncs us from them --
      // so the loopback ring's free space, not the outbox's depth, is what
      // decides how much link time we advance this pump.
      const room = RING_CAPACITY - this.mailbox.inPending(this.localId);
      const take = Math.min(pending, room);

      if (take <= 0) {
        // Peer is behind. Consume nothing; the ROM will raise queueFull and
        // throttle itself. This is the designed stall, not an error.
        stalled = true;
        this.stats.stalledPumps++;
      } else {
        if (take < pending) {
          // Partial drain: the rest stays in the ROM's ring for the next pump.
          stalled = true;
          this.stats.stalledPumps++;
        }

        for (const cmd of this.mailbox.drainOutbox(take)) {
          this.link.send(cmd);
          this.stats.sentFrames++;
          sent++;

          // Loopback. The relay deliberately does not echo our own frames, so
          // this is the only path by which gRecvCmds[localId] gets filled.
          if (this.mailbox.pushInbox(this.localId, cmd)) {
            this.stats.loopbackFrames++;
          } else {
            // Unreachable given the `room` calculation above. If it ever
            // fires, we have lost a frame the peer holds and the session is
            // desynced -- so say so loudly rather than carrying on.
            this.onEvent({ type: 'loopback-lost', localId: this.localId });
          }
        }
      }
    }

    return { sent, delivered, stalled };
  }

  snapshot() {
    return {
      status: this.status,
      localId: this.localId,
      peerId: this.peerId,
      playerCount: this.playerCount,
      peerQueue: this.peerQueue.length,
      mailbox: this.mailbox.snapshot(),
      stats: { ...this.stats },
    };
  }
}

export { HOST_DOWN, HOST_CONNECTING, HOST_READY, HOST_LOST, MAX_PEER_BACKLOG };
