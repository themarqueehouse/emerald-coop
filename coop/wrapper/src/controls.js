'use strict';

// Touch control layout and hit-testing.
//
// Kept as pure geometry, separate from the DOM, because this is the part with
// real logic in it and the part most likely to feel wrong on a phone. Testing
// it without a browser means the tuning decisions below are at least provably
// doing what they claim.
//
// Layout is in normalized units (0..1 of the overlay box) so it scales to any
// screen without a second set of numbers.

export const BTN = {
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  A: 'a',
  B: 'b',
  L: 'l',
  R: 'r',
  START: 'start',
  SELECT: 'select',
};

// mGBA's input names, which is what buttonPress/buttonUnpress expect.
export const MGBA_NAMES = {
  [BTN.UP]: 'Up',
  [BTN.DOWN]: 'Down',
  [BTN.LEFT]: 'Left',
  [BTN.RIGHT]: 'Right',
  [BTN.A]: 'A',
  [BTN.B]: 'B',
  [BTN.L]: 'L',
  [BTN.R]: 'R',
  [BTN.START]: 'Start',
  [BTN.SELECT]: 'Select',
};

/**
 * Default landscape layout.
 *
 * Everything lives in the lower half, within thumb reach. On real hardware L
 * and R sit on the back edge, which maps naturally to the top of a screen --
 * but a thumb holding a phone in landscape cannot get there, so they go in the
 * bottom corners instead. Nothing overlaps the top of the picture.
 */
export const DEFAULT_LAYOUT = {
  dpad: { cx: 0.16, cy: 0.66, r: 0.15 },
  buttons: [
    { id: BTN.A, cx: 0.88, cy: 0.6, r: 0.072 },
    { id: BTN.B, cx: 0.75, cy: 0.72, r: 0.072 },
    { id: BTN.L, cx: 0.06, cy: 0.94, r: 0.055 },
    { id: BTN.R, cx: 0.94, cy: 0.94, r: 0.055 },
    { id: BTN.START, cx: 0.57, cy: 0.94, r: 0.05 },
    { id: BTN.SELECT, cx: 0.43, cy: 0.94, r: 0.05 },
  ],
};

// A finger is not a point. Buttons get a generous invisible margin so a touch
// landing just outside the drawn circle still counts -- without it, play feels
// unresponsive in exactly the way people blame on lag.
export const TOUCH_SLOP = 1.35;

// Inside this fraction of the d-pad radius, no direction is pressed. Prevents a
// thumb resting at the centre from emitting jittery directions.
export const DPAD_DEADZONE = 0.28;

// Half-width of each diagonal band, in radians. Pi/8 would make the four
// cardinals and four diagonals equal; a wider band makes diagonals easier to
// hold, which matters for walking around corners and for Acro Bike tricks.
export const DIAGONAL_BAND = Math.PI / 6;

function hypot(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Which directions a touch at (x, y) presses on the d-pad.
 * @returns {string[]} zero, one, or two of up/down/left/right
 */
export function dpadDirections(layout, x, y) {
  const { cx, cy, r } = layout.dpad;
  const dx = x - cx;
  // Screen y grows downward; flip so maths angles read naturally.
  const dy = -(y - cy);
  const d = hypot(dx, dy);

  if (d > r * TOUCH_SLOP) return [];
  if (d < r * DPAD_DEADZONE) return [];

  // Angle measured from +x (right), counter-clockwise.
  let a = Math.atan2(dy, dx);
  if (a < 0) a += Math.PI * 2;

  const out = [];
  const near = (target) => {
    let diff = Math.abs(a - target);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    return diff;
  };

  // A direction is pressed when the touch is within 45 degrees + half the
  // diagonal band of its axis, which is what lets two fire at once.
  const limit = Math.PI / 4 + DIAGONAL_BAND;
  if (near(0) < limit) out.push(BTN.RIGHT);
  if (near(Math.PI / 2) < limit) out.push(BTN.UP);
  if (near(Math.PI) < limit) out.push(BTN.LEFT);
  if (near((Math.PI * 3) / 2) < limit) out.push(BTN.DOWN);

  // Opposite directions cancel: the hardware cannot report both, and letting
  // them through makes the player avatar stutter.
  if (out.includes(BTN.LEFT) && out.includes(BTN.RIGHT)) {
    return out.filter((b) => b !== BTN.LEFT && b !== BTN.RIGHT);
  }
  if (out.includes(BTN.UP) && out.includes(BTN.DOWN)) {
    return out.filter((b) => b !== BTN.UP && b !== BTN.DOWN);
  }

  return out;
}

/** Which face/shoulder button a touch at (x, y) presses, if any. */
export function buttonAt(layout, x, y) {
  let best = null;
  let bestD = Infinity;

  for (const b of layout.buttons) {
    const d = hypot(x - b.cx, y - b.cy);
    // Nearest wins, so overlapping slop regions resolve predictably rather
    // than by array order.
    if (d <= b.r * TOUCH_SLOP && d < bestD) {
      best = b.id;
      bestD = d;
    }
  }

  return best;
}

/**
 * Resolve a set of active touches into the set of pressed buttons.
 *
 * Multi-touch is the point: running is B plus a direction, and plenty of the
 * game needs two or three at once. Each touch is resolved independently and
 * the results unioned.
 *
 * @param {{x:number,y:number}[]} touches normalized positions
 * @returns {Set<string>}
 */
export function resolveTouches(layout, touches) {
  const pressed = new Set();

  for (const t of touches) {
    for (const d of dpadDirections(layout, t.x, t.y)) pressed.add(d);
    const b = buttonAt(layout, t.x, t.y);
    if (b) pressed.add(b);
  }

  // Cancel opposites that arrived from separate touches, for the same reason
  // as within a single d-pad touch.
  if (pressed.has(BTN.LEFT) && pressed.has(BTN.RIGHT)) {
    pressed.delete(BTN.LEFT);
    pressed.delete(BTN.RIGHT);
  }
  if (pressed.has(BTN.UP) && pressed.has(BTN.DOWN)) {
    pressed.delete(BTN.UP);
    pressed.delete(BTN.DOWN);
  }

  return pressed;
}

/**
 * Tracks pressed state across frames and emits only the changes, so the
 * emulator sees one press and one release per button rather than a storm of
 * redundant calls every touchmove.
 */
export class InputState {
  constructor() {
    this.pressed = new Set();
  }

  /**
   * @param {Set<string>} next
   * @returns {{press: string[], release: string[]}}
   */
  diff(next) {
    const press = [];
    const release = [];

    for (const b of next) if (!this.pressed.has(b)) press.push(b);
    for (const b of this.pressed) if (!next.has(b)) release.push(b);

    this.pressed = new Set(next);
    return { press, release };
  }

  /** Release everything. Used when the page loses focus or a session ends. */
  clear() {
    const release = [...this.pressed];
    this.pressed.clear();
    return { press: [], release };
  }
}
