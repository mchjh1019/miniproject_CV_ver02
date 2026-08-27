// Walkable-surface grid built from the accumulated voxel map.
//
// The voxel map answers "is something here". Chasing needs "can Hachuping
// stand here, and can it get from here to there", so this projects the voxels
// onto a top-down grid of cells and, per cell, records which height slabs are
// occupied as a bitmask.
//
// A cell can hold more than one standable level — the floor under a table and
// the tabletop above it are separate levels, which is what lets Hachuping jump
// onto furniture instead of only walking around it.
//
// No three.js dependency so it can be unit-tested directly.

const UNSEEN = 0;

function cellKey(cx, cz) {
  return `${cx},${cz}`;
}

export function nodeKey(cx, cz, level) {
  return `${cx},${cz},${level}`;
}

export function parseNodeKey(key) {
  const [cx, cz, level] = key.split(',');
  return { cx: Number(cx), cz: Number(cz), level: Number(level) };
}

export const MOVE = Object.freeze({
  WALK: 'walk',
  JUMP: 'jump',
});

export class TraversalGrid {
  constructor({
    cellSize = 0.2,
    slabHeight = 0.1,
    // The 'local' reference space puts the origin at the phone when the session
    // started, so the floor sits roughly 1.4m BELOW y = 0. The band has to
    // reach well under zero or the floor falls outside the grid entirely.
    minY = -3.0,
    slabCount = 64,
    // These mirror the shipped values in config.js. They drifted apart once —
    // config moved and this did not — so a reader of this file saw numbers the
    // game never used. Keep them in step.
    headroom = 0.34,
    maxStepUp = 0.15,
    maxJumpUp = 0.95,
    maxDropDown = 1.2,
    // A ceiling is geometrically identical to a tabletop: a thin occupied slab
    // with clear air on one side. Only its height tells them apart, so cap how
    // far above the floor a surface may be and still count as standable.
    maxStandAboveFloor = 1.3,
    // How many cells must share a slab before it is believed to be the floor.
    // A handful of stray depth points below the real floor would otherwise
    // drag the ceiling up with them.
    floorMinCells = 8,
    // How many distinct 5cm voxels a 20x20x10cm slab needs before it counts as
    // something to stand on. One was enough before, so a single stray depth
    // point conjured a whole 20x20cm foothold in mid-air. A fully observed flat
    // floor leaves 16 voxels in its slab, so 4 clears real surfaces comfortably
    // while rejecting isolated noise.
    minSlabVoxels = 4,
    // A foothold this far above the floor must look like a real platform, not
    // a lone blob: at least `minRaisedSupport` of its eight neighbours need a
    // standable level within `raisedSupportBandM`. Furniture tops are wide and
    // score 8/8; a noise cluster floating in mid-air scores 0/8. Without this,
    // raising the jump height to reach hip-height furniture also hands
    // Hachuping every stray reconstruction artefact in the room.
    raisedSupportAboveFloorM = 0.4,
    minRaisedSupport = 2,
    raisedSupportBandM = 0.10,
    // ... and something has to be holding it up. A real surface has furniture
    // under it; a reconstruction floater has nothing but air. Depth searched
    // below the surface, and how far sideways the column may lean.
    //
    // The radius is what makes this safe. Measured on five room scans, a
    // strictly-vertical test (radius 0) deleted 51-72 reachable cells each,
    // most of them real chair seats: a seat is a thin plate on legs thinner
    // than one 20cm cell, so the cell holding the seat often has nothing
    // directly beneath it. Allowing the support to sit in any of the eight
    // neighbouring columns drops that to 1-8 cells per scan, and those are
    // the floaters — chair and desk tops survive intact.
    supportDepthM = 0.40,
    supportRadiusCells = 1,
    // How reluctant Hachuping is to use furniture. These were tuned when the
    // penalties were the ONLY defence against the aerial-highway bug (touring
    // the room at tabletop height without ever landing). hasRaisedSupport now
    // blocks the noise ledges that made that bug dangerous, so the tax exists
    // only for believability — a small creature mostly runs on the ground.
    // Measured on a real room scan; see the commit that introduced them.
    climbCostPerM = 2.0,     // charged once, per metre climbed
    dropCostPerM = 0.5,      // coming down must look like the easy direction
    jumpBaseCost = 0.6,
    heightTollPerM = 0.1,    // charged every step taken above the floor
    // ... and at least this fraction of the busiest slab's cells. Measured on
    // two room scans: 0.3 puts the floor on the slab holding the surface for
    // both hit counting and TSDF, while 0.1 still let a sub-floor noise slab
    // through for TSDF.
    floorMinFraction = 0.3,
  } = {}) {
    this.floorMinFraction = floorMinFraction;
    this.cellSize = cellSize;
    this.slabHeight = slabHeight;
    this.minY = minY;
    this.slabCount = Math.min(slabCount, 64); // two 32-bit masks per cell
    this.headroomSlabs = Math.max(1, Math.ceil(headroom / slabHeight));
    this.maxStepUp = maxStepUp;
    this.maxJumpUp = maxJumpUp;
    this.maxDropDown = maxDropDown;
    this.maxStandAboveFloor = maxStandAboveFloor;
    this.floorMinCells = floorMinCells;
    this.minSlabVoxels = Math.max(1, minSlabVoxels);
    this.raisedSupportAboveFloorM = raisedSupportAboveFloorM;
    this.minRaisedSupport = minRaisedSupport;
    this.raisedSupportBandM = raisedSupportBandM;
    this.supportSlabs = Math.max(1, Math.round(supportDepthM / slabHeight));
    this.supportRadiusCells = Math.max(0, Math.floor(supportRadiusCells));
    this.climbCostPerM = climbCostPerM;
    this.dropCostPerM = dropCostPerM;
    this.jumpBaseCost = jumpBaseCost;
    this.heightTollPerM = heightTollPerM;
    this.cells = new Map();
    this.revision = 0;
    this.slabCells = new Int32Array(64);
    this.floorSlab = null;
    this.floorDirty = true;
    this.standGen = 0;
    // Optional RANSAC floor plane (see applyFloorPlane). When set it overrides
    // the histogram floor detection and can fill sparse floor gaps.
    this.floorPlane = null;
    this.floorPlaneRefY = null;
  }

