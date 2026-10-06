#!/usr/bin/env node
// Assemble the static site into dist/.
//
// No bundler on purpose. The page is a handful of ES modules and one WASM
// core; a bundler would add a build system to debug on top of the emulator and
// the netcode, for no benefit. This copies, patches, and writes the headers.

import { mkdirSync, copyFileSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');

const CORE_DIR = join(root, 'node_modules', '@thenick775', 'mgba-wasm', 'dist');
const CORE_FILES = ['mgba.js', 'mgba.wasm'];

// Cross-origin isolation. The core is a pthread build, so without these two
// headers SharedArrayBuffer is unavailable and the emulator cannot start at
// all. Cloudflare Pages and Netlify both read this file; GitHub Pages does not
// support custom headers and will not work without a service-worker shim.
const HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
`;

/**
 * Walk every built .js and .html file and confirm each relative import or
 * script src points at a file that exists. Bare specifiers would mean a
 * bundler is required, so those are reported too.
 */
function checkImports(dir) {
  const problems = [];
  const files = [];

  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), join(rel, e.name));
      else files.push({ abs: join(d, e.name), rel: join(rel, e.name) });
    }
  };
  walk(dir);

  // `from '...'`, `import '...'`, and `src="..."` in the HTML.
  const specRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|src=["']([^"']+)["']/g;

  for (const f of files) {
    if (!/\.(js|mjs|html)$/.test(f.rel)) continue;
    const src = readFileSync(f.abs, 'utf8');
    for (const m of src.matchAll(specRe)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (/^(https?:)?\/\//.test(spec) || spec.startsWith('data:')) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        // mgba.js resolves some optional node built-ins at runtime under
        // node; those never execute in a browser and are not our problem.
        if (/^(node:|fs|path|crypto|worker_threads|module|url|os)$/.test(spec)) continue;
        problems.push(`${f.rel}: bare specifier "${spec}" needs a bundler`);
        continue;
      }
      const resolved = join(dirname(f.abs), spec.split('?')[0]);
      if (!existsSync(resolved)) {
        problems.push(`${f.rel}: "${spec}" does not exist`);
      }
    }
  }

  return problems;
}

function main() {
  if (!existsSync(CORE_DIR)) {
    console.error(
      `error: ${CORE_DIR} not found.\nRun \`npm install\` in coop/wrapper first.`
    );
    return 1;
  }

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'vendor'), { recursive: true });

  // 1. The page and anything else static.
  for (const f of readdirSync(join(root, 'public'))) {
    copyFileSync(join(root, 'public', f), join(dist, f));
  }

  // 2. Our modules, flat alongside index.html so relative imports resolve.
  for (const f of readdirSync(join(root, 'src'))) {
    if (f.endsWith('.js')) copyFileSync(join(root, 'src', f), join(dist, f));
  }

  // 3. The emulator core.
  for (const f of CORE_FILES) {
    copyFileSync(join(CORE_DIR, f), join(dist, 'vendor', f));
  }

  // 4. Patch the copy, not node_modules, so a reinstall cannot silently ship
  //    an unpatched core and `npm ci` stays reproducible.
  execFileSync(process.execPath, [join(here, 'patch-mgba.mjs'), join(dist, 'vendor', 'mgba.js')], {
    stdio: 'inherit',
  });

  // The patcher leaves a backup next to its target; useful in node_modules,
  // dead weight in a deployed site (and it is over a megabyte).
  rmSync(join(dist, 'vendor', 'mgba.js.orig'), { force: true });

  // 5. Headers.
  writeFileSync(join(dist, '_headers'), HEADERS);

  // 6. Verify the module graph actually resolves. There is no bundler to
  //    catch a bad relative path, and a broken import shows up on a phone as
  //    a blank screen with the real error buried in a console nobody can see.
  const problems = checkImports(dist);
  if (problems.length) {
    console.error('\nerror: unresolved imports in the built output:');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log('import graph resolves');

  console.log(`\nbuilt ${dist}`);
  console.log('deploy that directory to a host that honours _headers');
  console.log('  Cloudflare Pages:  npx wrangler pages deploy dist');
  console.log('  local check:       npx http-server dist --cors -p 8080');
  console.log('\nNote: a plain static server WITHOUT the COOP/COEP headers will');
  console.log('serve the page but the emulator will refuse to start.');
  return 0;
}

process.exit(main());
