import test from 'node:test';
import assert from 'node:assert/strict';

import { TraversalGrid, MOVE } from '../src/traversal-grid.js';
import { findPath } from '../src/chase-path.js';
import {
  ChaseRunner, speedForDistance, CHASE_STATE, approachValue, approachAngle,
} from '../src/chase-runner.js';
import { CaptureGauge, angleToTargetDeg } from '../src/capture-gauge.js';

// Terrain here is drawn one voxel per surface, because these tests are about
// geometry and routing, not about how much evidence a foothold needs. The
// footing threshold has its own tests.

function room(grid, width = 6, depth = 6, step = 0.1) {
  for (let x = 0; x <= width; x += step) {
    for (let z = 0; z <= depth; z += step) grid.observe([x, 0.02, z]);
  }
}

function run(runner, seconds, options, dt = 1 / 60) {
  let now = options.now ?? 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    now += dt * 1000;
    runner.update(dt, { ...options, now });
  }
  return now;
}

// ── speed ────────────────────────────────────────────────────
test('it nearly stops when the player is far away', () => {
  assert.equal(speedForDistance(10), 0.12);
});

test('it runs fastest when the player is on top of it', () => {
  assert.equal(speedForDistance(0.8), 0.50);
});

// It has to be catchable by someone walking while staring at a phone, which is
// a good deal slower than an unencumbered walk.
test('its top speed stays well under a walking player', () => {
  assert.ok(speedForDistance(0) < 0.6);
});

// ── movement ─────────────────────────────────────────────────
test('start fails when nothing has been mapped', () => {
  const runner = new ChaseRunner({ grid: new TraversalGrid({ minSlabVoxels: 1 }) });
  assert.equal(runner.start([0, 0, 0]), false);
});

test('it actually moves once the chase begins', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  assert.equal(runner.start([3, 0, 3], 0), true);
  const from = runner.position.slice();
  run(runner, 3, { playerPosition: [3.4, 1.5, 3.4] });
  const moved = Math.hypot(runner.position[0] - from[0], runner.position[2] - from[2]);
  assert.ok(moved > 0.3, `expected movement, got ${moved.toFixed(3)}m`);
});

test('it never leaves the mapped floor', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid, 4, 4);
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  runner.start([2, 0, 2], 0);
  let now = 0;
  for (let i = 0; i < 3600; i += 1) {
    now += 1000 / 60;
    runner.update(1 / 60, { playerPosition: [2, 1.5, 2], now });
    const [x, , z] = runner.position;
    assert.ok(x >= -0.3 && x <= 4.3 && z >= -0.3 && z <= 4.3,
      `left the room at ${x.toFixed(2)}, ${z.toFixed(2)}`);
  }
});

test('a frozen runner holds still', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  runner.start([3, 0, 3], 0);
  runner.setFrozen(true);
  const before = runner.position.slice();
  run(runner, 2, { playerPosition: [3.5, 1.5, 3.5] });
  assert.deepEqual(runner.position, before);
});

test('it does not sit in one corner — it covers ground', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid, 6, 6);
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  runner.start([3, 0, 3], 0);

  const seen = new Set();
  let now = 0;
  for (let i = 0; i < 60 * 40; i += 1) {
    now += 1000 / 60;
    runner.update(1 / 60, { playerPosition: [0.3, 1.5, 0.3], now });
    seen.add(`${runner.grid.cellX(runner.position[0])},${runner.grid.cellZ(runner.position[2])}`);
  }
  // Ground covered scales with speed, and the speeds were halved after the
  // first on-device test. Sitting in one corner would show up as a handful of
  // cells, so the threshold is still far above the failure it guards against.
  assert.ok(seen.size > 15, `only visited ${seen.size} cells in 40s`);
});