  // ── coordinate helpers ────────────────────────────────────
  cellX(x) {
    return Math.floor(x / this.cellSize);
  }

  cellZ(z) {
    return Math.floor(z / this.cellSize);
  }

  slabOf(y) {
    return Math.floor((y - this.minY) / this.slabHeight);
  }

  // Top of a slab: standing on it puts your feet here.
  slabTopY(slab) {
    return this.minY + (slab + 1) * this.slabHeight;
  }

  centerX(cx) {
    return (cx + 0.5) * this.cellSize;
  }

  centerZ(cz) {
    return (cz + 0.5) * this.cellSize;
  }

  // ── writing ───────────────────────────────────────────────
  // Called once per voxel that became solid. O(1) — never rebuild the whole
  // grid per frame, that measured 110x slower than updating touched cells.
  observe([x, y, z]) {
    const slab = this.slabOf(y);
    if (slab < 0 || slab >= this.slabCount) return false;

    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    const key = cellKey(cx, cz);
    let cell = this.cells.get(key);
    if (!cell) {
      // votes: how many confirmed voxels back each slab. One ledger serves
      // two features that were built apart and merged here:
      //  - the slab only becomes standable at `minSlabVoxels` votes, so a
      //    single stray depth point cannot conjure a 20x20cm foothold;
      //  - TSDF retraction (unobserve) decrements the same ledger, and the
      //    bit clears when votes drop back below the threshold.
      // Counting must therefore CONTINUE past the threshold — capping there
      // would make later retractions clear the bit too early.
      cell = {
        cx, cz, lo: UNSEEN, hi: UNSEEN, levels: null, levelsGen: -1,
        votes: new Uint16Array(this.slabCount),
      };
      this.cells.set(key, cell);
    }

    if (cell.votes[slab] < 0xffff) cell.votes[slab] += 1;
    // The floor histogram counts OBSERVED cells (first vote), not confirmed
    // footing. Floor detection is statistics over many cells with its own
    // noise defences (floorMinCells, floorMinFraction); gating it on the
    // footing threshold starved it on sparse TSDF maps until applyFloorPlane
    // had no floor slab to fill against.
    if (cell.votes[slab] === 1) {
      this.slabCells[slab] += 1;
      if (this.floorSlab === null || slab <= this.floorSlab) this.floorDirty = true;
    }
    if (this.hasSlab(cell, slab)) return false;   // already solid — vote banked
    if (cell.votes[slab] < this.minSlabVoxels) return false; // evidence pending
    if (slab < 32) cell.lo |= 1 << slab;
    else cell.hi |= 1 << (slab - 32);
    cell.levels = null; // recompute lazily
    this.revision += 1;
    return true;
  }

