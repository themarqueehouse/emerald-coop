# Deploying, from a phone

Three things to stand up. All driven from a browser once the repo is on GitHub.

## 1. The ROM — GitHub Actions

Actions tab → **Build co-op ROM** → **Run workflow**. About 10 minutes.
Download the `emerald-coop-rom` artifact; it contains:

- `pokeemerald_modern.gba` — the ROM, for both phones
- `coop-config.json` — where the mailbox landed (informational; the wrapper
  finds it by scanning, so you do not need to feed this in)

The job fails if `gNetMailbox` is missing from the linker map, so a ROM that
built but has no co-op transport cannot slip through looking healthy.

## 2. The relay — Railway or Render

Both deploy from a GitHub repo through their web UI, no CLI.

- Root directory: `coop/relay`
- It will find the `Dockerfile`
- No environment variables needed; `$PORT` is injected

Note the public hostname it gives you. The wrapper wants it as
`wss://that-host` — **wss**, not ws, because the wrapper page is HTTPS and
browsers refuse a plaintext socket from a secure page.

Free tiers idle after inactivity, so the first connection of a session may take
a few seconds to wake. The wrapper retries with backoff, so this looks like a
brief wait rather than a failure.

## 3. The wrapper — Cloudflare Pages

Connect the repo, then:

- Build command: `cd coop/wrapper && npm install && npm run build`
- Output directory: `coop/wrapper/dist`

**It must be Cloudflare Pages or Netlify, not GitHub Pages.** The emulator core
is a threaded WASM build, so it needs `SharedArrayBuffer`, which browsers only
grant to a cross-origin isolated page. `dist/_headers` sets the two required
headers; GitHub Pages cannot serve custom headers and the emulator will refuse
to start there.

## 4. On the phones

1. Open the Pages URL.
2. **Add to Home Screen.** This launches standalone — no address bar, nothing
   to scroll, true full screen. It is the only reliable way to get that on iOS.
3. Open it from the home screen, landscape.
4. Fill in: relay address (`wss://…`), the same session code on both phones,
   who is Player 1, and pick the `.gba`.
5. **Only Player 1 loads the `.sav`.**

## First thing to test

A trade or a link battle in a Pokémon Center. That drives the entire transport
using Game Freak's own unmodified code, which makes it the cleanest possible
first test — if it works, the hard part works.

If the setup screen shows an error, the log panel beneath it says what failed.
The useful ones:

| Message | Meaning |
|---|---|
| not cross-origin isolated | The host is not sending the COOP/COEP headers. Not Cloudflare/Netlify, or the `_headers` file did not deploy. |
| no co-op mailbox found | The ROM is not a co-op build, or `patch-mgba.mjs` did not run. |
| found N mailbox candidates | Something else in memory carries the magic word. Refusing to guess; tell me. |
| `bad_version` | The two phones are running different builds. Rebuild both. |
| `slot_taken` | Both of you picked the same player number. |
