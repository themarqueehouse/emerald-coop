'use strict';

// Orchestration: boot the emulator, find the mailbox, join the relay, and pump
// the bridge once per emulated frame.
//
// Everything with real logic in it lives in mailbox.js, bridge.js, controls.js
// and netclient.js, all of which are tested without a browser. This file is
// the part that can only be verified by running it on a phone, so it is kept
// as thin and as loud-on-failure as possible.

// Resolved relative to the BUILT output, not node_modules: tools/build.mjs
// copies this file flat into dist/ alongside dist/vendor/, and patches the
// core there. The site is then plain static files with no bundler in the way.
// tools/build.mjs verifies this path resolves, so it cannot rot silently.
import mGBA from './vendor/mgba.js';

import { Mailbox, findAllMailboxes, pickLiveMailbox, HOST_DOWN } from './mailbox.js';
import { Bridge, HOST_CONNECTING, HOST_READY, HOST_LOST } from './bridge.js';
import { NetClient } from './netclient.js';
import {
  DEFAULT_LAYOUT,
  MGBA_NAMES,
  resolveTouches,
  InputState,
} from './controls.js';

const ROM_NAME = 'emerald-coop.gba';

export class CoopApp {
  constructor({ canvas, overlay, onStatus, onLog }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});

    this.core = null;
    this.mailbox = null;
    this.bridge = null;
    this.client = null;
    this.input = new InputState();
    this.layout = DEFAULT_LAYOUT;
    this.heapBuffer = null;
    this.running = false;
    this.pumpErrors = 0;
  }

  log(msg) {
    this.onLog(msg);
  }

  /**
   * @param {object} opts
   * @param {File} opts.romFile the built co-op .gba
   * @param {File|null} opts.saveFile optional .sav to restore
   * @param {string} opts.relayUrl
   * @param {string} opts.session
   * @param {number|null} opts.slot
   */
  async start({ romFile, saveFile, relayUrl, session, slot }) {
    if (this.running) throw new Error('already running');

    if (typeof SharedArrayBuffer === 'undefined') {
      // The core is a pthread build, so without cross-origin isolation it
      // cannot start at all. Say exactly what is wrong rather than letting it
      // fail somewhere deep in the glue.
      throw new Error(
        'This page is not cross-origin isolated, so the emulator cannot start. ' +
          'It must be served with Cross-Origin-Opener-Policy: same-origin and ' +
          'Cross-Origin-Embedder-Policy: require-corp.'
      );
    }

    this.log('booting emulator core…');
    this.core = await mGBA({ canvas: this.canvas });
    this.core.setLogger?.(() => {}); // mGBA's own log is noisy; we have our own

    await this.core.FSInit();

    this.log('loading ROM…');
    await new Promise((resolve) => this.core.uploadRom(romFile, resolve));

    if (saveFile) {
      this.log('restoring save…');
      await new Promise((resolve) => this.core.uploadSaveOrSaveState(saveFile, resolve));
    }

    if (!this.core.loadGame(`${this.core.filePaths().gamePath}/${romFile.name}`)) {
      // Fall back to the name mGBA may have stored it under.
      if (!this.core.loadGame(`${this.core.filePaths().gamePath}/${ROM_NAME}`)) {
        throw new Error(`mGBA could not load ${romFile.name}`);
      }
    }

    this.running = true;
    this.attachInput();
    this.log('emulator running; looking for the co-op mailbox…');

    // The ROM publishes the mailbox early in AgbMain, but "early" is still a
    // few frames after loadGame returns, so poll briefly rather than giving up.
    await this.findMailboxWithRetry();

    this.connect({ relayUrl, session, slot });

    // keysReadCallback fires once per emulated frame, at the point the core
    // polls input. That is exactly the cadence the link protocol expects: one
    // command set per frame, with the CPU between steps.
    this.core.addCoreCallbacks({
      keysReadCallback: () => this.onFrame(),
      coreCrashedCallback: () => {
        this.log('EMULATOR CRASHED');
        this.onStatus({ fatal: 'the emulator core crashed' });
      },
    });

    this.log('co-op active');
  }

  async findMailboxWithRetry({ attempts = 240 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const buffer = this.core.coopHeapBuffer;
      if (buffer) {
        const found = findAllMailboxes(buffer);

        if (found.length === 1) {
          this.adoptMailbox(buffer, found[0]);
          return;
        }

        if (found.length > 1) {
          // More than one copy of EWRAM carries our magic -- rewind snapshots
          // and save states both contain a full image. Rather than guess,
          // watch which one's heartbeat is ticking: only the live mailbox
          // advances, because the ROM bumps it every VBlank from boot.
          const live = await this.resolveLiveMailbox(buffer, found);
          if (live !== null) {
            this.adoptMailbox(this.core.coopHeapBuffer || buffer, live);
            this.log(`resolved ${found.length} candidates by heartbeat`);
            return;
          }
          // Not decidable yet; fall through and try again next pass. The
          // emulator may still be on its first frames.
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    throw new Error(
      'no live co-op mailbox found in emulator memory. Either this is not a ' +
        'co-op build of the ROM, or tools/patch-mgba.mjs has not been run ' +
        'against the installed mgba-wasm.'
    );
  }

  adoptMailbox(buffer, offset) {
    this.heapBuffer = buffer;
    this.mailbox = new Mailbox(buffer, offset);
    this.log(`mailbox found at heap offset 0x${offset.toString(16)}`);
  }

  /**
   * Sample each candidate's heartbeat across several frames and return the one
   * that is advancing. Returns null if it cannot be decided, so the caller can
   * retry rather than commit to a dead buffer.
   */
  async resolveLiveMailbox(buffer, offsets, { rounds = 4, gapMs = 40 } = {}) {
    const readings = [];

    for (let r = 0; r < rounds; r++) {
      const buf = this.core.coopHeapBuffer || buffer;
      const view = new DataView(buf);
      readings.push(offsets.map((off) => view.getUint16(off + 0x0e, true)));
      if (r < rounds - 1) await new Promise((res) => setTimeout(res, gapMs));
    }

    return pickLiveMailbox(offsets, readings);
  }

  connect({ relayUrl, session, slot }) {
    this.bridge = new Bridge({
      mailbox: this.mailbox,
      link: { send: (cmd) => this.client.send(cmd) },
      onEvent: (e) => this.onBridgeEvent(e),
    });

    this.client = new NetClient({
      url: relayUrl,
      session,
      slot,
      onFrame: (f) => this.bridge.onPeerFrame(f.cmd),
      onSession: ({ status, localId, playerCount }) => {
        this.bridge.setIdentity({ localId, playerCount });
        this.bridge.setStatus(status);
        this.publishStatus();
      },
      onEvent: (e) => {
        this.log(`net: ${e.type}${e.detail ? ` — ${e.detail}` : ''}`);
        if (e.type === 'fatal') this.onStatus({ fatal: `${e.code}: ${e.detail}` });
        this.publishStatus();
      },
    });

    this.client.connect();
  }

  onBridgeEvent(e) {
    switch (e.type) {
      case 'session-ready':
        this.log(`session ready — you are player ${e.localId + 1}`);
        break;
      case 'peer-lost':
        this.log('partner disconnected');
        // Release everything: a direction left held while the game stalls would
        // keep walking the moment the link comes back.
        this.applyInput(this.input.clear());
        break;
      case 'peer-backlog-overflow':
        this.log('WARNING: partner is too far ahead; frames are being dropped');
        break;
      case 'loopback-lost':
        this.log('FATAL: a local frame was lost — the session is desynced');
        this.onStatus({ fatal: 'desynced: a local link frame was lost' });
        break;
    }
    this.publishStatus();
  }

  /** Runs once per emulated frame. Must be cheap and must never throw. */
  onFrame() {
    try {
      // WASM memory growth hands out a new buffer and detaches every view, so
      // re-point the mailbox rather than reading through a dead one.
      const buffer = this.core.coopHeapBuffer;
      if (buffer && buffer !== this.heapBuffer) {
        this.heapBuffer = buffer;
        this.mailbox.rebind(buffer);
        this.log('emulator memory grew; mailbox rebound');
      }

      this.bridge.pump();
    } catch (err) {
      // Throwing out of a core callback would tear down the emulator loop.
      this.pumpErrors++;
      if (this.pumpErrors <= 3) this.log(`pump error: ${err.message}`);
    }
  }

  // --- input ---------------------------------------------------------------

  attachInput() {
    const el = this.overlay;
    const handler = (ev) => {
      ev.preventDefault();
      this.applyInput(this.input.diff(this.readTouches(ev)));
    };

    // passive: false is required for preventDefault to actually suppress
    // scrolling and the double-tap zoom on iOS.
    const opts = { passive: false };
    el.addEventListener('touchstart', handler, opts);
    el.addEventListener('touchmove', handler, opts);
    el.addEventListener('touchend', handler, opts);
    el.addEventListener('touchcancel', handler, opts);

    // A backgrounded tab stops delivering touchend, which would leave a
    // direction stuck down. Release everything when we lose visibility.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.applyInput(this.input.clear());
    });
    window.addEventListener('blur', () => this.applyInput(this.input.clear()));
  }

  readTouches(ev) {
    const rect = this.overlay.getBoundingClientRect();
    const points = [];
    for (const t of ev.touches) {
      points.push({
        x: (t.clientX - rect.left) / rect.width,
        y: (t.clientY - rect.top) / rect.height,
      });
    }
    return resolveTouches(this.layout, points);
  }

  applyInput({ press, release }) {
    if (!this.core) return;
    for (const b of release) this.core.buttonUnpress(MGBA_NAMES[b]);
    for (const b of press) this.core.buttonPress(MGBA_NAMES[b]);
  }

  // --- status and saves ----------------------------------------------------

  publishStatus() {
    if (!this.bridge) {
      this.onStatus({ status: HOST_DOWN });
      return;
    }
    const s = this.bridge.snapshot();
    this.onStatus({
      status: s.status,
      label:
        s.status === HOST_READY
          ? `connected — player ${s.localId + 1}`
          : s.status === HOST_CONNECTING
            ? 'waiting for your partner…'
            : s.status === HOST_LOST
              ? 'partner disconnected'
              : 'not connected',
      rtt: this.client?.rtt ?? null,
      stats: s.stats,
      peerQueue: s.peerQueue,
    });
  }

  /**
   * Hand the player their save file.
   *
   * Built early and deliberately: a two-players-required ROM means a dead
   * relay locks both of you out of your own game, so the save must never be
   * trapped behind a service.
   */
  async exportSave() {
    if (!this.core) throw new Error('not running');
    // Flush anything the emulator still has buffered before reading it back.
    await this.core.FSSync();
    const data = this.core.getSave();
    if (!data) throw new Error('no save data yet — play a little first');
    return new Blob([data], { type: 'application/octet-stream' });
  }

  async stop() {
    this.running = false;
    this.applyInput(this.input.clear());
    this.client?.close();
    try {
      await this.core?.FSSync();
    } catch {
      // Best effort; we are shutting down anyway.
    }
    this.core?.pauseGame();
  }
}