  // The inverse of observe, for accumulators that can take a voxel back
  // (TSDF fusion clears a floater once enough rays pass through it). Returns
  // true when the slab bit actually cleared. An empty cell is dropped so it
  // reads as unseen again rather than blocked.
  unobserve([x, y, z]) {
    const slab = this.slabOf(y);
    if (slab < 0 || slab >= this.slabCount) return false;
    const cell = this.cells.get(cellKey(this.cellX(x), this.cellZ(z)));
    if (!cell || cell.votes[slab] === 0) return false;
    cell.votes[slab] -= 1;
    if (cell.votes[slab] === 0) {
      this.slabCells[slab] -= 1;
      this.floorDirty = true;
      // A cell with no votes anywhere is gone entirely.
      if (cell.lo === UNSEEN && cell.hi === UNSEEN
        && cell.votes.every((v) => v === 0)) {
        this.cells.delete(cellKey(cell.cx, cell.cz));
        this.revision += 1;
        return true;
      }
    }
    // The footing bit exists only while votes meet the threshold; it clears on
    // the retraction that drops below it, not when the ledger hits zero.
    if (!this.hasSlab(cell, slab)) return false;
    if (cell.votes[slab] >= this.minSlabVoxels) return false;

    if (slab < 32) cell.lo &= ~(1 << slab);
    else cell.hi &= ~(1 << (slab - 32));
    // The floor may have lost support; let the next read decide.
    this.floorDirty = true;
    cell.levels = null;
    this.revision += 1;
    return true;
  }

  // Lowest slab that enough cells share to be believable as the floor.
  // Recomputed only when a new low slab appears, and every cached level list is
  // invalidated when the answer moves, because the standable ceiling moves too.
  resolveFloorSlab() {
    if (!this.floorDirty) return this.floorSlab;
    this.floorDirty = false;
    // Absolute floor of 8 cells was tuned for hit counting. A fused map emits
    // several times more voxels, so a slab of sub-floor noise clears 8 cells
    // easily and drags the standable ceiling down with it (measured: 2 slabs
    // low, 158 desk-top cells lost). The bar is therefore also relative to
    // the busiest slab, which is the real floor or something as big.
    let busiest = 0;
    for (let slab = 0; slab < this.slabCount; slab += 1) {
      if (this.slabCells[slab] > busiest) busiest = this.slabCells[slab];
    }
    const minCells = Math.max(this.floorMinCells, Math.ceil(busiest * this.floorMinFraction));
    let found = null;
    for (let slab = 0; slab < this.slabCount; slab += 1) {
      if (this.slabCells[slab] >= minCells) { found = slab; break; }
    }
    // A real floor is never one clean slab: depth noise and an uneven scan
    // spread it over three or four. Taking the lowest qualifying slab lands on
    // the bottom shoulder of that spread, 10-20cm below the actual surface
    // (measured on all five room scans). Walk up while the population is still
    // growing to sit on the peak instead. Stopping at the first decrease is
    // what keeps this from wandering off onto a desk plane higher up.
    if (found !== null) {
      while (found + 1 < this.slabCount
        && this.slabCells[found + 1] > this.slabCells[found]) {
        found += 1;
      }
    }
    if (found === null) {
      for (let slab = 0; slab < this.slabCount; slab += 1) {
        if (this.slabCells[slab] > 0) { found = slab; break; }
      }
    }
    if (found !== this.floorSlab) {
      this.floorSlab = found;
      this.standGen += 1;
    }
    return this.floorSlab;
  }

  // Highest y a surface may sit at and still be somewhere Hachuping could go.
  standCeilingY() {
    const floor = this.resolveFloorSlab();
    if (floor === null) return Infinity;
    return this.slabTopY(floor) + this.maxStandAboveFloor;
  }

