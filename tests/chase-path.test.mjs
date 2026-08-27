import test from 'node:test';
import assert from 'node:assert/strict';

import { TraversalGrid, nodeKey } from '../src/traversal-grid.js';
import { chooseFleeTarget, findPath } from '../src/chase-path.js';

// Terrain here is drawn one voxel per surface, because these tests are about
// geometry and routing, not about how much evidence a foothold needs. The
// footing threshold has its own tests.

function room(grid, width = 4, depth = 4, step = 0.1) {
  for (let x = 0; x <= width; x += step) {
    for (let z = 0; z <= depth; z += step) grid.observe([x, 0.02, z]);
  }
}

function wall(grid, x, z0, z1, step = 0.05) {
  for (let z = z0; z <= z1; z += step) {
    for (let y = 0.02; y < 2.2; y += 0.05) grid.observe([x, y, z]);
  }
}

test('a path is a chain of adjacent cells, never a teleport', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  const start = grid.nodeAtWorld([0.3, 0, 0.3]);
  const goal = grid.nodeAtWorld([3.7, 0, 3.7]);
  const path = findPath(grid, start, goal);

  assert.ok(path && path.length > 2);
  for (let i = 1; i < path.length; i += 1) {
    const dx = Math.abs(path[i].cx - path[i - 1].cx);
    const dz = Math.abs(path[i].cz - path[i - 1].cz);
    assert.ok(dx <= 1 && dz <= 1, `step ${i} jumped ${dx},${dz} cells`);
  }
});

test('a path never crosses a wall', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  // Wall across the middle with a gap at the far end.
  wall(grid, 2.0, 0, 3.0);

  const start = grid.nodeAtWorld([0.3, 0, 0.3]);
  const goal = grid.nodeAtWorld([3.7, 0, 0.3]);
  const path = findPath(grid, start, goal);
  assert.ok(path, 'a way around the wall should exist');

  const wallX = grid.cellX(2.0);
  for (const node of path) {
    if (node.cx !== wallX) continue;
    assert.ok(grid.isWalkable(node.cx, node.cz), 'path entered a blocked cell');
  }
});

test('a sealed-off goal returns no path instead of cheating', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid, 4, 4);
  wall(grid, 2.0, -0.5, 4.5); // full-height wall right across
  const start = grid.nodeAtWorld([0.3, 0, 2.0]);
  const goal = grid.nodeAtWorld([3.7, 0, 2.0]);
  assert.equal(findPath(grid, start, goal), null);
});

test('the flee target keeps a minimum distance', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid);
  const from = grid.nodeAtWorld([2, 0, 2]);
  const target = chooseFleeTarget(grid, {
    from,
    playerPosition: [2, 1.5, 2],
    minDistance: 1.5,
    random: () => 0.5,
  });
  const world = grid.worldOf(target);
  const fromWorld = grid.worldOf(from);
  assert.ok(Math.hypot(world[0] - fromWorld[0], world[2] - fromWorld[2]) >= 1.5);
});

test('the flee target runs away from the player', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid, 6, 6);
  const from = grid.nodeAtWorld([3, 0, 3]);
  const near = chooseFleeTarget(grid, {
    from,
    playerPosition: [0.2, 1.5, 0.2],
    random: () => 0.5,
  });
  const world = grid.worldOf(near);
  // Should end up on the far side, not next to the player.
  assert.ok(Math.hypot(world[0] - 0.2, world[2] - 0.2) > 3);
});

test('recently visited cells are avoided', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  room(grid, 6, 6);
  const from = grid.nodeAtWorld([3, 0, 3]);

  const plain = chooseFleeTarget(grid, { from, playerPosition: [0, 1.5, 0], random: () => 0.5 });
  const visits = new Map([[nodeKey(plain.cx, plain.cz, plain.level), 1000]]);
  const avoided = chooseFleeTarget(grid, {
    from,
    playerPosition: [0, 1.5, 0],
    recentVisits: visits,
    now: 1000,
    random: () => 0.5,
  });

  assert.notEqual(
    nodeKey(avoided.cx, avoided.cz, avoided.level),
    nodeKey(plain.cx, plain.cz, plain.level),
  );
});

test('no target when there is nowhere to stand', () => {
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  assert.equal(chooseFleeTarget(grid, { from: null }), null);
});

// ── going to stand on something, on purpose ─────────────────

// A long floor with one supported desk at the far end.
function roomWithOneDesk() {
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
  return grid;
}

const heightAbove = (grid, target) => {
  const floor = grid.slabTopY(grid.resolveFloorSlab());
  return grid.worldOf(target)[1] - floor;
};

test('preferRaised picks the desk instead of open floor', () => {
  const grid = roomWithOneDesk();
  const from = grid.nodeAtWorld([0.2, 0.1, 0.5]);
  const target = chooseFleeTarget(grid, { from, preferRaised: true, random: () => 0.5 });
  assert.ok(target, 'a destination must still be returned');
  assert.ok(heightAbove(grid, target) > 0.25, '가구를 골라야 한다');
});

test('without it the same room usually sends Hachuping along the floor', () => {
  const grid = roomWithOneDesk();
  const from = grid.nodeAtWorld([0.2, 0.1, 0.5]);
  const target = chooseFleeTarget(grid, { from, random: () => 0.5 });
  assert.ok(target);
  assert.ok(heightAbove(grid, target) <= 0.25, '평소에는 바닥이 기본이어야 한다');
});

test('a room with no furniture still yields a destination', () => {
  // The fallback matters more than it looks: without it Hachuping stops dead
  // in any room whose furniture is unreachable, which includes every bare one.
  const grid = new TraversalGrid({ minSlabVoxels: 1 });
  for (let x = 0; x <= 4.0; x += 0.05) {
    for (let z = 0; z <= 1.0; z += 0.05) grid.observe([x, 0.02, z]);
  }
  const from = grid.nodeAtWorld([0.2, 0.1, 0.5]);
  assert.ok(chooseFleeTarget(grid, { from, preferRaised: true, random: () => 0.5 }));
});

test('a nearby chair is not vetoed for being close', () => {
  // minDistance stops dithering between adjacent cells; applied to a forced
  // climb it would rule out the only piece of furniture in a small room.
  const grid = roomWithOneDesk();
  const from = grid.nodeAtWorld([2.5, 0.1, 0.5]); // ~0.9m from the desk
  const target = chooseFleeTarget(grid, {
    from, preferRaised: true, minDistance: 1.5, random: () => 0.5,
  });
  assert.ok(target && heightAbove(grid, target) > 0.25, '가까워도 골라야 한다');
});

test('furniture is scored level with the ground, not against it', () => {
  // The restraint lives in the grid's climb cost, not here. A negative score
  // here is what made furniture something Hachuping reached by accident.
  const grid = roomWithOneDesk();
  const from = grid.nodeAtWorld([0.2, 0.1, 0.5]);
  const desk = chooseFleeTarget(grid, {
    from, preferRaised: true, raisedTargetScore: 0, random: () => 0.5,
  });
  const punished = chooseFleeTarget(grid, {
    from, preferRaised: true, raisedTargetScore: -50, random: () => 0.5,
  });
  // Even a huge penalty cannot change the furniture-only pass's winner, which
  // is the point of the pass; the knob only matters in the normal pass.
  assert.deepEqual(punished, desk);
});
