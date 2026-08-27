import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

import {
  APP_MODES,
  autoStartsGame,
  depthUsageForSession,
  resolveAppMode,
  resolveFusionMode,
  usesKeyframeTerrain,
  usesLegacyTerrain,
  usesRansacFloor,
  usesSpaceMapping,
  usesVoxelOccluder,
} from './app-mode.js';
import {
  HIDDEN_MODEL_HEIGHT_M,
  HIDDEN_MODEL_URL,
  HORIZONTAL_SURFACE_THRESHOLD,
  MAP_SECONDS,
  MAX_TRACKING_STEP,
  MIN_CANDIDATE_SPACING,
  NINJA_CAMOUFLAGE_OPACITY,
  OPERATOR_RENDER_GAP_MS,
  OPERATOR_STATUS_GAP_MS,
  SCAN_BACKUP_INTERVAL_MS,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_STEP_M,
  VOXEL_DEBUG_MAX_INSTANCES,
  VOXEL_OCCLUDER_MIN_OBSERVATIONS,
  VOXEL_TERRAIN_MAX_SOLID,
  VOXEL_TRAVERSAL_MIN_OBSERVATIONS,
  VOXEL_MAX_SOLID,
  VOXEL_MAX_PENDING,
  VOXEL_SIZE_M,
  VOXEL_SOLID_MIN_HITS,
} from './config.js';
import { CpuDepthFrameSource } from './cpu-depth-frame-source.js';
import { TraversalGrid, nodeKey } from './traversal-grid.js';
import { ChaseRunner } from './chase-runner.js';
import { ChaseOverlay } from './chase-overlay.js';
import {
  CAPTURE_RADIUS_M, CaptureGauge, angleToTargetDeg, directionInViewSpace,
  makeArrowGate, screenAngleFromViewDirection,
} from './capture-gauge.js';
import { liveVisibleFraction } from './live-visibility.js';
import { ChaseLog } from './chase-log.js';
import { chaseStartReadiness, gridCandidatePool } from './grid-candidates.js';
import { MapAnchor } from './map-anchor.js';
import { forwardFromQuaternion } from './game-rules.js';
import {
  CHASE_BODY_HEIGHT_M,
  CHASE_CELL_SIZE_M,
  CHASE_GRID_MIN_Y,
  CHASE_GRID_REBUILD_GAP_MS,
  CHASE_GRID_SLABS,
  CHASE_MAX_DROP_M,
  CHASE_MAX_JUMP_UP_M,
  CHASE_MAX_STAND_ABOVE_FLOOR_M,
  CHASE_MAX_STEP_UP_M,
  CHASE_MIN_WALKABLE_CELLS,
  CHASE_RECENT_WINDOW_MS,
  CHASE_RAISED_INTERVAL_MS,
  CHASE_RETARGET_MS,
  CHASE_SLAB_HEIGHT_M,
  CHASE_STUCK_MS,
  FLOOR_RANSAC_ITERATIONS,
  FLOOR_RANSAC_DISTANCE_M,
  FLOOR_RANSAC_MAX_TILT_DEG,
  FLOOR_RANSAC_MIN_INLIERS,
  FLOOR_RANSAC_KEEP_FRACTION,
  FLOOR_BAND_M,
  FLOOR_BAND_LOW_PERCENTILE,
  FLOOR_FILL_RADIUS_CELLS,
} from './config.js';
import { fitFloorPlane } from './plane-fit.js';
import { CpuDepthOccluder } from './cpu-depth-occluder.js';
import { DepthCloud } from './depth-cloud.js';
import { loadHiddenModel } from './hidden-model-loader.js';
import { NinjaGame } from './ninja-game.js';
import * as ninjaModel from './ninja-model.js';
import { OperatorView } from './operator-view.js';
import { PlayerTrail } from './player-trail.js';
import {
  ScanUploader, formatSessionId, shouldBackup, uploadName,
} from './scan-uploader.js';
import { SpatialMapper } from './spatial-mapper.js';
import {
  createUI,
  formatMetrics,
  formatOperatorStatus,
  formatVoxelDebugStatus,
  formatVoxelDebugSummary,
} from './ui.js';
import { cellsFromSolidVoxels, voxelCellsToJSON } from './voxel-cells-codec.js';
import { confirmedCellPositions } from './voxel-grid.js';
import { VoxelDebugController } from './voxel-debug-controller.js';
import { createVoxelDebugPanel } from './voxel-debug-panel.js';
import { VoxelMap } from './voxel-map.js';
import { VoxelOccluder } from './voxel-occluder.js';
import { VoxelOverlay } from './voxel-overlay.js';
import { VoxelTerrain } from './voxel-terrain.js';
import { XRSessionController } from './xr-session.js';

// A WebXR session uses one depth mode. CPU mode shares that single feed between
// the latest occlusion mesh and the slower cumulative operator map.
const APP_MODE = resolveAppMode(location.search);
const CLOUD_MODE = APP_MODE === APP_MODES.CLOUD;
const CPU_OCCLUSION_MODE = APP_MODE === APP_MODES.CPU_OCCLUSION;
const GPU_OCCLUSION_MODE = APP_MODE === APP_MODES.GPU_OCCLUSION;
const VOXEL_DEBUG_MODE = APP_MODE === APP_MODES.VOXEL_DEBUG;
// Orthogonal to the depth pipeline: the static occluder composes with any mode
// but needs the keyframe scan, hence the space-mapping wiring.
const VOXEL_OCCLUDER_ON = usesVoxelOccluder(location.search);
const KEYFRAME_SCAN_MODE = VOXEL_DEBUG_MODE || VOXEL_OCCLUDER_ON;
const SPACE_MAPPING_MODE = usesSpaceMapping(APP_MODE) || VOXEL_OCCLUDER_ON;
// The game's space map comes from one of two accumulators. The keyframe scan
// modes already run their own capture and feed the chase grid from it
// (maybeFeedChaseGrid), so neither terrain accumulator runs alongside them.
const KEYFRAME_TERRAIN_MODE = usesKeyframeTerrain(APP_MODE, location.search) && !KEYFRAME_SCAN_MODE;
const LEGACY_TERRAIN_MODE = usesLegacyTerrain(APP_MODE, location.search) && !KEYFRAME_SCAN_MODE;
const RANSAC_FLOOR_MODE = usesRansacFloor(location.search);

