// Drives Hachuping along the traversal grid while the player chases it.
//
// Movement is deliberately not free-form: the runner only ever advances along
// a path returned by findPath, one grid cell at a time, so it cannot cut
// through a wall or jump across the room. Height changes inside the path turn
// into a short arc, which is how it gets onto a table.
//
// Speed is tied to how close the player is. Far away it almost stops — without
// that it disappears across the room and the chase ends before it starts.
//
// Pure logic: positions in and out, no three.js.

import {
  chooseFleeTarget, findPath, pruneVisits, reachableFrom,
} from './chase-path.js';
import { nodeKey, MOVE } from './traversal-grid.js';

// Measured on device: a player holding a phone at arm's length and watching
// the screen walks nowhere near normal walking pace. The first tuning pass used
// roughly double these numbers and Hachuping simply could not be caught.
export const CHASE_SPEED_BANDS = Object.freeze([
  { withinM: 1.2, speed: 0.50 },
  { withinM: 2.0, speed: 0.42 },
  { withinM: 4.0, speed: 0.28 },
  { withinM: Infinity, speed: 0.12 },
]);

export function speedForDistance(distance, bands = CHASE_SPEED_BANDS) {
  for (const band of bands) {
    if (distance <= band.withinM) return band.speed;
  }
  return bands[bands.length - 1].speed;
}