  hasSlab(cell, slab) {
    if (slab < 0 || slab >= this.slabCount) return false;
    return slab < 32
      ? (cell.lo & (1 << slab)) !== 0
      : (cell.hi & (1 << (slab - 32))) !== 0;
  }

  observeAll(points) {
    let changed = 0;
    for (const point of points) {
      if (this.observe(point)) changed += 1;
    }
    return changed;
  }

  reset() {
    if (this.cells.size) this.revision += 1;
    this.cells.clear();
    this.slabCells.fill(0);
    this.floorSlab = null;
    this.floorDirty = true;
    this.floorPlane = null;
    this.floorPlaneRefY = null;
    this.standGen += 1;
  }

  // ── RANSAC floor plane ─────────────────────────────────────
  // Every occupied voxel as a world point, for fitting the floor plane. One
  // point per occupied slab at its top (where a body would stand). Read this
  // BEFORE applyFloorPlane so the fit sees only real observations.
  // Raw observations, not footing. The plane fitter has its own outlier
  // rejection (RANSAC inlier voting), so it wants every observed voxel; the
  // footing threshold (minSlabVoxels) would starve it on the sparse TSDF maps
  // the floor-plane rescue exists for.
  occupiedVoxelPoints() {
    const points = [];
    for (const cell of this.cells.values()) {
      for (let slab = 0; slab < this.slabCount; slab += 1) {
        if (cell.votes[slab] > 0) {
          points.push([this.centerX(cell.cx), this.slabTopY(slab), this.centerZ(cell.cz)]);
        }
      }
    }
    return points;
  }

  // Occupied voxels within a low band, for fitting the floor plane. The floor is
  // the lowest large surface, so fitting the whole cloud lets a ceiling or a
  // tall shelf — more voxels, higher up — win the plane. Anchoring to a robust
  // low height (a low percentile, so a stray sub-floor floater cannot drag it
  // down) and keeping only points within bandM above it isolates the floor.
  floorBandVoxelPoints({ bandM = 0.5, lowPercentile = 0.1 } = {}) {
    const points = this.occupiedVoxelPoints();
    if (!points.length) return points;
    const ys = points.map((p) => p[1]).sort((a, b) => a - b);
    const y0 = ys[Math.floor(lowPercentile * (ys.length - 1))];
    return points.filter((p) => p[1] <= y0 + bandM);
  }

  // Any occupied slab in [startSlab, startSlab + count)?
  // Any observation counts here, confirmed or not: this guards where the
  // synthetic floor may NOT go, and even a single observed voxel overhead is
  // reason enough to leave the space beneath it alone.
  solidInBand(cell, startSlab, count) {
    const end = Math.min(this.slabCount, startSlab + count);
    for (let slab = Math.max(0, startSlab); slab < end; slab += 1) {
      if (cell.votes[slab] > 0) return true;
    }
    return false;
  }