const ui = createUI();
let scene;
let camera;
let renderer;
let controller;
let reticle;
let mapper;
let xrSession;
let game;
let depthSource = null;
// null until the first frame answers it: does XRView carry a camera, i.e. did
// the browser actually grant camera-access for this session?
let cameraAccess = null;
let depthCloud = null;
let occluder = null; // depth-sensing occlusion mesh (real world hides the ninja)
let cpuDepthOccluder = null;
let voxelMap = null;      // legacy accumulator (default)
let voxelTerrain = null;  // keyframe accumulator (?terrain=keyframe)
let playerTrail = null;
let operatorView = null;
let operatorVisible = false;

// ── chase mode ────────────────────────────────────────────────
// Only wired up on the chase page, which is the only one carrying #chaseBtn.
let chaseGrid = null;
let chaseRunner = null;
let captureGauge = null;
let chaseActive = false;
let lastChaseTime = null;
let chaseTiles = null;
let chaseTilesRevision = -1;
let chaseLog = null;
let chaseArrowGate = null;
let chaseOverlay = null;      // in-AR terrain view (지형 보기)
// The occluders write real-world depth, which would cull every tile lying on
// the real floor. The static one's state is remembered so turning the overlay
// off puts it back exactly as it was.
let occluderWasVisible = null;
// Pre-built-map lifecycle (chase page): the map is gathered while mapBuilding,
// then frozen — nothing feeds it during play, which is what stops terrain from
// changing under Hachuping's feet and errors from accumulating into the map.
let mapBuilding = false;
let mapFrozen = false;
// The nail the map hangs on. Created at the origin when building starts; every
// stored coordinate (grid cells, Hachuping) lives in ITS frame, and rendering
// converts back out. When ARCore corrects its drift the map follows the nail.
let mapAnchor = null;
let mapAnchorState = 'idle';
let lastMapStatusTime = -Infinity;
let lastTileBuildAt = -Infinity;
let lastOperatorStatusTime = -Infinity;
let lastOperatorRenderTime = -Infinity;
let operatorVoxelRevision = -1;
let operatorSolidVoxels = [];
let voxelDebug = null;
let voxelOverlay = null;
let voxelPanel = null;
let voxelOccluder = null;
let chaseFedRevision = -1;

// ── scan backup ───────────────────────────────────────────────
// One file per AR session in results/ on the dev server, refreshed on an
// interval and finalised at session end. Nothing here is load-bearing: with
// no /upload endpoint every attempt fails quietly.
let uploader = null;
let sessionId = null;
let lastBackupAt = -Infinity;
let backedUpRevision = -1;

init();

