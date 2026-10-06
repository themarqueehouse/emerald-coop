'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BTN,
  MGBA_NAMES,
  DEFAULT_LAYOUT as L,
  TOUCH_SLOP,
  DPAD_DEADZONE,
  dpadDirections,
  buttonAt,
  resolveTouches,
  InputState,
} from '../src/controls.js';

/** A point at angle `deg` and `frac` of the d-pad radius, in screen coords. */
function onDpad(deg, frac = 0.8) {
  const a = (deg * Math.PI) / 180;
  const { cx, cy, r } = L.dpad;
  return { x: cx + Math.cos(a) * r * frac, y: cy - Math.sin(a) * r * frac };
}

function at(id) {
  return L.buttons.find((b) => b.id === id);
}

// ---------------------------------------------------------------------------
// d-pad
// ---------------------------------------------------------------------------

test('the four cardinal directions resolve correctly', () => {
  assert.deepEqual(dpadDirections(L, onDpad(0).x, onDpad(0).y), [BTN.RIGHT]);
  assert.deepEqual(dpadDirections(L, onDpad(90).x, onDpad(90).y), [BTN.UP]);
  assert.deepEqual(dpadDirections(L, onDpad(180).x, onDpad(180).y), [BTN.LEFT]);
  assert.deepEqual(dpadDirections(L, onDpad(270).x, onDpad(270).y), [BTN.DOWN]);
});

test('up is up — screen y is inverted and must not be mixed up', () => {
  // A regression guard: getting this backwards is the classic bug here, and
  // it would make the game playable-but-wrong in a very confusing way.
  const { cx, cy, r } = L.dpad;
  const above = { x: cx, y: cy - r * 0.8 };
  assert.deepEqual(dpadDirections(L, above.x, above.y), [BTN.UP]);
  const below = { x: cx, y: cy + r * 0.8 };
  assert.deepEqual(dpadDirections(L, below.x, below.y), [BTN.DOWN]);
});

test('diagonals press two directions at once', () => {
  for (const [deg, want] of [
    [45, [BTN.RIGHT, BTN.UP]],
    [135, [BTN.UP, BTN.LEFT]],
    [225, [BTN.LEFT, BTN.DOWN]],
    [315, [BTN.RIGHT, BTN.DOWN]],
  ]) {
    const p = onDpad(deg);
    const got = dpadDirections(L, p.x, p.y);
    assert.equal(got.length, 2, `${deg} deg gives two directions, got ${got}`);
    assert.deepEqual(new Set(got), new Set(want), `${deg} deg`);
  }
});

test('the diagonal band is wide enough to hold comfortably', () => {
  // Walking around corners and Acro Bike tricks need diagonals to be holdable,
  // not a knife edge. Anything within ~15 degrees of the diagonal should hold.
  for (const deg of [32, 45, 58]) {
    const p = onDpad(deg);
    assert.equal(dpadDirections(L, p.x, p.y).length, 2, `${deg} deg still diagonal`);
  }
});

test('the centre deadzone presses nothing', () => {
  const { cx, cy } = L.dpad;
  assert.deepEqual(dpadDirections(L, cx, cy), [], 'dead centre');
  const inside = onDpad(45, DPAD_DEADZONE * 0.5);
  assert.deepEqual(dpadDirections(L, inside.x, inside.y), [], 'inside deadzone');
});

test('a touch well outside the d-pad presses nothing', () => {
  const far = onDpad(0, TOUCH_SLOP + 0.5);
  assert.deepEqual(dpadDirections(L, far.x, far.y), []);
  assert.deepEqual(dpadDirections(L, 0.5, 0.5), [], 'middle of the screen');
});

test('touch slop extends the d-pad slightly past its drawn edge', () => {
  const justOutside = onDpad(90, 1.15);
  assert.deepEqual(
    dpadDirections(L, justOutside.x, justOutside.y),
    [BTN.UP],
    'a finger landing just past the edge still registers'
  );
});

// ---------------------------------------------------------------------------
// face and shoulder buttons
// ---------------------------------------------------------------------------

test('each button is hit at its own centre', () => {
  for (const b of L.buttons) {
    assert.equal(buttonAt(L, b.cx, b.cy), b.id, `${b.id} at centre`);
  }
});

test('no button is hit in empty space', () => {
  assert.equal(buttonAt(L, 0.5, 0.35), null);
});

test('overlapping slop resolves to the nearest button, not array order', () => {
  const a = at(BTN.A);
  const b = at(BTN.B);
  // A point biased strongly toward A must give A even though B is listed later.
  const x = a.cx + (b.cx - a.cx) * 0.2;
  const y = a.cy + (b.cy - a.cy) * 0.2;
  assert.equal(buttonAt(L, x, y), BTN.A);

  const x2 = b.cx + (a.cx - b.cx) * 0.2;
  const y2 = b.cy + (a.cy - b.cy) * 0.2;
  assert.equal(buttonAt(L, x2, y2), BTN.B);
});

test('A and B are far enough apart not to be hit together', () => {
  // If one finger could press both, battles would be miserable.
  const a = at(BTN.A);
  assert.equal(buttonAt(L, a.cx, a.cy), BTN.A);
  const pressed = resolveTouches(L, [{ x: a.cx, y: a.cy }]);
  assert.deepEqual([...pressed], [BTN.A]);
});