  // Add a floor voxel the map never observed, to bridge a sparse-scan gap.
  // Marked synthetic for diagnostics; otherwise it is an ordinary occupied slab.
  addSyntheticFloor(cx, cz, slab) {
    const key = cellKey(cx, cz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        cx, cz, lo: UNSEEN, hi: UNSEEN, votes: new Uint16Array(this.slabCount),
        levels: null, levelsGen: -1, synthetic: true,
      };
      this.cells.set(key, cell);
    }
    if (this.hasSlab(cell, slab)) return;
    // Synthetic floor is deliberate synthesis, not evidence: grant it the full
    // footing threshold so the votes<->bit invariant holds for unobserve.
    if (cell.votes[slab] === 0) this.slabCells[slab] += 1;
    if (cell.votes[slab] < this.minSlabVoxels) cell.votes[slab] = this.minSlabVoxels;
    if (slab < 32) cell.lo |= 1 << slab;
    else cell.hi |= 1 << (slab - 32);
    cell.levels = null;
  }

  // Adopt a fitted floor plane (or null to clear) and fill sparse-scan gaps in
  // the floor. The plane's job is to CONFIRM a coherent, near-horizontal floor
  // exists — its absolute height is deliberately not trusted, because a scan's
  // densest surface can be a desk (floats the character) and its lowest points
  // can be sub-floor noise (sinks it). The fill therefore bridges gaps at the
  // height the OBSERVATIONS already agree on (the histogram floor slab), which
  // is the height the game ran at before this feature.
  //
  // A cell within fillRadius of an observed floor cell gains a floor voxel at
  // that slab UNLESS it already stands somewhere, something solid blocks the
  // body column just above it, or it lies beyond the radius (a real hole or
  // unscanned void, left untouched).
  applyFloorPlane(plane, { fillRadius = 2, bodyHeightSlabs = this.headroomSlabs } = {}) {
    this.floorPlane = plane || null;
    this.floorPlaneRefY = null;
    if (!plane) {
      this.floorDirty = true;
      this.standGen += 1;
      this.revision += 1;
      return;
    }

    const floorSlab = this.resolveFloorSlab();
    if (floorSlab === null) return;

    // Seeds: observed cells that carry a floor voxel at the floor slab.
    const seeds = [];
    for (const cell of this.cells.values()) {
      // Raw observation seeds the fill: a sparse floor cell with votes below
      // the footing threshold is exactly what the synthesis is for — it gets
      // granted full footing by addSyntheticFloor below.
      if (cell.votes[floorSlab] > 0) seeds.push([cell.cx, cell.cz]);
    }

    // Bounded dilation of the observed floor, at the observed floor height.
    const done = new Set();
    for (const [scx, scz] of seeds) {
      for (let dz = -fillRadius; dz <= fillRadius; dz += 1) {
        for (let dx = -fillRadius; dx <= fillRadius; dx += 1) {
          const cx = scx + dx; const cz = scz + dz;
          const key = cellKey(cx, cz);
          if (done.has(key)) continue;
          done.add(key);
          const cell = this.cells.get(key);
          if (cell) {
            if (this.hasSlab(cell, floorSlab)) continue; // already floor here
            if (this.solidInBand(cell, floorSlab + 1, bodyHeightSlabs)) continue; // under something
            // Only bridge genuine gaps. A cell that already offers somewhere to
            // stand (e.g. a shelf) keeps it; adding a floor beneath it would
            // sink Hachuping through a surface it should rest on.
            if (this.isWalkable(cx, cz)) continue;
          }
          this.addSyntheticFloor(cx, cz, floorSlab);
        }
      }
    }

    this.floorDirty = true;
    this.standGen += 1;
    this.revision += 1;
  }

  // ── reading ───────────────────────────────────────────────
  getCell(cx, cz) {
    return this.cells.get(cellKey(cx, cz)) ?? null;
  }

  isSeen(cx, cz) {
    return this.cells.has(cellKey(cx, cz));
  }

  // Standable heights in a cell, lowest first. A slab qualifies when it is
  // occupied and the slabs above it are clear for the whole body height.
  levels(cx, cz) {
    const cell = this.getCell(cx, cz);
    if (!cell) return [];
    const ceiling = this.standCeilingY();
    if (cell.levels && cell.levelsGen === this.standGen) return cell.levels;

    const levels = [];
    for (let slab = 0; slab < this.slabCount; slab += 1) {
      if (!this.hasSlab(cell, slab)) continue;
      // Too high above the floor to be anywhere a small character could get.
      if (this.slabTopY(slab) > ceiling) break;
      // The body height must fit, and it must fit inside the mapped band —
      // otherwise the top of a wall reads as a ledge you could stand on.
      if (slab + this.headroomSlabs >= this.slabCount) break;
      let clear = true;
      for (let above = 1; above <= this.headroomSlabs; above += 1) {
        if (this.hasSlab(cell, slab + above)) {
          clear = false;
          break;
        }
      }
      if (clear) levels.push(this.slabTopY(slab));
    }
    cell.levels = levels;
    cell.levelsGen = this.standGen;
    return levels;
  }

  isWalkable(cx, cz) {
    return this.levels(cx, cz).length > 0;
  }

  // Does a raised level look like part of a real platform?
  //
  // Deliberately NOT folded into levels(): that would recurse, since the test
  // reads the neighbours' levels. It belongs on the edge layer anyway — the
  // surface exists either way, the question is whether it is somewhere a
  // character could sensibly hop onto.
  hasRaisedSupport(cx, cz, y) {
    const floorSlab = this.resolveFloorSlab();
    if (floorSlab === null) return true;
    const height = y - this.slabTopY(floorSlab);
    if (height <= this.raisedSupportAboveFloorM) return true; // ground level

    let support = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        for (const level of this.levels(cx + dx, cz + dz)) {
          if (Math.abs(level - y) <= this.raisedSupportBandM) {
            support += 1;
            break;
          }
        }
        if (support >= this.minRaisedSupport) return true;
      }
    }
    return false;
  }

  // Is anything holding this surface up?
  //
  // hasRaisedSupport asks whether the surface is WIDE (neighbours at the same
  // height); this asks whether it is SUPPORTED (mass underneath). They fail on
  // different artefacts: a flat sheet of flying pixels along a desk edge is
  // wide but rests on nothing, and passes the first test while failing this one.
  //
  // Same reason as hasRaisedSupport for living on the edge layer rather than
  // in levels(): it reads the neighbours' occupancy, and levels() caches per
  // cell with no way to invalidate a neighbour's entry when this one changes.
  hasSupportColumn(cx, cz, y) {
    const floorSlab = this.resolveFloorSlab();
    if (floorSlab === null) return true;
    // Ground level holds itself up: nothing is ever observed below the floor,
    // so the floor would fail its own test.
    if (y - this.slabTopY(floorSlab) <= this.maxStepUp) return true;

    const slab = this.slabOf(y - this.slabHeight / 2);
    const r = this.supportRadiusCells;
    for (let dz = -r; dz <= r; dz += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const cell = this.getCell(cx + dx, cz + dz);
        if (!cell) continue;
        for (let d = 1; d <= this.supportSlabs; d += 1) {
          const below = slab - d;
          // The ground does not count. A surface 40cm up whose only support is
          // the floor beneath it is a plate hovering over the floor, which is
          // the artefact this rejects; a real object has continuous mass down
          // to whatever it stands on. Measured on five room scans, ignoring
          // the floor caught 29 more low floaters and cost nothing at chair or
          // desk height, where the floor is out of range anyway.
          if (below <= floorSlab) break;
          if (this.hasSlab(cell, below)) return true;
        }
      }
    }
    return false;
  }

  // A cell that was observed but offers nowhere to stand — a wall, or the
  // solid body of a piece of furniture.
  isBlocked(cx, cz) {
    return this.isSeen(cx, cz) && !this.isWalkable(cx, cz);
  }

  levelY(cx, cz, level) {
    return this.levels(cx, cz)[level] ?? null;
  }

  worldOf({ cx, cz, level }) {
    const y = this.levelY(cx, cz, level);
    if (y === null) return null;
    return [this.centerX(cx), y, this.centerZ(cz)];
  }

  // Nearest standable node to a world point. Used to drop Hachuping onto the
  // grid when the chase starts, and to locate the player on it.
  nodeAtWorld([x, y, z], searchRadius = 3) {
    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    let best = null;
    let bestCost = Infinity;
    for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        const nx = cx + dx;
        const nz = cz + dz;
        const levels = this.levels(nx, nz);
        for (let level = 0; level < levels.length; level += 1) {
          const planar = Math.hypot(dx, dz) * this.cellSize;
          const vertical = Math.abs(levels[level] - y);
          const cost = planar + vertical * 2;
          if (cost < bestCost) {
            bestCost = cost;
            best = { cx: nx, cz: nz, level };
          }
        }
      }
    }
    return best;
  }

  // ── movement rules ────────────────────────────────────────
  // Neighbours reachable in one step. Height decides walk vs jump; anything
  // steeper than maxJumpUp is simply not an edge, which is what keeps
  // Hachuping out of walls and off unreachable shelves.
  //
  // Every admissible level of a neighbouring cell is offered as its own edge.
  // The earlier version returned only the level closest to the current height,
  // which made staying on furniture the ONLY option while standing on it — the
  // floor edge under a table was never even generated, so once Hachuping got
  // up somewhere it toured the room at tabletop altitude. Now the floor route
  // always exists and the costs below make it the preferred one.
  neighbors(node) {
    const fromY = this.levelY(node.cx, node.cz, node.level);
    if (fromY === null) return [];
    const floorSlab = this.resolveFloorSlab();
    const floorY = floorSlab === null ? null : this.slabTopY(floorSlab);

    const out = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const nx = node.cx + dx;
        const nz = node.cz + dz;
        const levels = this.levels(nx, nz);
        if (!levels.length) continue; // unseen or blocked — never traversable

        // Diagonals may not cut a corner between two blocked cells.
        if (dx !== 0 && dz !== 0) {
          if (!this.isWalkable(node.cx + dx, node.cz) && !this.isWalkable(node.cx, node.cz + dz)) {
            continue;
          }
        }

        const planar = Math.hypot(dx, dz) * this.cellSize;
        for (let level = 0; level < levels.length; level += 1) {
          const rise = levels[level] - fromY;
          // Slab tops are sums of floats; without the epsilon a rise exactly at
          // the limit (0.7000000000000002 vs 0.7) is rejected at random.
          if (rise > this.maxJumpUp + 1e-9) continue;
          if (rise < -this.maxDropDown - 1e-9) continue;

          // A lone blob in mid-air is not a platform, however legal the hop
          // onto it would be. Only checked when climbing: dropping off one is
          // still allowed, or a character could get stranded on it forever.
          if (rise > this.maxStepUp
            && !this.hasRaisedSupport(nx, nz, levels[level])) continue;
          // Nor is a surface with nothing underneath it, at any height. This
          // one is NOT climb-only. Measured on five room scans: gating it on
          // rise stopped exactly zero floaters, because none of them are
          // entered by climbing — a character reaches them by stepping
          // sideways off a neighbouring floater or by dropping onto one from
          // the furniture above. Testing every edge costs nothing in stranding
          // risk, since the test applies to where an edge GOES: standing on a
          // floater, the supported floor below is still an edge out.
          if (!this.hasSupportColumn(nx, nz, levels[level])) continue;

          const jump = Math.abs(rise) > this.maxStepUp;
          // Climbing is charged double its height, dropping half: coming down
          // must always look like the easy direction.
          const jumpCost = jump
            ? this.jumpBaseCost + (rise > 0
              ? rise * this.climbCostPerM
              : Math.abs(rise) * this.dropCostPerM)
            : 0;
          // Toll for walking above the floor, per step and proportional to
          // altitude. This is what turns table-chair-table routes into
          // table-floor-table ones without forbidding furniture outright.
          const heightToll = floorY === null
            ? 0
            : Math.max(0, levels[level] - floorY - this.slabHeight / 2)
              * this.heightTollPerM;
          out.push({
            cx: nx,
            cz: nz,
            level,
            rise,
            distance: planar,
            move: jump ? MOVE.JUMP : MOVE.WALK,
            cost: planar + jumpCost + heightToll,
          });
        }
      }
    }
    return out;
  }

  // ── diagnostics ───────────────────────────────────────────
  stats() {
    let seen = 0;
    let walkable = 0;
    let blocked = 0;
    let levelTotal = 0;
    for (const cell of this.cells.values()) {
      seen += 1;
      const levels = this.levels(cell.cx, cell.cz);
      if (levels.length) {
        walkable += 1;
        levelTotal += levels.length;
      } else {
        blocked += 1;
      }
    }
    return { seen, walkable, blocked, levelTotal };
  }

  getRevision() {
    return this.revision;
  }

  // Cells for the operator view overlay, one entry per standable level plus
  // one per blocked cell so the map reads as green / red at a glance.
  toOverlay(maxEntries = 20000) {
    const out = [];
    for (const cell of this.cells.values()) {
      if (out.length >= maxEntries) break;
      const levels = this.levels(cell.cx, cell.cz);
      if (!levels.length) {
        // Draw a blocked cell at the height of its lowest voxel so walls read
        // as red at floor level instead of sinking to the bottom of the band.
        let lowest = this.minY + this.slabHeight;
        for (let slab = 0; slab < this.slabCount; slab += 1) {
          if (this.hasSlab(cell, slab)) { lowest = this.slabTopY(slab); break; }
        }
        out.push({
          cx: cell.cx,
          cz: cell.cz,
          level: -1,
          position: [this.centerX(cell.cx), lowest, this.centerZ(cell.cz)],
          walkable: false,
        });
        continue;
      }
      for (let level = 0; level < levels.length; level += 1) {
        if (out.length >= maxEntries) break;
        out.push({
          cx: cell.cx,
          cz: cell.cz,
          level,
          position: [this.centerX(cell.cx), levels[level], this.centerZ(cell.cz)],
          walkable: true,
        });
      }
    }
    return out;
  }
}