async function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 50);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xbbbbff, 2.4));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(1, 2, 1);
  scene.add(directionalLight);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  document.body.appendChild(renderer.domElement);

  reticle = ninjaModel.makeReticle();
  scene.add(reticle);

  mapper = new SpatialMapper({
    minCandidateSpacing: MIN_CANDIDATE_SPACING,
    maxTrackingStep: MAX_TRACKING_STEP,
    horizontalThreshold: HORIZONTAL_SURFACE_THRESHOLD,
  });
  xrSession = new XRSessionController({
    renderer,
    reticle,
    onHitTestError() {
      ui.setStatus('Hit-test 생성 실패');
    },
  });
  game = new NinjaGame({
    scene,
    ui,
    mapper,
    model: ninjaModel,
    getSession: () => xrSession.getSession(),
    getLocalSpace: () => xrSession.getLocalSpace(),
    getViewerPose: () => xrSession.getViewerPose(),
    // Chase page: the map is built explicitly (맵 생성 → 종료), so no timed
    // mapping phase, and hiding spots come from the frozen grid instead of
    // the crosshair pool.
    autoMapping: !ui.hasMapButton(),
    getCandidatePool: ui.hasMapButton()
      ? () => (chaseGrid ? gridCandidatePool(chaseGrid) : [])
      : null,
  });


  controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => game.triggerScan());
  scene.add(controller);

  ui.bindCommands({
    // SCAN is hidden during a chase; ignore it defensively all the same.
    onScan: () => { if (!chaseActive) game.triggerScan(); },
    onNewRound: () => game.hideNewTarget(),
    onExtend: () => game.startMapping(MAP_SECONDS, false),
    onMark: () => game.saveCheckpoint(),
    onCheck: () => game.checkReturnError(),
    onMap: () => toggleMapBuild(),
    onRespawn: () => respawnHachuping(),
  });
  // No hold handlers: capture now needs only range plus aim, so SCAN keeps its
  // ordinary tap behaviour and never sees a long press.
  // The explicit start button makes map readiness and chase state visible.
  ui.bindChase({ onToggle: () => startChase() });
  addEventListener('resize', onResize);

  const supported = Boolean(navigator.xr)
    && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!supported) {
    ui.setStatus('WebXR immersive-ar 미지원');
    ui.showFallback('navigator.xr 또는 immersive-ar 지원을 찾지 못했습니다.');
    return;
  }

  // Fetch the hiding model before the session can start. A failure here is not
  // fatal: createNinja keeps drawing the built-in ninja.
  ui.setStatus('숨을 모델 불러오는 중…');
  try {
    ninjaModel.setHiddenTemplate(
      await loadHiddenModel(HIDDEN_MODEL_URL, HIDDEN_MODEL_HEIGHT_M),
    );
  } catch (error) {
    console.error('Hidden model unavailable, using the built-in ninja:', error);
  }

  ui.setStatus(VOXEL_DEBUG_MODE
    ? 'WebXR AR 지원됨 (복셀 진단 모드) — START AR을 누르세요'
    : CLOUD_MODE
      ? 'WebXR AR 지원됨 (공간 복원 모드) — START AR을 누르세요'
      : CPU_OCCLUSION_MODE
        ? 'WebXR AR 지원됨 (CPU 깊이 가림 모드) — START AR을 누르세요'
        : 'WebXR AR 지원됨 — START AR을 누르세요');
  if (SPACE_MAPPING_MODE) {
    depthSource = new CpuDepthFrameSource({
      getSession: () => xrSession.getSession(),
    });
    uploader = new ScanUploader({
      onStatus: (text) => {
        ui.setMessage(text);
        voxelPanel?.setUploadStatus(text);
      },
    });
    if (ui.hasChaseControls()) {
      chaseGrid = new TraversalGrid({
        cellSize: CHASE_CELL_SIZE_M,
        slabHeight: CHASE_SLAB_HEIGHT_M,
        minY: CHASE_GRID_MIN_Y,
        slabCount: CHASE_GRID_SLABS,
        headroom: CHASE_BODY_HEIGHT_M,
        maxStepUp: CHASE_MAX_STEP_UP_M,
        maxJumpUp: CHASE_MAX_JUMP_UP_M,
        maxDropDown: CHASE_MAX_DROP_M,
        maxStandAboveFloor: CHASE_MAX_STAND_ABOVE_FLOOR_M,
      });
      chaseLog = new ChaseLog();
      mapAnchor = new MapAnchor();
      chaseArrowGate = makeArrowGate();
      chaseRunner = new ChaseRunner({
        grid: chaseGrid,
        retargetMs: CHASE_RETARGET_MS,
        raisedIntervalMs: CHASE_RAISED_INTERVAL_MS,
        stuckMs: CHASE_STUCK_MS,
        recentWindowMs: CHASE_RECENT_WINDOW_MS,
        onEvent: (type, detail) => chaseLog.push(performance.now(), type, detail),
      });
      captureGauge = new CaptureGauge();
    }
    playerTrail = new PlayerTrail({
      minStep: TRAIL_MIN_STEP_M,
      maxPoints: TRAIL_MAX_POINTS,
    });
    if (KEYFRAME_TERRAIN_MODE) {
      voxelTerrain = new VoxelTerrain({
        depthSource,
        fusion: resolveFusionMode(location.search),
        // Same contract VoxelMap.onSolid had: one cell touched per confirmed
        // voxel, never a full grid rebuild. TSDF can also take a voxel back
        // once enough rays have passed through it, so the chase grid must
        // release that cell or a floater stays a wall forever.
        onSolid: chaseGrid ? (center) => chaseGrid.observe(toMapSpace(center)) : null,
        onCleared: chaseGrid ? (center) => chaseGrid.unobserve(toMapSpace(center)) : null,
      });
    }
    if (LEGACY_TERRAIN_MODE) {
      voxelMap = new VoxelMap({
        voxelSize: VOXEL_SIZE_M,
        solidMinHits: VOXEL_SOLID_MIN_HITS,
        maxSolid: VOXEL_MAX_SOLID,
        maxPending: VOXEL_MAX_PENDING,
        // One cell touched per confirmed voxel — never a full grid rebuild.
        onSolid: chaseGrid ? (center) => chaseGrid.observe(toMapSpace(center)) : null,
      });
      depthCloud = new DepthCloud({
        scene,
        voxelMap,
        renderPoints: false,
        depthSource,
      });
    }
    if (KEYFRAME_SCAN_MODE) {
      // Keyframe-gated capture with per-frame dedup, replacing DepthCloud's
      // 200ms timer which lets a single frame promote a voxel on its own.
      voxelDebug = new VoxelDebugController({
        depthSource,
        // Same switch the game terrain reads, so ?fusion=count compares the
        // two fusions in the diagnostic exactly as it does in play.
        fusion: resolveFusionMode(location.search),
      });
    }
    if (VOXEL_DEBUG_MODE) {
      voxelOverlay = new VoxelOverlay({ scene });
    }
    if (KEYFRAME_SCAN_MODE) {
      // Built in the diagnostic too, so the wireframe can be checked against
      // it, but only shown automatically when it is the point of the session.
      voxelOccluder = new VoxelOccluder({ scene });
    }
    // Not on the chase page. There the only solid virtual object is Hachuping,
    // whose occlusion is a measured opacity (live-visibility.js) — per-pixel
    // cutting by this mesh is exactly the noise-vulnerable path being replaced.
    // The depth FEED stays on regardless: the voxel map and the visibility
    // measurement both read it.
    if (CPU_OCCLUSION_MODE && !ui.hasChaseControls()) {
      cpuDepthOccluder = new CpuDepthOccluder({ scene, depthSource });
    }
    try {
      operatorView = new OperatorView({
        canvas: ui.getOperatorCanvas(),
        maxVoxels: VOXEL_DEBUG_MODE
          ? VOXEL_DEBUG_MAX_INSTANCES
          : KEYFRAME_TERRAIN_MODE ? VOXEL_TERRAIN_MAX_SOLID : VOXEL_MAX_SOLID,
      });
      ui.setOperatorButtonVisible(true);
      ui.bindOperator({
        onToggle(visible) {
          operatorVisible = visible;
          ui.setOperatorVisible(visible);
        },
      });
    } catch (error) {
      console.error('Operator view unavailable:', error);
      operatorView = null;
    }
    // In-AR terrain overlay. Only where there is a chase grid to draw and a
    // button to drive it; the diagnostic has its own overlay and panel.
    if (chaseGrid && ui.hasTerrainOverlayButton() && !VOXEL_DEBUG_MODE) {
      chaseOverlay = new ChaseOverlay({ scene });
      ui.setTerrainOverlayButtonVisible(true);
      ui.setTerrainOverlayOn(false);
      ui.bindTerrainOverlay({ onToggle: toggleTerrainOverlay });
    }
    if (VOXEL_DEBUG_MODE) {
      voxelPanel = createVoxelDebugPanel({
        root: document.querySelector('#hud'),
        controller: voxelDebug,
        overlay: voxelOverlay,
        operatorView,
        onOperatorToggle: () => {
          operatorVisible = !operatorVisible;
          ui.setOperatorVisible(operatorVisible);
        },
        onStartGame: () => {
          game.startSession();
          // Starting the game in the diagnostic has exactly one purpose:
          // watching whether the character hides. Leaving the occluder off
          // makes that test silently measure nothing.
          voxelOccluder?.setVisible(true);
        },
        occluder: voxelOccluder,
        onUpload: () => backupScan('manual'),
      });
      // Nothing on the legacy metrics card applies while the game is idle, and
      // the panel already reports everything else.
      ui.setMetricsVisible(false);
    }
  }

  const arButton = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    // camera-access is requested only to find out whether this browser grants
    // it; nothing reads camera images yet. Optional, so a refusal cannot stop
    // the session from starting.
    optionalFeatures: ['anchors', 'dom-overlay', 'local-floor', 'depth-sensing', 'camera-access'],
    // gpu-optimized feeds three's built-in mesh. CPU modes let this app read
    // samples for either point-cloud reconstruction or our dynamic occluder.
    depthSensing: {
      usagePreference: [depthUsageForSession(APP_MODE, VOXEL_OCCLUDER_ON)],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
    domOverlay: { root: document.body },
  });
  document.body.appendChild(arButton);

  renderer.xr.addEventListener('sessionstart', async () => {
    detachOccluder();
    depthSource?.reset();
    cpuDepthOccluder?.reset();
    resetChaseState();
    depthCloud?.reset();
    voxelMap?.reset();
    voxelTerrain?.reset();
    playerTrail?.reset();
    lastOperatorStatusTime = -Infinity;
    lastOperatorRenderTime = -Infinity;
    operatorVoxelRevision = -1;
    operatorSolidVoxels = [];
    cameraAccess = null;
    voxelDebug?.reset();
    voxelOverlay?.clear();
    chaseOverlay?.clear();
    voxelOccluder?.reset();
    chaseFedRevision = -1;
    mapBuilding = false;
    mapFrozen = false;
    mapAnchor?.reset();
    mapAnchorState = 'idle';
    ui.setMapButton('맵 생성', true);
    ui.setChaseButton('도망 모드 시작', false);
    sessionId = formatSessionId(new Date());
    lastBackupAt = performance.now();
    backedUpRevision = -1;
    voxelDebug?.startScan(performance.now());
    await xrSession.start();
    if (autoStartsGame(APP_MODE)) game.startSession();
  });
  renderer.xr.addEventListener('sessionend', () => {
    // Serialised before anything below resets it. The page outlives the XR
    // session, so the upload itself can finish after the resets.
    backupScan('final');
    detachOccluder();
    depthSource?.reset();
    cpuDepthOccluder?.reset();
    resetChaseState();
    depthCloud?.reset();
    voxelMap?.reset();
    voxelTerrain?.reset();
    playerTrail?.reset();
    lastOperatorStatusTime = -Infinity;
    lastOperatorRenderTime = -Infinity;
    operatorVoxelRevision = -1;
    operatorSolidVoxels = [];
    cameraAccess = null;
    voxelDebug?.reset();
    voxelOverlay?.clear();
    chaseOverlay?.clear();
    voxelOccluder?.reset();
    mapBuilding = false;
    mapFrozen = false;
    mapAnchor?.reset();
    mapAnchorState = 'idle';
    ui.setMapButton('맵 생성', true);
    operatorVisible = false;
    ui.setOperatorVisible(false);
    if (autoStartsGame(APP_MODE)) game.endSession();
    xrSession.end();
  });
  renderer.setAnimationLoop(render);
}

