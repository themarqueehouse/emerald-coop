'use strict';

// WebSocket client for the co-op relay.
//
// Thin by design: it owns the socket, the join handshake, reconnection, and
// nothing else. All pacing decisions live in the Bridge, which is where they
// can be tested without a network.

import {
  PROTOCOL_VERSION,
  MSG_JOIN,
  MSG_HELLO,
  MSG_STATUS,
  MSG_ERROR,
  MSG_PING,
  MSG_PONG,
  encodeFrame,
  decodeFrame,
} from './wire.js';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const PING_INTERVAL_MS = 5000;

export class NetClient {
  /**
   * @param {object} opts
   * @param {string} opts.url relay URL (ws:// or wss://)
   * @param {string} opts.session session code
   * @param {number|null} [opts.slot] request a specific slot; null to be assigned
   * @param {(f: {playerId:number, seq:number, cmd:Uint8Array}) => void} opts.onFrame
   * @param {(s: {status:number, localId:number|null, playerCount:number}) => void} opts.onSession
   * @param {(e: object) => void} [opts.onEvent]
   * @param {typeof WebSocket} [opts.WebSocketImpl] injectable for tests
   */
  constructor({
    url,
    session,
    slot = null,
    onFrame,
    onSession,
    onEvent = () => {},
    WebSocketImpl = globalThis.WebSocket,
  }) {
    this.url = url;
    this.session = session;
    this.slot = slot;
    this.onFrame = onFrame;
    this.onSession = onSession;
    this.onEvent = onEvent;
    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.localId = null;
    this.seq = 0;
    this.rtt = null;
    this.closedByUs = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    // A terminal protocol error (version skew, bad code, slot taken) must not
    // be retried: reconnecting would fail identically and spin forever.
    this.fatal = null;
  }

  connect() {
    if (!this.WebSocketImpl) {
      this.onEvent({ type: 'error', detail: 'no WebSocket implementation available' });
      return;
    }
    this.closedByUs = false;
    this.fatal = null;
    this.open();
  }

  open() {
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.onEvent({ type: 'error', detail: `could not open socket: ${err.message}` });
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.attempt = 0;
      this.onEvent({ type: 'socket-open' });
      ws.send(
        JSON.stringify({
          t: MSG_JOIN,
          v: PROTOCOL_VERSION,
          session: this.session,
          // Only send `slot` when we actually want a specific one; the relay
          // treats any other value as "assign me whatever is free".
          ...(this.slot === 0 || this.slot === 1 ? { slot: this.slot } : {}),
        })
      );
      this.startPing();
    };

    ws.onmessage = (ev) => this.handleMessage(ev);

    ws.onclose = () => {
      this.stopPing();
      this.onEvent({ type: 'socket-closed' });
      if (!this.closedByUs && !this.fatal) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Browsers give no useful detail here; onclose follows and drives retry.
      this.onEvent({ type: 'socket-error' });
    };
  }

  handleMessage(ev) {
    const data = ev.data;

    if (typeof data !== 'string') {
      const frame = decodeFrame(data);
      if (!frame) {
        this.onEvent({ type: 'bad-frame' });
        return;
      }
      this.onFrame(frame);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this.onEvent({ type: 'bad-control' });
      return;
    }

    switch (msg.t) {
      case MSG_HELLO:
        this.localId = msg.localId;
        // Pin the slot so a reconnect lands in the same one. Slot 0 owns the
        // save file, so drifting between slots across a dropout would be bad.
        this.slot = msg.localId;
        this.onEvent({ type: 'joined', localId: msg.localId, session: msg.session });
        this.onSession({
          status: msg.status,
          localId: msg.localId,
          playerCount: msg.playerCount,
        });
        break;

      case MSG_STATUS:
        this.onSession({
          status: msg.status,
          localId: this.localId,
          playerCount: msg.playerCount,
        });
        break;

      case MSG_PONG:
        if (typeof msg.ts === 'number') this.rtt = Date.now() - msg.ts;
        break;

      case MSG_ERROR:
        this.fatal = msg.code;
        this.onEvent({ type: 'fatal', code: msg.code, detail: msg.detail });
        break;

      default:
        this.onEvent({ type: 'unknown-control', t: msg.t });
    }
  }

  /** Transport interface consumed by the Bridge. */
  send(cmdBytes) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    ws.send(encodeFrame(this.seq++, cmdBytes));
    return true;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ t: MSG_PING, ts: Date.now() }));
      }
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    // Exponential backoff with a ceiling: a phone that wakes up to a dead
    // relay should keep trying, but not hammer it.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt++;
    this.onEvent({ type: 'reconnecting', inMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  close() {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) this.ws.close();
  }
}
