export const MAP_SECONDS = 20;
export const SAMPLE_GAP_MS = 250;
export const MIN_CANDIDATE_SPACING = 0.22;
export const MAX_TRACKING_STEP = 0.35;
export const HORIZONTAL_SURFACE_THRESHOLD = 0.62;
export const DETECT_MAX_DISTANCE_M = 5;
export const DETECT_MAX_ANGLE_DEG = 12;
export const NINJA_CAMOUFLAGE_OPACITY = 0.13;
export const NINJA_HORIZONTAL_OFFSET_M = 0.02;
export const NINJA_VERTICAL_OFFSET_M = 0.12;

// Scanned glTF model the game hides. Relative so GitHub Pages subpaths resolve.
// The built-in ninja is drawn instead when the file is missing or fails to load.
export const HIDDEN_MODEL_URL = './hcp.glb';
// Body shrunk from 30x30x50cm to a 20cm-wide footprint that matches one
// traversal cell exactly. Height keeps the model's proportions: 50 * (20/30)
// = 33.3cm, rounded UP to the next whole centimetre.
export const HIDDEN_MODEL_HEIGHT_M = 0.34;

// Depth point-cloud reconstruction (?depth=cloud mode).
export const DEPTH_CLOUD_SAMPLE_GAP_MS = 200; // read depth at most this often
export const DEPTH_CLOUD_GRID_COLS = 40; // samples taken across the depth frame
export const DEPTH_CLOUD_GRID_ROWS = 30;
export const DEPTH_CLOUD_VOXEL_M = 0.05; // dedup resolution (5cm)
export const DEPTH_CLOUD_MAX_POINTS = 60000; // hard cap on accumulated points
export const DEPTH_CLOUD_MAX_RANGE_M = 6; // ignore samples farther than this

// Dynamic depth-only mesh (?occlusion=cpu mode).
export const CPU_OCCLUSION_GRID_COLS = 80;
export const CPU_OCCLUSION_GRID_ROWS = 60;
export const CPU_OCCLUSION_SAMPLE_GAP_MS = 66;
export const CPU_OCCLUSION_MAX_RANGE_M = 6;
export const CPU_OCCLUSION_DEPTH_BIAS_M = 0.05;
export const CPU_OCCLUSION_MAX_DEPTH_JUMP_M = 0.20;
export const CPU_OCCLUSION_STALE_MS = 250;

// Voxel reconstruction / operator view.
export const VOXEL_SIZE_M = 0.05;
export const VOXEL_SOLID_MIN_HITS = 3;
// Raised from 20000 for the pre-built map flow: an untimed walk around a room
// measured ~62k voxels at 5cm, and a full map that silently stops growing is
// worse than the extra ~1MB the larger buffers cost.
export const VOXEL_MAX_SOLID = 80000;
export const VOXEL_MAX_PENDING = 40000;
export const TRAIL_MIN_STEP_M = 0.15;
export const TRAIL_MAX_POINTS = 300;
export const OPERATOR_STATUS_GAP_MS = 200;
export const OPERATOR_RENDER_GAP_MS = 100;