// Once ARCore delivers a depth map, three exposes a full-screen mesh that writes
// real-world depth into the depth buffer. We make it depth-only and render it
// first, so any virtual object behind a real surface is depth-tested away — a
// hand, a body, or a pillar now hides the ninja instead of showing through it.
function maybeAttachOccluder() {
  if (occluder || !renderer.xr.hasDepthSensing?.()) return;
  const mesh = renderer.xr.getDepthSensingMesh?.();
  if (!mesh) return;
  mesh.material.colorWrite = false; // depth only — don't paint over the camera feed
  mesh.renderOrder = -1;            // fill the depth buffer before the ninja draws
  mesh.frustumCulled = false;       // vertex shader outputs clip space directly
  scene.add(mesh);
  occluder = mesh;
}

function detachOccluder() {
  if (!occluder) return;
  scene.remove(occluder);
  occluder = null; // three recreates the mesh for the next session
}

// ── pre-built map lifecycle ───────────────────────────────────
// 맵 생성 → walk the room, everything feeds the map → 맵 생성 종료 → frozen.
// Hiding and chasing then run on the frozen map only. Building again discards
// the old map entirely — mixing observations from two walks would re-create
// exactly the accumulated-error problem this flow exists to remove.
function toggleMapBuild() {
  if (!chaseGrid) return;
  if (mapBuilding) {
    freezeMap();
    return;
  }
  if (chaseActive) stopChase('도망 모드를 껐습니다.');
  mapBuilding = true;
  mapFrozen = false;
  // A rebuild is a new map: pin a fresh nail in the CURRENT corrected frame.
  mapAnchor?.reset();
  mapAnchor?.beginTracking();
  voxelMap?.reset();
  voxelTerrain?.reset();
  chaseGrid.reset();
  chaseRunner?.reset();
  chaseTiles = null;
  chaseTilesRevision = -1;
  game.clearTarget();
  game.setControls({ scan: false, newRound: false });
  ui.setMapButton('맵 생성 종료', true);
  ui.setChaseButton('도망 모드 시작', false);
  ui.setStatus('맵 생성 중 — 방을 천천히 돌며 비춰주세요');
  ui.setMessage('구석과 책상 밑까지 비출수록 좋아집니다. 충분하면 맵 생성 종료를 누르세요.');
}

function freezeMap() {
  mapBuilding = false;
  mapFrozen = true;
  // Fit the floor once, on the finished map, before anything reads walkability.
  if (RANSAC_FLOOR_MODE) applyRansacFloor();
  const { walkable } = chaseGrid.stats();
  const candidateCount = gridCandidatePool(chaseGrid).length;
  const readiness = chaseStartReadiness({
    walkable,
    candidateCount,
    minWalkable: CHASE_MIN_WALKABLE_CELLS,
  });
  game.setControls({ newRound: false });
  ui.setMapButton('맵 다시 만들기', true);
  ui.setChaseButton('도망 모드 시작', readiness.ready);
  ui.setStatus(`지도 확정 — 설 수 있는 칸 ${walkable}`);

  if (readiness.reason === 'no-candidates') {
    ui.setMessage('설 수 있는 곳이 없습니다 — 맵 다시 만들기로 바닥을 더 넓게 스캔해주세요.');
    return;
  }
  if (readiness.reason === 'insufficient-walkable') {
    ui.setMessage(`지도가 아직 부족합니다 — 갈 수 있는 칸 ${walkable}/${CHASE_MIN_WALKABLE_CELLS}. 맵 다시 만들기로 더 걸으며 비춰주세요.`);
    return;
  }
  ui.setMessage(`지도 준비 완료 — 설 수 있는 자리 ${candidateCount}곳. 도망 모드 시작을 누르세요.`);
}