// Move a value toward a target by at most maxDelta. The band table steps speed
// abruptly at its boundaries, and a player hovering around 2.0m makes
// Hachuping twitch; rate-limiting the change turns the steps into ramps.
export function approachValue(current, target, maxDelta) {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// Same, for angles: always turn the short way around. Without this the model
// snaps to each new path direction in a single frame, which reads as robotic.
export function approachAngle(current, target, maxDelta) {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export const CHASE_STATE = Object.freeze({
  IDLE: 'idle',
  WALK: 'walk',
  JUMP: 'jump',
  CAUGHT: 'caught',
});

export class ChaseRunner {
  constructor({
    grid,
    speedBands = CHASE_SPEED_BANDS,
    retargetMs = 3000,
    stuckMs = 4000,
    recentWindowMs = 15000,
    jumpSeconds = 0.5,
    jumpArcM = 0.22,
    hopHeightM = 0.05,
    hopHz = 2.4,
    random = Math.random,
    // Smoothing limits: how fast the facing may swing and the speed may change.
    turnRateRadPerS = 9,
    speedAccelMps2 = 0.8,
    // Stuck recovery: after this many failed replans past stuckMs, glide
    // toward the player — their position is guaranteed to be real, scanned
    // space, so walking that way always meets valid terrain again.
    escapeAfterFailures = 3,
    escapeMinSpeed = 0.35,
    // Passed straight through to chooseFleeTarget: how far a destination must
    // be, and how much Hachuping likes furniture. Kept as one bag so tuning
    // does not need a new constructor argument each time.
    fleeOptions = null,
    // Go and stand on something after this long at ground level. See
    // chooseFleeTarget's preferRaised for why this is a timer and not a score.
    // 15s measured out at ~4 climbs above 55cm per 2-minute round, against 3.7
    // from the scoring alone: the timer is what makes the rate a floor rather
    // than an average, which is the point — a two-minute recording that never
    // shows a climb reads as "it cannot climb".
    raisedIntervalMs = 15000,
    raisedThresholdM = 0.25,
    onEvent = null,
  } = {}) {
    this.grid = grid;
    this.speedBands = speedBands;
    this.retargetMs = retargetMs;
    this.stuckMs = stuckMs;
    this.recentWindowMs = recentWindowMs;
    this.jumpSeconds = jumpSeconds;
    this.jumpArcM = jumpArcM;
    this.hopHeightM = hopHeightM;
    this.hopHz = hopHz;
    this.random = random;
    this.turnRateRadPerS = turnRateRadPerS;
    this.speedAccelMps2 = speedAccelMps2;
    this.escapeAfterFailures = escapeAfterFailures;
    this.escapeMinSpeed = escapeMinSpeed;
    this.fleeOptions = fleeOptions;
    this.raisedIntervalMs = raisedIntervalMs;
    this.raisedThresholdM = raisedThresholdM;
    this.onEvent = onEvent;
    this.reset();
  }

  emit(type, detail = '') {
    if (this.onEvent) this.onEvent(type, detail);
  }

  reset() {
    this.node = null;
    this.position = null;
    this.path = [];
    this.pathIndex = 0;
    this.target = null;
    this.state = CHASE_STATE.IDLE;
    this.heading = [0, 1];
    this.headingAngle = 0;
    this.targetHeadingAngle = 0;
    this.currentSpeed = 0;
    this.reanchoring = false;
    this.escaping = false;
    this.recentVisits = new Map();
    this.lastRetargetAt = -Infinity;
    this.targetSetAt = -Infinity;
    this.lastProgressAt = -Infinity;
    this.jumpProgress = 0;
    this.jumpFrom = null;
    this.jumpTo = null;
    this.jumpSecondsCurrent = null;
    this.jumpArcCurrent = null;
    this.hopPhase = 0;
    this.frozen = false;
    this.replanFailures = 0;
    this.reachable = null;
    this.lastRaisedAt = -Infinity;
  }

  getReachable() {
    return this.reachable;
  }

  // Drop onto the grid at (or near) a world point. Returns false when the map
  // has nowhere to stand yet.
  start(worldPosition, now = 0) {
    const node = this.grid.nodeAtWorld(worldPosition);
    if (!node) return false;
    this.reset();
    this.node = node;
    this.position = this.grid.worldOf(node);
    this.state = CHASE_STATE.WALK;
    this.lastRetargetAt = now;
    this.targetSetAt = now;
    this.lastProgressAt = now;
    this.lastRaisedAt = now;
    this.markVisited(node, now);
    this.emit('start');
    return true;
  }

  // Tracking loss should not be a free head start for Hachuping.
  setFrozen(frozen) {
    const next = Boolean(frozen);
    if (next !== this.frozen && this.isActive()) {
      this.emit(next ? 'frozen' : 'unfrozen');
    }
    this.frozen = next;
  }

  markVisited(node, now) {
    this.recentVisits.set(nodeKey(node.cx, node.cz, node.level), now);
  }

  isActive() {
    return this.state !== CHASE_STATE.IDLE && this.state !== CHASE_STATE.CAUGHT;
  }

  stop() {
    this.state = CHASE_STATE.CAUGHT;
  }

  // dt in seconds, now in ms.
  update(dt, { playerPosition = null, now = 0, speedMultiplier = 1 } = {}) {
    if (!this.isActive() || !this.position) return this.getState();
    if (this.frozen || dt <= 0) return this.getState();

    if (this.state === CHASE_STATE.JUMP) {
      this.advanceJump(dt, now);
      this.headingAngle = approachAngle(
        this.headingAngle, this.targetHeadingAngle, this.turnRateRadPerS * dt,
      );
      return this.getState();
    }

    // The terrain can be swapped wholesale under our feet (the keyframe
    // pipeline resets and refills the grid on every refilter). Detect a node
    // that no longer exists — or now means a different height — and walk, not
    // teleport, to the nearest cell that is still real.
    this.validateGround(now);

    const distance = playerPosition
      ? Math.hypot(
        this.position[0] - playerPosition[0],
        this.position[2] - playerPosition[2],
      )
      : Infinity;
    let targetSpeed = speedForDistance(distance, this.speedBands) * speedMultiplier;
    // An escape must not crawl at far-away idle pace: the player is usually
    // watching a frozen character, and the walk back is the fix, not the show.
    if (this.escaping) targetSpeed = Math.max(targetSpeed, this.escapeMinSpeed);
    this.currentSpeed = approachValue(
      this.currentSpeed, targetSpeed, this.speedAccelMps2 * dt,
    );
    const speed = this.currentSpeed;

    this.ensurePath(playerPosition, now);
    if (!this.path.length) {
      this.headingAngle = approachAngle(
        this.headingAngle, this.targetHeadingAngle, this.turnRateRadPerS * dt,
      );
      return this.getState();
    }

    let budget = speed * dt;
    let guard = 0;
    while (budget > 1e-6 && guard < 64) {
      guard += 1;
      const next = this.path[this.pathIndex];
      if (!next) {
        this.path = [];
        break;
      }
      const nextWorld = this.grid.worldOf(next);
      if (!nextWorld) {
        this.path = [];
        break;
      }

      if (next.move === MOVE.JUMP) {
        this.beginJump(nextWorld, next, now);
        return this.getState();
      }

      const dx = nextWorld[0] - this.position[0];
      const dz = nextWorld[2] - this.position[2];
      // Distance must count height too. A reanchor after a terrain swap can be
      // purely vertical, and measuring only the ground plane made that read as
      // "already arrived" — snapping the character up half a metre in a frame.
      const step = Math.hypot(dx, nextWorld[1] - this.position[1], dz);
      if (step <= budget || step < 1e-6) {
        this.position = nextWorld.slice();
        this.node = next;
        this.markVisited(next, now);
        // Arriving anywhere valid ends a recovery walk.
        this.reanchoring = false;
        this.escaping = false;
        this.pathIndex += 1;
        this.lastProgressAt = now;
        budget -= step;
        if (this.pathIndex >= this.path.length) {
          this.path = [];
          break;
        }
      } else {
        const ratio = budget / step;
        this.position = [
          this.position[0] + dx * ratio,
          this.position[1] + (nextWorld[1] - this.position[1]) * ratio,
          this.position[2] + dz * ratio,
        ];
        this.setHeading(dx, dz);
        budget = 0;
      }
    }

    this.hopPhase += dt * this.hopHz * Math.PI * 2 * (speed > 0.05 ? 1 : 0);
    this.headingAngle = approachAngle(
      this.headingAngle, this.targetHeadingAngle, this.turnRateRadPerS * dt,
    );
    pruneVisits(this.recentVisits, now, this.recentWindowMs);
    return this.getState();
  }

  setHeading(dx, dz) {
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return;
    this.heading = [dx / length, dz / length];
    // The smoothed headingAngle chases this in update(); the raw vector stays
    // instantaneous because flee scoring wants the true direction of travel.
    this.targetHeadingAngle = Math.atan2(dx, dz);
  }

  // ── terrain-change recovery ───────────────────────────────
  // The node this runner stands on is an index into the grid, not a place: a
  // wholesale grid refill can delete it or shift what height its level number
  // refers to. When that happens, pick the nearest cell that still exists and
  // WALK there — a snap would read as teleporting.
  validateGround(now) {
    if (!this.node || !this.position) return;
    if (this.reanchoring && this.path.length) return; // already walking to safety
    const world = this.grid.worldOf(this.node);
    // 0.3m covers legitimate mid-step interpolation (maxStepUp plus a slab);
    // anything larger means the level index now points at different geometry.
    if (world && Math.abs(world[1] - this.position[1]) <= 0.3) return;

    const nearest = this.grid.nodeAtWorld(this.position);
    if (!nearest) {
      // Grid momentarily empty — hold still rather than guess.
      this.path = [];
      this.emit('reanchor-fail');
      return;
    }
    const nearestWorld = this.grid.worldOf(nearest);
    this.emit('reanchor', nearestWorld
      ? `${Math.hypot(
        nearestWorld[0] - this.position[0],
        nearestWorld[2] - this.position[2],
      ).toFixed(2)}m`
      : '');
    this.reanchoring = true;
    this.target = null;
    this.targetSetAt = now;
    this.lastRetargetAt = now;
    this.path = [{ ...nearest, move: MOVE.WALK }];
    this.pathIndex = 0;
  }

  // Duration and arc scale with the climb. A fixed 0.5s / 0.22m arc was tuned
  // for hopping a chair seat; reusing it for a 90cm desk reads as the model
  // being slid up an invisible pole rather than jumping.
  jumpShapeFor(rise) {
    const climb = Math.max(0, rise);
    return {
      seconds: this.jumpSeconds * (1 + climb * 0.9),
      arc: this.jumpArcM + climb * 0.35,
    };
  }

  beginJump(toWorld, node, now) {
    this.jumpFrom = this.position.slice();
    this.jumpTo = toWorld.slice();
    const shape = this.jumpShapeFor(toWorld[1] - this.position[1]);
    this.jumpSecondsCurrent = shape.seconds;
    this.jumpArcCurrent = shape.arc;
    this.jumpProgress = 0;
    this.state = CHASE_STATE.JUMP;
    this.pendingJumpNode = node;
    this.setHeading(toWorld[0] - this.position[0], toWorld[2] - this.position[2]);
    this.jumpStartedAt = now;
  }

  advanceJump(dt, now) {
    const seconds = this.jumpSecondsCurrent ?? this.jumpSeconds;
    this.jumpProgress = Math.min(1, this.jumpProgress + dt / seconds);
    const t = this.jumpProgress;
    const arc = Math.sin(t * Math.PI) * (this.jumpArcCurrent ?? this.jumpArcM);
    this.position = [
      this.jumpFrom[0] + (this.jumpTo[0] - this.jumpFrom[0]) * t,
      this.jumpFrom[1] + (this.jumpTo[1] - this.jumpFrom[1]) * t + arc,
      this.jumpFrom[2] + (this.jumpTo[2] - this.jumpFrom[2]) * t,
    ];
    if (t < 1) return;

    this.position = this.jumpTo.slice();
    this.node = this.pendingJumpNode;
    this.markVisited(this.node, now);
    this.pathIndex += 1;
    this.lastProgressAt = now;
    this.state = CHASE_STATE.WALK;
    if (this.pathIndex >= this.path.length) this.path = [];
  }

  // Pick a new destination when the current one is reached, has gone stale, or
  // could not be reached in time.
  ensurePath(playerPosition, now) {
    // Every frame, not only the ones that retarget: a climb that happens and
    // ends between two retargets still counts as having been on furniture.
    const floorSlab = this.grid.resolveFloorSlab();
    if (floorSlab !== null
      && this.position[1] - this.grid.slabTopY(floorSlab) > this.raisedThresholdM) {
      this.lastRaisedAt = now;
    }
    const overdueForFurniture = now - this.lastRaisedAt > this.raisedIntervalMs;

    const pathDone = !this.path.length || this.pathIndex >= this.path.length;
    // "Stuck" means no forward progress, not merely an old target. Measured on
    // five room scans: the old wall-clock rule abandoned 84% of furniture
    // destinations while Hachuping was still walking to them, which is why it
    // was so rarely seen on a chair.
    const stuck = now - this.lastProgressAt > this.stuckMs;
    // The retarget timer keeps it reactive to the player, but only fires while
    // the current destination is genuinely worse than starting over: the player
    // is now closer to it than Hachuping is, so running there is running at
    // them. Otherwise the walk continues and it actually arrives.
    let compromised = false;
    if (playerPosition && this.target) {
      const goal = this.grid.worldOf(this.target);
      if (!goal) {
        compromised = true;
      } else {
        const mine = Math.hypot(goal[0] - this.position[0], goal[2] - this.position[2]);
        const theirs = Math.hypot(goal[0] - playerPosition[0], goal[2] - playerPosition[2]);
        compromised = theirs < mine;
      }
    }
    const timerDue = now - this.lastRetargetAt > this.retargetMs;
    if (!(pathDone || stuck || (timerDue && compromised))) return;


    // Recomputed per retarget rather than per frame: the map grows while the
    // chase runs, so yesterday's flood would miss newly scanned ground.
    this.reachable = reachableFrom(this.grid, this.node);

    const target = chooseFleeTarget(this.grid, {
      ...this.fleeOptions,
      from: this.node,
      playerPosition,
      recentVisits: this.recentVisits,
      now,
      recentWindowMs: this.recentWindowMs,
      heading: this.heading,
      random: this.random,
      reachable: this.reachable,
      preferRaised: overdueForFurniture,
    });
    this.lastRetargetAt = now;
    if (!target) {
      this.replanFailures += 1;
      this.emit('replan-fail', '목적지 없음');
      this.maybeEscape(playerPosition, now);
      return;
    }

    const path = findPath(this.grid, this.node, target);
    if (!path || path.length < 2) {
      this.replanFailures += 1;
      this.emit('replan-fail', '경로 없음');
      this.maybeEscape(playerPosition, now);
      return;
    }
    this.replanFailures = 0;
    this.escaping = false;
    this.target = target;
    this.targetSetAt = now;
    this.lastProgressAt = now;
    this.path = path.slice(1); // index 0 is where we already stand
    this.pathIndex = 0;
    this.emit('retarget', `${this.path.length}칸`);
  }

  // Repeated replan failure means Hachuping is walled into a pocket the map
  // does not connect to anything — a noise island, or the far side of a glass
  // pane the depth camera saw through. The player is standing somewhere that
  // is definitely real, scanned floor, so heading toward them always leads
  // back to valid terrain. Rare enough that clipping a wall on the way is a
  // better outcome than a character frozen in place with no explanation.
  maybeEscape(playerPosition, now) {
    if (!playerPosition) return;
    if (this.replanFailures < this.escapeAfterFailures) return;

    const node = this.grid.nodeAtWorld(playerPosition);
    if (!node) return;
    const world = this.grid.worldOf(node);
    if (!world) return;

    const direct = findPath(this.grid, this.node, node);
    if (direct && direct.length >= 2) {
      // A legal route existed after all — take it rather than clipping.
      this.path = direct.slice(1);
      this.pathIndex = 0;
    } else {
      this.path = [{ ...node, move: MOVE.WALK }];
      this.pathIndex = 0;
    }
    this.escaping = true;
    this.replanFailures = 0;
    this.target = node;
    this.targetSetAt = now;
    this.emit('escape', `${Math.hypot(
      world[0] - this.position[0], world[2] - this.position[2],
    ).toFixed(1)}m`);
  }

  // Small vertical bob so a model with no skeleton still reads as moving.
  visualOffsetY() {
    if (this.state === CHASE_STATE.JUMP) return 0;
    return Math.abs(Math.sin(this.hopPhase)) * this.hopHeightM;
  }

  getState() {
    return {
      state: this.state,
      position: this.position ? this.position.slice() : null,
      visualY: this.position ? this.position[1] + this.visualOffsetY() : null,
      headingAngle: this.headingAngle,
      node: this.node,
      target: this.target,
      pathLength: this.path.length,
      pathIndex: this.pathIndex,
      replanFailures: this.replanFailures,
      frozen: this.frozen,
      speed: this.currentSpeed,
      reanchoring: this.reanchoring,
      escaping: this.escaping,
    };
  }

  // Remaining route in world space, for the operator view overlay.
  remainingPathWorld() {
    const out = [];
    if (this.position) out.push(this.position.slice());
    for (let i = this.pathIndex; i < this.path.length; i += 1) {
      const world = this.grid.worldOf(this.path[i]);
      if (world) out.push(world);
    }
    return out;
  }
}