// Keyframe voxel diagnostic (?voxel=debug mode). Unlike the cloud path above,
// capture is gated on camera motion rather than a wall clock, and every filter
// threshold below is a starting value the on-device sliders can re-tune without
// a rescan.
// The diagnostic scan runs until the panel's stop button, for practical
// purposes: a room takes minutes to cover, and rebuild latency is acceptable
// there because the mode exists to inspect the map, not to play on it.
export const VOXEL_SCAN_SECONDS = 600;
export const VOXEL_KEYFRAME_MIN_TRANSLATION_M = 0.20;
export const VOXEL_KEYFRAME_MIN_ROTATION_DEG = 15;
// Raw keyframes cost ~77KB each (160x120 float32), so 400 is ~31MB in memory
// and ~40MB as exported JSON — the export size is what bounds this, not RAM.
export const VOXEL_KEYFRAME_MAX = 400;
export const VOXEL_KEYFRAME_MIN_GAP_MS = 250; // frame-budget guard, not a pose gate
export const VOXEL_KEYFRAME_MAX_SAMPLES = 40000; // 160x120 native fits at stride 1
export const VOXEL_DEBUG_MAX_CELLS = 200000;
export const VOXEL_DEBUG_MAX_INSTANCES = 120000; // a silent cap would corrupt the diagnosis
export const VOXEL_OVERLAY_MAX_INSTANCES = 6000;
export const VOXEL_OVERLAY_RADIUS_M = 4.0;
export const VOXEL_OVERLAY_REBUILD_STEP_M = 0.3;
export const VOXEL_REBUILD_DEBOUNCE_MS = 150;
// Chase mode (?mode=chase). Hachuping runs a legal route over the scanned
// space and the player has to hold SCAN while staying close to catch it.
export const CHASE_CELL_SIZE_M = 0.20;      // top-down grid resolution
export const CHASE_SLAB_HEIGHT_M = 0.10;    // vertical resolution per cell
export const CHASE_GRID_MIN_Y = -3.0;       // 'local' origin sits ~1.4m above the floor
export const CHASE_GRID_SLABS = 64;
export const CHASE_BODY_HEIGHT_M = 0.34;    // headroom = the body height above
export const CHASE_MAX_STEP_UP_M = 0.15;    // above this it is a jump
// Hip-height furniture (~90cm on a 177cm person) was unreachable at 0.45, so
// Hachuping never used the room's most interesting surfaces. Raised to clear
// it in one hop.
//
// The aerial-highway failure this replaced is now held off by two other
// guards rather than by a low ceiling on the jump itself: raised footholds
// must look like real platforms (hasRaisedSupport), and climbing costs double
// its height in the path cost, so the ground route stays the cheap one.
export const CHASE_MAX_JUMP_UP_M = 0.95;   // above this it cannot go at all
export const CHASE_MAX_DROP_M = 1.2;
// A ceiling looks exactly like a tabletop to the grid, so cap how high a
// surface may be above the detected floor before it stops counting.
// Lowered from 1.3 after on-device play: at 1.3 the room's real furniture
// (chair 44cm, desk 69cm) shared the cap with 873 reachable cells ABOVE 80cm,
// most of them floating clusters with nothing beneath — monitor tops, sparse
// wall patches, partition edges. Hachuping perching there reads as a bug even
// when the geometry is real. 0.85 keeps chairs and desks (measured on five
// room scans) and removes 84% of the high cells.
export const CHASE_MAX_STAND_ABOVE_FLOOR_M = 0.85;
// Refuse to start on a bare map. Tuned down from 120 when the default terrain
// became the keyframe/TSDF pipeline: it confirms voxels far more conservatively
// than the old legacy map, so the same walk yields fewer walkable cells. A real
// on-device room scan (9 keyframes, a 47-point walk) reached only 104 walkable
// cells, so the old 120 gate never opened and the chase — and Hachuping — never
// started. 80 cells (~3.2 m2 at 0.2 m) still rejects a genuinely bare map while
// letting a properly-walked room begin. See tests/chase-start-gate.test.mjs.
export const CHASE_MIN_WALKABLE_CELLS = 80;
// How long Hachuping may stay at ground level before its next destination is
// forced to be furniture. A round is only filmed for a minute or two, so the
// climb has to be something the player is guaranteed to see, not something
// that averages out over ten minutes.
export const CHASE_RAISED_INTERVAL_MS = 15000;
export const CHASE_RETARGET_MS = 3000;
export const CHASE_STUCK_MS = 4000;
export const CHASE_RECENT_WINDOW_MS = 15000; // how long a visited cell stays penalised
export const CHASE_GRID_MAX_TILES = 6000;
// In-AR terrain overlay (the 지형 button). Tighter than the operator view's
// 6000 tiles: these are drawn over a live camera composite every frame, and a
// 4m radius is as far as "is it standing on that tile" can be judged anyway.
export const CHASE_OVERLAY_MAX_INSTANCES = 2500;
export const CHASE_OVERLAY_RADIUS_M = 4.0;
export const CHASE_OVERLAY_REBUILD_STEP_M = 0.3;
export const CHASE_OVERLAY_TILE_THICKNESS_M = 0.02;
export const CHASE_PATH_MAX_POINTS = 256;
export const CHASE_GRID_REBUILD_GAP_MS = 250;

// RANSAC floor plane (?floor=ransac). Fitted once when the map is frozen to
// CONFIRM a coherent, near-horizontal floor exists, then used to fill sparse-scan
// gaps in the chase grid AT THE OBSERVED FLOOR HEIGHT. The plane's absolute
// height is deliberately not trusted: a scan's densest surface can be a desk
// (which floated the character) and its lowest points can be sub-floor noise
// (which sank it), so the fill sits at the height the observations already agree
// on. Validated offline against four on-device scans (results/*.json): floor
// height unchanged from the pre-feature baseline, walkable cells +30-45%.
export const FLOOR_RANSAC_ITERATIONS = 200;
export const FLOOR_RANSAC_DISTANCE_M = 0.06;      // inlier band ≈ one voxel
export const FLOOR_RANSAC_MAX_TILT_DEG = 10;      // reject walls / steep surfaces
export const FLOOR_RANSAC_MIN_INLIERS = 40;       // below this, keep the histogram
export const FLOOR_RANSAC_KEEP_FRACTION = 0.35;   // a chosen plane must be this
                                                  // substantial vs the best one