// Fit the dominant floor plane to the frozen map's voxels and hand it to the
// chase grid. A failed fit (too few points, no dominant plane) leaves the grid
// on its built-in histogram floor, so the game still works.
function applyRansacFloor() {
  if (!chaseGrid) return;
  const points = chaseGrid.floorBandVoxelPoints({
    bandM: FLOOR_BAND_M,
    lowPercentile: FLOOR_BAND_LOW_PERCENTILE,
  });
  const plane = fitFloorPlane(points, {
    iterations: FLOOR_RANSAC_ITERATIONS,
    distanceThreshold: FLOOR_RANSAC_DISTANCE_M,
    maxTiltDeg: FLOOR_RANSAC_MAX_TILT_DEG,
    minInliers: FLOOR_RANSAC_MIN_INLIERS,
    keepFraction: FLOOR_RANSAC_KEEP_FRACTION,
  });
  if (plane) chaseGrid.applyFloorPlane(plane, { fillRadius: FLOOR_FILL_RADIUS_CELLS });
}

// ── chase mode ────────────────────────────────────────────────
function resetChaseState() {
  if (!chaseRunner) return;
  chaseActive = false;
  lastChaseTime = null;
  chaseRunner.reset();
  chaseGrid.reset();
  captureGauge.reset();
  chaseTiles = null;
  chaseTilesRevision = -1;
  lastTileBuildAt = -Infinity;
  chaseLog?.clear();
  chaseArrowGate = makeArrowGate();
  ui.setChaseVisible(false);
  ui.setChaseArrow(null);
  ui.setRespawnVisible(false);
  ui.setScanVisible(true);
  ui.setChaseButton('도망 모드 시작', false);
}

function stopChase(message) {
  if (!chaseRunner) return;
  chaseActive = false;
  chaseLog?.push(performance.now(), 'stop');
  chaseRunner.stop();
  game.setExternalControl(false);
  game.setTargetOpacity(NINJA_CAMOUFLAGE_OPACITY);
  ui.setChaseVisible(false);
  ui.setChaseArrow(null);
  ui.setScanVisible(true);
  ui.setMapButton('맵 다시 만들기', true);
  // A finished round must not force a rescan. The map is still frozen and
  // still valid, so offer another round on it: the start button comes back
  // whenever the terrain can still support one.
  const replayable = mapFrozen && chaseGrid
    ? chaseStartReadiness({
      walkable: chaseGrid.stats().walkable,
      candidateCount: gridCandidatePool(chaseGrid).length,
      minWalkable: CHASE_MIN_WALKABLE_CELLS,
    }).ready
    : false;
  ui.setRespawnVisible(false);
  ui.setChaseButton(replayable ? '다시 도망 시작' : '도망 모드 시작', replayable);
  if (message) ui.setMessage(message);
  if (replayable) {
    ui.setMessage(`${message ? message + ' ' : ''}같은 지도로 다시 도망 시작을 누를 수 있습니다.`);
  }
}

// Begins the chase only after the frozen map has passed the visible readiness gate.
function startChase() {
  if (!chaseRunner || !chaseGrid) return false;
  if (chaseActive) return true;
  if (!mapFrozen) {
    ui.setMessage('먼저 맵 생성과 맵 생성 종료를 완료해주세요.');
    return false;
  }

  const { walkable } = chaseGrid.stats();
  const candidateCount = gridCandidatePool(chaseGrid).length;
  const readiness = chaseStartReadiness({
    walkable,
    candidateCount,
    minWalkable: CHASE_MIN_WALKABLE_CELLS,
  });
  if (!readiness.ready) {
    ui.setChaseButton('도망 모드 시작', false);
    ui.setMessage(readiness.reason === 'no-candidates'
      ? '하츄핑을 놓을 자리가 없습니다 — 맵을 더 넓게 만들어주세요.'
      : `지도가 아직 부족합니다 — 갈 수 있는 칸 ${walkable}/${CHASE_MIN_WALKABLE_CELLS}. 맵을 다시 만들어주세요.`);
    return false;
  }

  // Hachuping is placed straight onto the frozen map: no hide-and-seek round
  // precedes the chase on this page.
  let target = game.getTargetPosition();
  if (!target) {
    if (!game.hideNewTarget()) {
      ui.setMessage('하츄핑을 놓을 자리를 찾지 못했습니다 — 맵을 더 넓게 만들어주세요.');
      return false;
    }
    target = game.getTargetPosition();
  }
  if (!chaseRunner.start(toMapSpace(target), performance.now())) {
    ui.setMessage('하츄핑이 설 자리를 찾지 못했습니다. 주변 바닥을 더 비춰주세요.');
    return false;
  }

  captureGauge.reset();
  chaseActive = true;
  lastChaseTime = null;
  game.setExternalControl(true);
  game.setTargetOpacity(1);
  ui.setChaseVisible(true);
  ui.setRespawnVisible(true);
  ui.setChaseButton('도망 모드 실행 중', false);
  ui.setChaseGauge(0);
  ui.setScanVisible(false);
  ui.setStatus('하츄핑이 도망칩니다');
  ui.setMessage(`${CAPTURE_RADIUS_M}m 안에서 화면 중앙에 5초간 담아두세요.`);
  return true;
}
function updateChase(time, frame, localSpace, viewerPose) {
  if (!chaseActive || !chaseRunner?.isActive()) return;

  const dt = lastChaseTime === null
    ? 0
    : Math.min(0.1, Math.max(0, (time - lastChaseTime) / 1000));
  lastChaseTime = time;
  if (dt <= 0) return;

  // Losing tracking must not hand Hachuping a free head start.
  chaseRunner.setFrozen(!viewerPose);
  // All chase LOGIC runs in map (anchor) space: the grid, Hachuping, and the
  // player's position converted into it. Only RENDERING converts back out, so
  // a drift correction moves the whole map together instead of leaving
  // Hachuping and the grid behind.
  const playerMap = viewerPose ? toMapSpace(viewerPose.position) : null;
  const state = chaseRunner.update(dt, {
    playerPosition: playerMap,
    now: time,
    speedMultiplier: captureGauge.speedMultiplier(),
  });
  if (state.position) {
    game.setTargetWorldPosition(
      toRenderSpace([state.position[0], state.visualY, state.position[2]]),
      state.headingAngle + (mapAnchor?.yaw() ?? 0),
    );
  }

  if (!viewerPose || !state.position) {
    ui.setChaseHint('추적 대기 중');
    return;
  }

  // Distance and aim compare like with like: the player's real position vs
  // Hachuping's RENDERED position — what the player actually sees on screen.
  const renderPos = toRenderSpace(state.position);
  const forward = forwardFromQuaternion(viewerPose.quaternion);
  const dx = renderPos[0] - viewerPose.position[0];
  const dy = renderPos[1] - viewerPose.position[1];
  const dz = renderPos[2] - viewerPose.position[2];
  const distance = Math.hypot(dx, dy, dz);
  const angleDeg = angleToTargetDeg(forward, viewerPose.position, renderPos);
  // How much of Hachuping the player can see, measured against the LIVE depth
  // image — camera position and rendered position, the same space the depth
  // views live in, so map drift cannot fake cover. null (off screen, no depth)
  // leaves the gauge treating the target as visible: no data never punishes.
  const visibility = liveVisibleFraction(
    depthSource?.read(frame, localSpace),
    viewerPose.position,
    renderPos,
    { bodyHeightM: HIDDEN_MODEL_HEIGHT_M },
  );
  const capture = captureGauge.update(dt, { distance, angleDeg, visibility });
  // One scalar for both meanings of "how covered": the gauge fills at
  // visibleScale, and the model fades to it. Fully hidden bottoms out at the
  // gauge's hidden-fill floor (0.25) instead of vanishing — the player keeps a
  // faint silhouette, and whatever is really in front stays visible through
  // it, which is also the debugging view for "what covered it?".
  game.setTargetOpacity(capture.visibleScale);

  ui.setChaseGauge(capture.value);
  ui.setChaseHint(`${captureGauge.hint()}  ·  ${distance.toFixed(1)}m`);
  ui.setChaseArrow(chaseArrowGate(angleDeg)
    ? screenAngleFromViewDirection(
      directionInViewSpace(viewerPose.quaternion, viewerPose.position, renderPos),
    )
    : null);

  if (capture.captured) {
    chaseLog?.push(time, 'captured', `${distance.toFixed(2)}m`);
    stopChase(`검거 성공! ${distance.toFixed(2)}m 에서 잡았습니다.`);
    game.startCatchCelebration();
    ui.setChaseGauge(1);
    ui.flash();
  }
}