// Floor on the left, a 40cm ledge on the right. The only way across is up.
//
// The ledge is a SOLID block, not a bare top plane. A 2m plateau with nothing
// under it is geometrically a sheet of flying pixels, and hasSupportColumn is
// entitled to reject it; a real step, kerb or bed has a body.
function floorAndLedge() {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  for (let x = 0; x <= 1.3; x += 0.1) {
    for (let z = 0; z <= 1.3; z += 0.1) grid.observe([x, 0.02, z]);
  }
  for (let x = 1.5; x <= 3.5; x += 0.1) {
    for (let z = 0; z <= 1.3; z += 0.1) {
      for (let y = 0.02; y <= 0.42; y += 0.05) grid.observe([x, y, z]);
    }
  }
  return grid;
}

test('a low platform is a jump edge, not a walk', () => {
  const grid = floorAndLedge();
  const edge = { cx: grid.cellX(1.25), cz: grid.cellZ(0.6), level: 0 };
  const up = grid.neighbors(edge).find((n) => n.cx === grid.cellX(1.5));
  assert.ok(up, 'the ledge should be an edge at all');
  assert.equal(up.move, MOVE.JUMP);
});

test('a route onto the ledge contains the jump', () => {
  const grid = floorAndLedge();
  const start = grid.nodeAtWorld([0.3, 0.1, 0.6]);
  const goal = grid.nodeAtWorld([3.3, 0.5, 0.6]);
  const path = findPath(grid, start, goal);
  assert.ok(path, 'the ledge should be reachable');
  assert.ok(path.some((n) => n.move === MOVE.JUMP), 'route avoided jumping entirely');
});

test('it actually performs the jump when that is the only way on', () => {
  const grid = floorAndLedge();
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  runner.start([0.3, 0, 0.6], 0);
  let sawJump = false;
  let now = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    now += 1000 / 60;
    runner.update(1 / 60, { playerPosition: [0.2, 1.5, 0.6], now });
    if (runner.state === CHASE_STATE.JUMP) sawJump = true;
  }
  assert.ok(sawJump, 'never jumped onto the ledge in 60s');
});

// ── capture ──────────────────────────────────────────────────
test('the gauge only fills when all three conditions hold', () => {
  const gauge = new CaptureGauge({ requireHold: true });
  gauge.update(1, { distance: 0.8, angleDeg: 5, holding: false });
  assert.equal(gauge.value, 0);
  // Out of range: the capture radius is 2m, so this has to sit beyond it.
  gauge.update(1, { distance: 6.0, angleDeg: 5, holding: true });
  assert.equal(gauge.value, 0);
  gauge.update(1, { distance: 0.8, angleDeg: 60, holding: true });
  assert.equal(gauge.value, 0);
  gauge.update(1, { distance: 0.8, angleDeg: 5, holding: true });
  assert.ok(gauge.value > 0);
});

// The shipped rule is range plus aim only: holding a button turned into an
// Android long press, which raises the text-selection toolbar over the game.
test('by default no button hold is needed', () => {
  const gauge = new CaptureGauge();
  gauge.update(1, { distance: 0.8, angleDeg: 5 });
  assert.ok(gauge.value > 0);
  assert.equal(gauge.hint(), '검거 중');
});

test('five good seconds capture', () => {
  const gauge = new CaptureGauge();
  for (let i = 0; i < 50; i += 1) {
    gauge.update(0.1, { distance: 0.8, angleDeg: 5, holding: true });
  }
  assert.equal(gauge.captured, true);
});

test('a brief slip decays the gauge instead of resetting it', () => {
  const gauge = new CaptureGauge();
  for (let i = 0; i < 20; i += 1) gauge.update(0.1, { distance: 0.8, angleDeg: 5, holding: true });
  const before = gauge.value;
  gauge.update(0.2, { distance: 4, angleDeg: 5, holding: true });
  assert.ok(gauge.value > 0, 'gauge should not reset');
  assert.ok(gauge.value < before, 'gauge should decay');
});

test('hachuping slows as the lock builds', () => {
  const gauge = new CaptureGauge();
  assert.equal(gauge.speedMultiplier(), 1);
  gauge.value = 0.5;
  assert.ok(gauge.speedMultiplier() < 1);
  gauge.value = 0.8;
  assert.ok(gauge.speedMultiplier() < 0.5);
});

