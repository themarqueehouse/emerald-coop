#!/usr/bin/env node
// Patch the mgba-wasm Emscripten glue to expose the WASM memory buffer.
//
// Why this is needed
// -----------------
// The co-op transport works by reading and writing a mailbox the ROM publishes
// in emulated EWRAM. @thenick775/mgba-wasm ships no memory-access API: its
// HEAPU8 is a module-scope variable that is never attached to the returned
// Module, and none of its cwrap exports touch the bus. So as shipped, there is
// no way to reach the mailbox from JS.
//
// The alternative to this patch is forking mGBA and rebuilding it under Docker
// with emscripten, adding exported accessors. That is the "proper" fix, and it
// is also a toolchain most people will not set up. This patch gets the same
// capability by adding one line to the generated glue.
//
// What it does
// ------------
// Inserts `Module["coopHeapBuffer"] = b;` inside updateMemoryViews(), which is
// the function Emscripten calls on init AND on every memory growth. Exposing
// the ArrayBuffer rather than a typed-array view is deliberate: views are
// detached when WASM memory grows, so a cached Uint8Array would silently go
// dead. Callers build a fresh view from the buffer each time.
//
// Run it after `npm install`, and re-run after any upgrade of the package.
// It is idempotent and refuses to corrupt a file it does not recognise.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const MARKER = 'Module["coopHeapBuffer"]';
const ANCHOR = 'function updateMemoryViews(){var b=wasmMemory.buffer;';
const INJECT = `${ANCHOR}${MARKER}=b;`;

function main() {
  const target =
    argv[2] || 'node_modules/@thenick775/mgba-wasm/dist/mgba.js';

  if (!existsSync(target)) {
    console.error(
      `error: ${target} not found.\n` +
        'Run `npm install` in coop/wrapper first.'
    );
    return 1;
  }

  const src = readFileSync(target, 'utf8');

  if (src.includes(MARKER)) {
    console.log(`already patched: ${target}`);
    return 0;
  }

  const hits = src.split(ANCHOR).length - 1;
  if (hits !== 1) {
    console.error(
      `error: expected exactly 1 occurrence of the updateMemoryViews anchor in\n` +
        `  ${target}\n` +
        `but found ${hits}. The upstream glue has changed shape; this patch must be\n` +
        `reviewed by hand rather than applied blindly.\n\n` +
        `Anchor sought:\n  ${ANCHOR}`
    );
    return 1;
  }

  copyFileSync(target, `${target}.orig`);
  writeFileSync(target, src.replace(ANCHOR, INJECT), 'utf8');

  console.log(
    `patched ${target}\n` +
      `  backup: ${target}.orig\n` +
      `  Module.coopHeapBuffer now exposes the live WASM memory buffer.`
  );
  return 0;
}

exit(main());