// The 지형 button. While the overlay is up the CPU depth mesh is suppressed:
// it writes real-world depth, so the tile lying on the real floor — the one
// you are trying to see Hachuping stand on — would be culled by the floor
// itself. Occlusion comes straight back when the overlay goes away.
function toggleTerrainOverlay() {
  if (!chaseOverlay) return;
  const next = !chaseOverlay.isVisible();
  chaseOverlay.setVisible(next);
  ui.setTerrainOverlayOn(next);
  if (next) {
    occluderWasVisible = voxelOccluder ? voxelOccluder.isVisible() : null;
    cpuDepthOccluder?.setSuppressed(true);
    voxelOccluder?.setVisible(false);
  } else {
    cpuDepthOccluder?.setSuppressed(false);
    if (voxelOccluder && occluderWasVisible !== null) voxelOccluder.setVisible(occluderWasVisible);
    occluderWasVisible = null;
    chaseOverlay.clear();
  }
}

function buildChaseTiles(time) {
  if (!chaseGrid) return;
  if (time - lastTileBuildAt < CHASE_GRID_REBUILD_GAP_MS) return;
  if (chaseGrid.getRevision() === chaseTilesRevision) return;
  lastTileBuildAt = time;
  chaseTilesRevision = chaseGrid.getRevision();
  const reachable = chaseRunner?.getReachable() ?? null;
  chaseTiles = chaseGrid.toOverlay().map((tile) => ({
    ...tile,
    // null = unknown (no chase running yet), so it just draws green.
    reachable: !tile.walkable || !reachable
      ? null
      : reachable.has(nodeKey(tile.cx, tile.cz, tile.level)),
  }));
}