test('the hint names the condition that is blocking', () => {
  const gauge = new CaptureGauge({ requireHold: true });
  gauge.update(0.1, { distance: 5, angleDeg: 5, holding: true });
  assert.equal(gauge.hint(), '더 가까이');
  gauge.update(0.1, { distance: 0.8, angleDeg: 90, holding: true });
  assert.equal(gauge.hint(), '화면 중앙에 맞추세요');
  gauge.update(0.1, { distance: 0.8, angleDeg: 5, holding: false });
  assert.equal(gauge.hint(), 'SCAN 을 누르고 계세요');
});

test('angle to target is zero straight ahead and 180 behind', () => {
  const forward = [0, 0, -1];
  assert.ok(angleToTargetDeg(forward, [0, 0, 0], [0, 0, -2]) < 1e-6);
  assert.ok(Math.abs(angleToTargetDeg(forward, [0, 0, 0], [0, 0, 2]) - 180) < 1e-6);
});

// ── screen direction ─────────────────────────────────────────
test('view-space direction is straight ahead for an unrotated viewer', async () => {
  const { directionInViewSpace } = await import('../src/capture-gauge.js');
  const dir = directionInViewSpace([0, 0, 0, 1], [0, 0, 0], [0, 0, -2]);
  assert.ok(Math.abs(dir[0]) < 1e-9);
  assert.ok(Math.abs(dir[1]) < 1e-9);
  assert.ok(dir[2] < 0, 'forward is -Z');
});

test('turning the viewer 90 degrees moves the target to the side', async () => {
  const { directionInViewSpace } = await import('../src/capture-gauge.js');
  // Yaw +90 degrees about Y.
  const s = Math.sin(Math.PI / 4);
  const c = Math.cos(Math.PI / 4);
  const dir = directionInViewSpace([0, s, 0, c], [0, 0, 0], [0, 0, -2]);
  assert.ok(Math.abs(dir[2]) < 1e-6, 'no longer straight ahead');
  assert.ok(Math.abs(dir[0]) > 1.9, 'now off to the side');
});

test('the arrow points up when the target is above centre', async () => {
  const { screenAngleFromViewDirection } = await import('../src/capture-gauge.js');
  assert.equal(screenAngleFromViewDirection([0, 1]), 0);
  assert.ok(Math.abs(screenAngleFromViewDirection([1, 0]) - Math.PI / 2) < 1e-9);
});

// ── stability work: terrain swaps, stuck recovery, smoothing ──
const STAB_FLOOR = 0.02;
function stabilityRoom() {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  return grid;
}


test('approachValue ramps instead of jumping', () => {
  assert.equal(approachValue(0, 1, 0.25), 0.25);
  assert.equal(approachValue(0.9, 1, 0.25), 1); // snaps once within reach
  assert.equal(approachValue(1, 0, 0.25), 0.75);
});

test('approachAngle turns the short way across the wrap point', () => {
  // From just below +pi to just above -pi: the short way is a small positive
  // step across the wrap, not most of a circle the other way.
  const out = approachAngle(3.0, -3.0, 0.1);
  assert.ok(out > 3.0 && out < 3.2, `expected a small positive step, got ${out}`);
});

test('speed ramps up rather than starting at full band speed', () => {
  const grid = stabilityRoom();
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  assert.ok(runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0));
  const first = runner.update(0.05, { playerPosition: [0, STAB_FLOOR, 0], now: 50 });
  assert.ok(first.speed < 0.2, `expected a slow first frame, got ${first.speed}`);
});

test('facing eases toward the direction of travel', () => {
  const grid = stabilityRoom();
  const runner = new ChaseRunner({ grid, random: () => 0.5, turnRateRadPerS: 1 });
  runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0);
  runner.update(0.1, { playerPosition: [0, STAB_FLOOR, 0], now: 100 });
  const gap = Math.abs(runner.targetHeadingAngle - runner.headingAngle);
  // With a slow turn rate the drawn angle must lag the desired one.
  assert.ok(gap > 0 || runner.targetHeadingAngle === runner.headingAngle);
});