test('Start and Select sit clear of the face buttons', () => {
  for (const id of [BTN.START, BTN.SELECT]) {
    const s = at(id);
    const pressed = resolveTouches(L, [{ x: s.cx, y: s.cy }]);
    assert.deepEqual([...pressed], [id], `${id} is unambiguous`);
  }
});

test('no two buttons overlap at their drawn radii', () => {
  for (let i = 0; i < L.buttons.length; i++) {
    for (let j = i + 1; j < L.buttons.length; j++) {
      const p = L.buttons[i];
      const q = L.buttons[j];
      const d = Math.hypot(p.cx - q.cx, p.cy - q.cy);
      assert.ok(d > p.r + q.r, `${p.id} and ${q.id} must not overlap (d=${d.toFixed(3)})`);
    }
  }
});

test('every control sits inside the overlay box', () => {
  const { cx, cy, r } = L.dpad;
  assert.ok(cx - r >= 0 && cx + r <= 1, 'dpad within x');
  assert.ok(cy - r >= 0 && cy + r <= 1, 'dpad within y');
  for (const b of L.buttons) {
    assert.ok(b.cx - b.r >= 0 && b.cx + b.r <= 1, `${b.id} within x`);
    assert.ok(b.cy - b.r >= 0 && b.cy + b.r <= 1, `${b.id} within y`);
  }
});

// ---------------------------------------------------------------------------
// multi-touch
// ---------------------------------------------------------------------------

test('running works: B held with a direction', () => {
  // The single most common two-finger combination in the whole game.
  const b = at(BTN.B);
  const dir = onDpad(180);
  const pressed = resolveTouches(L, [
    { x: dir.x, y: dir.y },
    { x: b.cx, y: b.cy },
  ]);
  assert.deepEqual(new Set(pressed), new Set([BTN.LEFT, BTN.B]));
});

test('three simultaneous touches all register', () => {
  const a = at(BTN.A);
  const r = at(BTN.R);
  const dir = onDpad(45);
  const pressed = resolveTouches(L, [
    { x: dir.x, y: dir.y },
    { x: a.cx, y: a.cy },
    { x: r.cx, y: r.cy },
  ]);
  assert.deepEqual(new Set(pressed), new Set([BTN.RIGHT, BTN.UP, BTN.A, BTN.R]));
});

test('opposite directions from two touches cancel', () => {
  // The hardware cannot report left and right together; letting both through
  // makes the avatar stutter in place.
  const left = onDpad(180);
  const right = onDpad(0);
  const pressed = resolveTouches(L, [
    { x: left.x, y: left.y },
    { x: right.x, y: right.y },
  ]);
  assert.ok(!pressed.has(BTN.LEFT) && !pressed.has(BTN.RIGHT), 'both cancelled');
});

test('no touches means nothing pressed', () => {
  assert.equal(resolveTouches(L, []).size, 0);
});

// ---------------------------------------------------------------------------
// edge-triggered state
// ---------------------------------------------------------------------------

test('only changes are emitted, not the whole held state', () => {
  const s = new InputState();

  let d = s.diff(new Set([BTN.RIGHT]));
  assert.deepEqual(d, { press: [BTN.RIGHT], release: [] });

  // A held button must not re-press every frame: 60 presses a second would
  // swamp the emulator and break anything that counts button-down edges.
  d = s.diff(new Set([BTN.RIGHT]));
  assert.deepEqual(d, { press: [], release: [] }, 'holding emits nothing');

  d = s.diff(new Set([BTN.RIGHT, BTN.B]));
  assert.deepEqual(d, { press: [BTN.B], release: [] });

  d = s.diff(new Set([BTN.B]));
  assert.deepEqual(d, { press: [], release: [BTN.RIGHT] });

  d = s.diff(new Set());
  assert.deepEqual(d, { press: [], release: [BTN.B] });
});

test('a direction change presses the new one and releases the old', () => {
  const s = new InputState();
  s.diff(new Set([BTN.LEFT]));
  const d = s.diff(new Set([BTN.RIGHT]));
  assert.deepEqual(d.press, [BTN.RIGHT]);
  assert.deepEqual(d.release, [BTN.LEFT]);
});

test('clear releases everything held', () => {
  const s = new InputState();
  s.diff(new Set([BTN.A, BTN.UP]));
  const d = s.clear();
  assert.deepEqual(new Set(d.release), new Set([BTN.A, BTN.UP]));
  assert.equal(s.pressed.size, 0);
  // Without this, backgrounding the tab mid-walk leaves a direction stuck down
  // and the player keeps moving after they come back.
  assert.deepEqual(s.diff(new Set()), { press: [], release: [] });
});

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

test('every button maps to an mGBA input name', () => {
  for (const id of Object.values(BTN)) {
    assert.ok(MGBA_NAMES[id], `${id} has an mGBA name`);
  }
  assert.equal(MGBA_NAMES[BTN.START], 'Start');
  assert.equal(MGBA_NAMES[BTN.SELECT], 'Select');
  assert.equal(MGBA_NAMES[BTN.UP], 'Up');
});