function render(time, frame) {
  if (!frame) {
    renderer.render(scene, camera);
    return;
  }

  const { viewerPose, surface } = xrSession.update(frame);
  if (viewerPose) mapper.recordViewer(viewerPose.position);
  game.update(time, frame, surface);

  if (SPACE_MAPPING_MODE) {
    const localSpace = xrSession.getLocalSpace();
    // The nail only holds if someone hammers it in and keeps asking where it
    // is. This call creates the anchor on the first frame that can, then
    // refreshes its pose every frame — every toMapSpace/toRenderSpace below
    // rides on that pose. It was missing entirely once: beginTracking() was
    // called but never update(), so the transforms stayed identity forever and
    // a drift correction visibly teleported Hachuping while the operator view
    // (which draws stored map coordinates) showed nothing wrong.
    if (mapAnchor) {
      const anchorState = mapAnchor.update(frame, localSpace);
      if (anchorState !== mapAnchorState) {
        mapAnchorState = anchorState;
        chaseLog?.push(time, 'map-anchor', anchorState);
      }
    }
    if (CPU_OCCLUSION_MODE) {
      cpuDepthOccluder?.update(frame, localSpace, time);
    }
    if (KEYFRAME_SCAN_MODE) {
      voxelDebug.update(frame, localSpace, time, viewerPose);
      voxelDebug.rebuildIfDirty();
      maybeBuildVoxelOccluder();
      maybeFeedChaseGrid();
    }
    // On the pre-built-map page the world feeds the map ONLY while building.
    // A frozen map is the whole point: play must not mutate it. Either terrain
    // accumulator (the team's keyframe VoxelTerrain or the legacy DepthCloud)
    // goes through the same gate.
    const feedingTerrain = !ui.hasMapButton() || mapBuilding;
    if (KEYFRAME_TERRAIN_MODE && feedingTerrain) {
      voxelTerrain.update(frame, localSpace, time, viewerPose);
    }
    if (LEGACY_TERRAIN_MODE && feedingTerrain) {
      depthCloud.update(frame, localSpace, time);
    }
    if (mapBuilding && time - lastMapStatusTime >= 500) {
      lastMapStatusTime = time;
      const { walkable } = chaseGrid?.stats() ?? { walkable: 0 };
      const solid = (voxelMap ?? voxelTerrain)?.getSolidCount() ?? 0;
      // Only the legacy accumulator has a hard cap; VoxelTerrain grows freely.
      const full = voxelMap && solid >= VOXEL_MAX_SOLID ? ' ⚠상한' : '';
      ui.setStatus(`맵 생성 중 — 복셀 ${solid}${full} · 설 수 있는 칸 ${walkable}`);
    }
    if (viewerPose) playerTrail?.record(viewerPose.position);
    if (cameraAccess === null) cameraAccess = probeCameraAccess(frame, localSpace);
    updateChase(time, frame, localSpace, viewerPose);
    // Both consumers read the same tile list, so build it when either wants it.
    if (operatorVisible || chaseOverlay?.isVisible()) buildChaseTiles(time);
    if (chaseOverlay?.isVisible()) {
      chaseOverlay.setTiles(chaseTiles ?? [], chaseTilesRevision, {
        cameraPosition: viewerPose?.position ?? null,
        // Map space -> render space, the same conversion the character gets.
        toRender: toRenderSpace,
      });
    }
    maybeBackupGameMap(time);

    const ninjaPosition = game.getTargetPosition();
    // Operator display compares positions in MAP space, the same frame the
    // grid tiles and Hachuping's stored coordinates live in. Passing the raw
    // world pose mixed two frames on one canvas: after a drift correction the
    // player dot jumped while the map stayed put — which is exactly backwards
    // as a diagnostic, since it hides the real problem (the map no longer
    // matching the room) behind a fake one. Identity while no anchor exists.
    const ninjaMapPos = ninjaPosition ? toMapSpace(ninjaPosition) : null;
    const playerMapPos = viewerPose ? toMapSpace(viewerPose.position) : null;
    const spaceMap = voxelMap ?? voxelTerrain;
    const voxelCount = spaceMap?.getSolidCount() ?? voxelDebug?.getCellCount() ?? 0;
    if (time - lastOperatorStatusTime >= OPERATOR_STATUS_GAP_MS) {
      lastOperatorStatusTime = time;
      if (VOXEL_DEBUG_MODE) {
        const stats = voxelDebug.getStats(time);
        voxelPanel?.setStatus(formatVoxelDebugStatus(stats));
        voxelPanel?.refresh();
        ui.setOperatorStatus(formatVoxelDebugSummary(stats));
      } else {
        ui.setOperatorStatus(formatOperatorStatus({
          anchorState: game.getAnchorState(),
          // game.getAnchorState() above is the NINJA's placement anchor; this
          // one is the nail the whole map hangs on. Different things that
          // share a word — both shown so a dead map anchor is visible on the
          // phone instead of silently degrading to identity transforms.
          mapAnchorState: mapAnchor ? mapAnchorState : null,
          voxelCount,
          cameraAccess,
          keyframeCount: voxelTerrain?.getKeyframeCount() ?? null,
          ninjaPosition: ninjaMapPos,
          playerPosition: playerMapPos,
          pathPointCount: playerTrail?.getCount() ?? 0,
        }));
      }
    }
    if (
      operatorVisible
      && operatorView
      && time - lastOperatorRenderTime >= OPERATOR_RENDER_GAP_MS
    ) {
      lastOperatorRenderTime = time;
      if (VOXEL_DEBUG_MODE) {
        const revision = voxelDebug.getRevision();
        operatorView.setVoxelSize(voxelDebug.getParams().voxelSize);
        operatorView.setVoxelCells(
          voxelDebug.getRenderCells(),
          revision,
          voxelDebug.getColorMode(),
        );
        operatorView.setKeyframePoses(voxelDebug.getKeyframePoses());
        operatorView.render({
          solidVoxels: null,
          voxelRevision: revision,
          ninjaPos: ninjaMapPos,
          playerPos: playerMapPos,
          playerPath: playerTrail.getPoints().map(toMapSpace),
        });
      } else if (spaceMap) {
        const voxelRevision = spaceMap.getRevision();
        if (voxelRevision !== operatorVoxelRevision) {
          operatorVoxelRevision = voxelRevision;
          operatorSolidVoxels = spaceMap.getSolidVoxels();
        }
        operatorView.render({
          gridTiles: chaseTiles,
          gridRevision: chaseTilesRevision,
          cellSize: CHASE_CELL_SIZE_M,
          chasePath: chaseActive ? chaseRunner?.remainingPathWorld() : null,
          hachupingPos: chaseActive ? chaseRunner?.position : null,
          // solidVoxels stay in the raw frame they were captured in: they are
          // a coarse backdrop, and re-projecting tens of thousands of points
          // per render is not worth it. Tiles, path, and both dots — the
          // things the diagnostic actually compares — are all map space now.
          solidVoxels: operatorSolidVoxels,
          voxelRevision,
          ninjaPos: ninjaMapPos,
          playerPos: playerMapPos,
          playerPath: playerTrail.getPoints().map(toMapSpace),
        });
      }
    }
    if (VOXEL_DEBUG_MODE && voxelOverlay?.isVisible()) {
      voxelOverlay.setVoxelSize(voxelDebug.getParams().voxelSize);
      voxelOverlay.setCells(
        voxelDebug.getRenderCells(),
        voxelDebug.getRevision(),
        voxelDebug.getColorMode(),
        { cameraPosition: viewerPose?.position ?? null },
      );
    }
  } else if (GPU_OCCLUSION_MODE) {
    maybeAttachOccluder();
  }
  if (!VOXEL_DEBUG_MODE) updateMetrics(viewerPose);
  renderer.render(scene, camera);
}

// Hands the keyframe reconstruction to the chase terrain. Without this the
// grid starves in keyframe mode, since it was only ever fed through
// VoxelMap.onSolid, which fires off the DepthCloud path this mode replaces.
//
// The rebuild is wholesale rather than incremental: a threshold change can
// remove cells as well as add them, and TraversalGrid accumulates, so it has
// to start clean. A few thousand points once per rebuild is cheap.
function maybeFeedChaseGrid() {
  if (!chaseGrid || !voxelDebug) return;
  if (voxelDebug.isScanning(performance.now())) return;
  if (voxelDebug.getRevision() === chaseFedRevision) return;
  chaseFedRevision = voxelDebug.getRevision();

  const points = confirmedCellPositions(voxelDebug.getRenderCells(), {
    minObservations: VOXEL_TRAVERSAL_MIN_OBSERVATIONS,
    voxelSize: voxelDebug.getParams().voxelSize,
  });
  chaseGrid.reset();
  chaseGrid.observeAll(points);
}

// The occluder is static: built when the scan settles and left alone. Only a
// slider in the diagnostic can change the cell set afterwards, which the
// revision gate picks up. Confidence threshold is deliberately higher than the
// display default — a single-observation voxel writing depth would hide the
// character behind noise.
function maybeBuildVoxelOccluder() {
  if (!voxelOccluder || !voxelDebug) return;
  if (voxelDebug.isScanning(performance.now())) return;

  const cells = voxelDebug.getRenderCells()
    .filter((c) => c.observationCount >= VOXEL_OCCLUDER_MIN_OBSERVATIONS);
  voxelOccluder.setVoxelSize(voxelDebug.getParams().voxelSize);
  voxelOccluder.build(cells, voxelDebug.getRevision());
  // In game mode it should start occluding as soon as it exists; in the
  // diagnostic the panel owns the toggle so the wireframe stays inspectable.
  if (!VOXEL_DEBUG_MODE) voxelOccluder.setVisible(true);
}