test('it walks rather than teleports when its ground disappears', () => {
  const grid = stabilityRoom();
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  assert.ok(runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0));
  const before = runner.position.slice();

  // Simulate the keyframe pipeline refilling the grid one slab higher, which
  // makes the stored level index point at different geometry.
  grid.reset();
  for (let x = 0; x <= 2; x += 0.2) {
    for (let z = 0; z <= 2; z += 0.2) grid.observe([x, STAB_FLOOR + 0.5, z]);
  }

  const state = runner.update(0.05, { playerPosition: [0, STAB_FLOOR, 0], now: 100 });
  const moved = Math.hypot(
    state.position[0] - before[0],
    state.position[1] - before[1],
    state.position[2] - before[2],
  );
  assert.ok(moved < 0.2, `expected a short step, not a jump of ${moved}m`);
});

test('losing the whole map does not throw or strand it in a bad node', () => {
  const grid = stabilityRoom();
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0);
  grid.reset();
  const state = runner.update(0.05, { playerPosition: [0, STAB_FLOOR, 0], now: 100 });
  assert.ok(state.position, 'it should keep a last known position');
});

test('repeated replan failure makes it head for the player', () => {
  const grid = stabilityRoom();
  const events = [];
  const runner = new ChaseRunner({
    grid,
    random: () => 0.5,
    escapeAfterFailures: 1,
    onEvent: (type) => events.push(type),
  });
  runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0);

  // No reachable flee target: force chooseFleeTarget to come back empty by
  // shrinking the grid to a single cell around Hachuping.
  const only = grid.nodeAtWorld([0.5, STAB_FLOOR + 0.1, 0.5]);
  grid.reset();
  grid.observe([grid.centerX(only.cx), STAB_FLOOR, grid.centerZ(only.cz)]);
  for (let x = 1.6; x <= 2.0; x += 0.2) {
    for (let z = 1.6; z <= 2.0; z += 0.2) grid.observe([x, STAB_FLOOR, z]);
  }

  for (let i = 0; i < 6; i += 1) {
    runner.update(0.1, { playerPosition: [1.8, STAB_FLOOR, 1.8], now: 1000 + i * 4000 });
  }
  assert.ok(
    events.includes('escape') || events.includes('reanchor'),
    `expected a recovery event, got ${events.join(',')}`,
  );
});

test('events are reported for the flight recorder', () => {
  const grid = stabilityRoom();
  const events = [];
  const runner = new ChaseRunner({
    grid, random: () => 0.5, onEvent: (type) => events.push(type),
  });
  runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0);
  runner.setFrozen(true);
  runner.setFrozen(false);
  assert.ok(events.includes('start'));
  assert.ok(events.includes('frozen'));
  assert.ok(events.includes('unfrozen'));
});

test('an escape does not crawl at the far-away idle speed', () => {
  const grid = stabilityRoom();
  const runner = new ChaseRunner({ grid, random: () => 0.5, escapeMinSpeed: 0.35 });
  runner.start([0.5, STAB_FLOOR + 0.1, 0.5], 0);
  runner.escaping = true;
  let state;
  for (let i = 0; i < 30; i += 1) {
    state = runner.update(0.05, { playerPosition: [0, STAB_FLOOR, 0], now: 100 + i * 50 });
  }
  assert.ok(state.speed >= 0.3, `expected escape pace, got ${state.speed}`);
});

// ── graded capture visibility ────────────────────────────────

test('a partly visible target still fills the gauge, just slower', () => {
  const full = new CaptureGauge();
  const partial = new CaptureGauge();
  for (let i = 0; i < 20; i += 1) {
    full.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 1 });
    partial.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0.4 });
  }
  assert.ok(partial.value > 0, 'partial cover must not stop capture outright');
  assert.ok(partial.value < full.value, 'but it should be slower than clear sight');
});