// Only fit to voxels in a low band, so a ceiling or tall shelf cannot win the
// plane. The band starts at a robust low height (a low percentile, ignoring
// sub-floor floaters) and reaches FLOOR_BAND_M above it.
export const FLOOR_BAND_M = 0.6;
export const FLOOR_BAND_LOW_PERCENTILE = 0.05;
// How far, in chase cells, the fitted floor is dilated into unobserved cells.
// 2 cells (~0.4 m) bridges sparse gaps without conjuring floor across real holes.
export const FLOOR_FILL_RADIUS_CELLS = 2;

// Static voxel occluder (?occluder=voxel). Built once from the scan and left
// alone, unlike the per-frame depth meshes above.
export const VOXEL_OCCLUDER_MIN_OBSERVATIONS = 3;
// Depth slack lives in the rasteriser rather than in world space: a fixed
// world offset is only correct from one direction, polygonOffset is correct
// from every angle and costs nothing.
export const VOXEL_OCCLUDER_POLYGON_OFFSET_FACTOR = 1;
export const VOXEL_OCCLUDER_POLYGON_OFFSET_UNITS = 1;
// Terrain is built from confirmed cells only: a voxel seen once is as likely
// to be depth noise as a surface, and standing Hachuping on noise is worse
// than leaving a gap in the map.
export const VOXEL_TRAVERSAL_MIN_OBSERVATIONS = 3;

// Keyframe terrain — opt-in game space map (?terrain=keyframe).
// Same gate and filters as the diagnostic, but it runs for the whole session
// with no keyframe cap and folds each keyframe into the grid the moment it
// lands, keeping only the voxels. Memory therefore scales with room size, not
// with time walked.
export const VOXEL_TERRAIN_MIN_OBSERVATIONS = 3;
// Wider than the diagnostic's 250ms: a keyframe costs a full-resolution depth
// read plus filter and unproject, and mid-chase the camera never stops moving.
export const VOXEL_TERRAIN_MIN_GAP_MS = 400;
export const VOXEL_TERRAIN_MAX_CELLS = 200000;
// When the cell cap is reached, cells seen only once are evicted first: they
// are overwhelmingly depth noise, and the alternative is a map that stops
// growing the moment the player enters a new room.
export const VOXEL_TERRAIN_EVICT_BATCH = 20000;
export const VOXEL_TERRAIN_MAX_SOLID = 60000; // operator-view instance cap

// TSDF fusion (the keyframe terrain's default; ?fusion=count restores hit
// counting for A/B). See tsdf-grid.js for what each knob trades.
// ±2 voxels = ±10cm: wider than ARCore's near-range depth noise (~2-3cm at
// 2m) so one plane fuses into one band, narrow enough that a table top and
// the floor under it stay separate surfaces.
export const TSDF_TRUNCATION_VOXELS = 2;
// After this many frames a voxel's average becomes exponential, so a moved
// chair is forgotten in ~30 frames instead of never.
export const TSDF_MAX_WEIGHT = 32;
// |tsdf| below this (in truncations) is surface. 0.3 x 10cm = a shell ~3cm
// each side; 0.5 doubled the blocked chase cells on the test scans because
// thick floors ate their own headroom.
export const TSDF_SURFACE_BAND = 0.3;
// Carve free space on every 3rd column and row: an 80x60 keyframe then
// marches ~530 rays to the surface instead of 4800, keeping the per-keyframe
// cost within a frame's budget on a phone.
export const TSDF_CARVE_STRIDE = 3;
export const TSDF_CARVE_START_M = 0.3;
// A sample at L metres weighs min(1, ref / L): depth noise grows with range,
// so a 4m sample needs twice the agreeing frames of a 2m one. Measured on two
// room scans against plain counting: isolated floaters -35%, blocked chase
// cells -40%, at the price of ~25% fewer far cells confirmed — which the
// player walking the room fills in anyway.
export const TSDF_DEPTH_WEIGHT_REF_M = 2.0;
export const TSDF_DEPTH_WEIGHT_POWER = 1;
// TSDF fuses sparse samples into continuous surfaces, so it can afford half
// the depth resolution (80x60) and run ~4x cheaper per keyframe: ~5ms on a
// desktop, versus ~18ms at full resolution.
export const TSDF_KEYFRAME_MAX_SAMPLES = 4800;
// The same halving expressed for offline rebuilds: the diagnostic and the PC
// viewer store full-resolution keyframes, so they must subsample by this to
// reproduce what the game fused live.
export const TSDF_KEYFRAME_SAMPLE_STRIDE = 2;

// Scan backup to the dev server (serve.py, POST /upload). The game map is
// re-sent on this interval and once more at session end, so a tab that dies
// mid-run still leaves a file at most this stale in results/. The diagnostic
// scan (tens of MB) is sent only at session end and on demand.
export const SCAN_BACKUP_INTERVAL_MS = 30000;