// ── scan backup ───────────────────────────────────────────────
// The game map as voxel-cells JSON from whichever accumulator is live, or the
// diagnostic's raw keyframes. null when there is nothing worth a file.
function exportScan() {
  const playerPath = playerTrail?.getPoints() ?? [];
  if (voxelTerrain) {
    if (voxelTerrain.getCellCount() === 0) return null;
    return { kind: 'game', text: voxelTerrain.exportJSON({ playerPath, sessionId }) };
  }
  if (voxelMap) {
    const solid = voxelMap.getSolidVoxels();
    if (solid.length === 0) return null;
    return {
      kind: 'game',
      text: JSON.stringify(voxelCellsToJSON({
        cells: cellsFromSolidVoxels(solid, VOXEL_SIZE_M, VOXEL_SOLID_MIN_HITS),
        voxelSize: VOXEL_SIZE_M,
        playerPath,
        sessionId,
        source: 'legacy',
      })),
    };
  }
  if (voxelDebug && voxelDebug.getStats().keyframeCount > 0 && !voxelDebug.isImported()) {
    return { kind: 'scan', text: voxelDebug.exportJSON() };
  }
  return null;
}

function backupScan(reason) {
  if (!uploader || !sessionId) return;
  const scan = exportScan();
  if (!scan) return;
  backedUpRevision = (voxelMap ?? voxelTerrain)?.getRevision() ?? backedUpRevision;
  lastBackupAt = performance.now();
  uploader.upload(uploadName(scan.kind, sessionId), scan.text, {
    label: reason === 'final' ? '최종 저장' : reason === 'manual' ? '수동 저장' : '자동 백업',
  });
}

// Interval backup for the game map only. The diagnostic's keyframe JSON is
// tens of MB, so it goes at session end and on the panel button.
function maybeBackupGameMap(time) {
  const spaceMap = voxelMap ?? voxelTerrain;
  if (!spaceMap || !uploader || uploader.isBusy()) return;
  if (!shouldBackup({
    now: time,
    lastBackupAt,
    intervalMs: SCAN_BACKUP_INTERVAL_MS,
    dirty: spaceMap.getRevision() !== backedUpRevision,
  })) return;
  backupScan('interval');
}

// Answer whether the browser granted raw camera access, or null while no frame
// has reported a view yet. XRView.camera exists only when camera-access was
// granted, so it is the honest signal — enabledFeatures can list a feature the
// runtime then declines to populate. Reads through the shared depth snapshot,
// so it costs nothing extra on a frame already read.
function probeCameraAccess(frame, referenceSpace) {
  const snapshot = depthSource?.read(frame, referenceSpace);
  const views = snapshot?.viewerPose?.views;
  if (!views?.length) return null;
  return Boolean(views[0].camera);
}

function updateMetrics(viewerPose) {
  if (!viewerPose) {
    ui.setMetrics('pose: tracking 대기 중');
    return;
  }

  const spatial = mapper.getMetrics();
  const gameState = game.getState();
  let depthUsage = null;
  let depthDataFormat = null;
  const session = xrSession.getSession();
  if (session) {
    try {
      depthUsage = session.depthUsage;
      depthDataFormat = session.depthDataFormat;
    } catch {
      // Access throws when depth-sensing was not enabled for this session.
    }
  }
  ui.setMetrics(formatMetrics({
    viewerPosition: viewerPose.position,
    pathDistance: spatial.pathDistance,
    maxDisplacement: spatial.maxDisplacement,
    poolCount: spatial.poolCount,
    hitTestFound: xrSession.hasHitTest(),
    phase: gameState.phase,
    mappingLeft: gameState.mappingLeft,
    scans: gameState.scans,
    misses: gameState.misses,
    lastReturnError: spatial.lastReturnError,
    occlusionMode: CPU_OCCLUSION_MODE
      ? 'cpu'
      : GPU_OCCLUSION_MODE && renderer.xr.hasDepthSensing?.() ? 'gpu' : null,
    occlusionTriangles: cpuDepthOccluder?.getTriangleCount() ?? 0,
    chaseLogText: chaseLog?.formatRecent() ?? '',
    voxelCount: SPACE_MAPPING_MODE
      ? (voxelMap?.getSolidCount() ?? voxelTerrain?.getSolidCount() ?? voxelDebug?.getCellCount() ?? 0)
      : null,
    depthUsage,
    depthDataFormat,
    anchorState: game.getAnchorState(),
  }));
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}


// Drops Hachuping somewhere new on the SAME frozen map. Used when a chase
// goes wrong — stuck in geometry, buried under the floor, wandered somewhere
// unreachable — so a bad round costs a button press instead of a rescan.
function respawnHachuping() {
  if (!chaseActive || !chaseRunner || !chaseGrid) return false;

  game.clearTarget();
  if (!game.hideNewTarget()) {
    ui.setMessage('놓을 자리를 찾지 못했습니다 — 맵을 다시 만들어주세요.');
    return false;
  }
  const target = game.getTargetPosition();
  if (!target || !chaseRunner.start(toMapSpace(target), performance.now())) {
    ui.setMessage('하츄핑이 설 자리를 찾지 못했습니다.');
    return false;
  }

  // A respawn is a fresh round on the same terrain: the gauge must not carry
  // over, or a nearly-complete capture would finish on a brand new target.
  captureGauge.reset();
  chaseArrowGate = makeArrowGate();
  lastChaseTime = null;
  game.setExternalControl(true);
  game.setTargetOpacity(1);
  ui.setChaseGauge(0);
  ui.setChaseArrow(null);
  chaseLog?.push(performance.now(), 'respawn');
  ui.setMessage('하츄핑을 다시 놓았습니다.');
  return true;
}

// ── map-anchor space helpers ──────────────────────────────────
// Everything the map stores lives in the anchor's frame; these are identity
// until an anchor exists, so every caller can use them unconditionally.
function toMapSpace(point) {
  return mapAnchor ? mapAnchor.toAnchor(point) : point;
}

function toRenderSpace(point) {
  return mapAnchor ? mapAnchor.toWorld(point) : point;
}