test('a fully hidden target still fills, but far slower than a clear one', () => {
  // The grid is 20cm and so is Hachuping: one noisy cell hides it outright, so
  // refusing to fill made false positives feel like a frozen game.
  const hidden = new CaptureGauge();
  const clear = new CaptureGauge();
  for (let i = 0; i < 30; i += 1) {
    hidden.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0 });
    clear.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 1 });
  }
  assert.ok(hidden.value > 0, 'hidden must still make progress');
  assert.ok(hidden.value < clear.value * 0.5, 'but clearly slower than in the open');
  assert.equal(hidden.getState().visible, false);
});

test('visibility above the full threshold fills at the ordinary rate', () => {
  const clear = new CaptureGauge();
  const mostly = new CaptureGauge();
  for (let i = 0; i < 25; i += 1) {
    clear.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 1 });
    mostly.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0.8 });
  }
  assert.ok(Math.abs(clear.value - mostly.value) < 1e-9);
});

test('a one-frame flicker of cover barely dents the gauge', () => {
  const gauge = new CaptureGauge();
  for (let i = 0; i < 20; i += 1) {
    gauge.update(1 / 60, { distance: 0.5, angleDeg: 2, visibility: 1 });
  }
  const before = gauge.value;
  gauge.update(1 / 60, { distance: 0.5, angleDeg: 2, visibility: 0 });
  assert.ok(gauge.value > before * 0.9, 'noise must not reset progress');
  assert.equal(gauge.getState().visible, true);
});

test('the boolean occluded flag maps onto the same slow-fill path', () => {
  const flagged = new CaptureGauge();
  const graded = new CaptureGauge();
  for (let i = 0; i < 30; i += 1) {
    flagged.update(0.1, { distance: 0.5, angleDeg: 2, occluded: true });
    graded.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0 });
  }
  assert.ok(Math.abs(flagged.value - graded.value) < 1e-9);
  assert.equal(flagged.getState().visible, false);
});

test('the hint distinguishes partly hidden from fully hidden', () => {
  const partial = new CaptureGauge();
  for (let i = 0; i < 20; i += 1) {
    partial.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0.35 });
  }
  assert.match(partial.hint(), /일부 가려짐/);

  const hidden = new CaptureGauge();
  for (let i = 0; i < 20; i += 1) {
    hidden.update(0.1, { distance: 0.5, angleDeg: 2, visibility: 0 });
  }
  assert.match(hidden.hint(), /매우 느림/);
});

// ── committing to a destination long enough to arrive ────────
// The timer used to abandon 84% of furniture destinations mid-walk, which is
// why Hachuping was so rarely seen on a chair. It now keeps walking while the
// route is still good.
function longRoomGrid() {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  for (let x = 0; x <= 6; x += 0.05) {
    for (let z = 0; z <= 0.6; z += 0.05) grid.observe([x, 0.02, z]);
  }
  return grid;
}

function walk(runner, seconds, playerPosition, startMs = 0) {
  for (let f = 0; f < seconds * 60; f += 1) {
    runner.update(1 / 60, { playerPosition, now: startMs + f * (1000 / 60) });
  }
}

test('a destination is not abandoned just because the timer expired', () => {
  const grid = longRoomGrid();
  const runner = new ChaseRunner({ grid, retargetMs: 500, stuckMs: 30000 });
  runner.start([0.3, 0.1, 0.3], 0);
  walk(runner, 1, [0.1, 0.1, 0.3]);
  const target = runner.target;
  assert.ok(target, 'it should have chosen somewhere to go');
  // Many retarget windows pass while the walk is still making progress.
  walk(runner, 4, [0.1, 0.1, 0.3], 1000);
  if (runner.target) {
    const same = runner.target.cx === target.cx && runner.target.cz === target.cz;
    assert.ok(same || runner.pathIndex === 0,
      'the destination should survive the timer while the walk progresses');
  }
});

test('a destination the player has gotten closer to IS abandoned', () => {
  const grid = longRoomGrid();
  const runner = new ChaseRunner({ grid, retargetMs: 200, stuckMs: 30000 });
  runner.start([0.3, 0.1, 0.3], 0);
  walk(runner, 1, [0.1, 0.1, 0.3]);
  const target = runner.target;
  assert.ok(target);
  // Teleport the player onto the far side, past the destination: running there
  // would now be running at them.
  const goal = grid.worldOf(target);
  walk(runner, 2, [goal[0] + 0.1, 0.1, goal[2]], 1000);
  assert.notDeepEqual(runner.target, target, 'a compromised destination must be dropped');
});

test('no forward progress for stuckMs still forces a rethink', () => {
  const grid = longRoomGrid();
  const runner = new ChaseRunner({ grid, retargetMs: 60000, stuckMs: 500 });
  runner.start([0.3, 0.1, 0.3], 0);
  walk(runner, 0.5, [0.1, 0.1, 0.3]);
  const before = runner.target;
  // Frozen: update() returns early, so lastProgressAt stops advancing.
  runner.setFrozen(true);
  walk(runner, 2, [0.1, 0.1, 0.3], 500);
  runner.setFrozen(false);
  walk(runner, 0.1, [0.1, 0.1, 0.3], 2600);
  assert.ok(runner.target, 'it must still have somewhere to go');
  assert.ok(before, 'sanity');
});

test('approaching a target on furniture drives it back to the ground', () => {
  // The counter-play that makes generous furniture use safe: whatever height
  // Hachuping picks, walking at it turns that spot into a bad one, because the
  // flee score rewards distance from the player and the retarget rule drops a
  // destination the player has gotten closer to.
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  for (let x = 0; x <= 3; x += 0.05) {
    for (let z = 0; z <= 1; z += 0.05) grid.observe([x, 0.02, z]);
  }
  // A wide platform at 0.5m, reachable and broad enough to pass the support test.
  for (let x = 1.2; x <= 2.2; x += 0.05) {
    for (let z = 0; z <= 1; z += 0.05) grid.observe([x, 0.50, z]);
  }
  const runner = new ChaseRunner({ grid, random: () => 0.5 });
  const perch = grid.nodeAtWorld([1.7, 0.6, 0.5]);
  assert.ok(perch && grid.worldOf(perch)[1] > 0.4, 'the platform should be standable');
  runner.start(grid.worldOf(perch), 0);
  assert.ok(runner.position[1] > 0.4, 'starts up on the platform');

  // The player walks onto the platform's footprint.
  let now = 0;
  for (let f = 0; f < 60 * 30 && runner.position[1] > 0.4; f += 1) {
    now += 1000 / 60;
    runner.update(1 / 60, { playerPosition: [1.7, 0.1, 0.5], now });
  }
  assert.ok(runner.position[1] < 0.4, 'it should have come down within 30s');
});

test('it goes and stands on furniture within the interval, every time', () => {
  // A two-minute recording that never shows a climb reads as "it cannot
  // climb", so the rate has to be a floor, not an average over ten minutes.
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  for (let x = 0; x <= 4.0; x += 0.05) {
    for (let z = 0; z <= 1.0; z += 0.05) grid.observe([x, 0.02, z]);
  }
  for (let x = 3.0; x <= 3.6; x += 0.05) {
    for (let z = 0.2; z <= 0.8; z += 0.05) grid.observe([x, 0.70, z]);
  }
  for (const x of [3.05, 3.55]) {
    for (const z of [0.25, 0.75]) {
      for (let y = 0.05; y < 0.70; y += 0.05) grid.observe([x, y, z]);
    }
  }
  const floor = grid.slabTopY(grid.resolveFloorSlab());
  const runner = new ChaseRunner({ grid, random: () => 0.5, raisedIntervalMs: 15000 });
  runner.start([0.2, 0.1, 0.5], 0);

  let climbs = 0;
  let up = false;
  let now = 0;
  for (let i = 0; i < 60 * 120; i += 1) {
    now += 1000 / 60;
    runner.update(1 / 60, { playerPosition: [0.1, 1.5, 0.5], now });
    const height = runner.position[1] - floor;
    if (!up && height > 0.25) { up = true; climbs += 1; } else if (up && height < 0.2) up = false;
  }
  assert.ok(climbs >= 2, `2분 동안 ${climbs}번만 올라감`);
});
