// Three.js adapter for the first-person walk editor — the ONLY place three.js
// is imported (spec "Forbidden relationships", docs/3d-editor-spec.md; the
// bundle boundary is grep-auditable). A plain class, deliberately store-/React-/
// MapLibre-free: it consumes a renderer-agnostic Scene3D (src/scene/scene-build)
// plus callbacks, so undo/redo, persistence and the 2D editor's reactivity all
// stay in the store. Ported from the throwaway spike (scratch/_scratch-3d-spike)
// — same proven recipes (dark casino-noir, warm downlights, green surveillance
// cones), rewritten as strict typed production code.

import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MetreXY } from "../types";
import type { Category, FixtureKind } from "../types";
import { pointInRing } from "../coverage";
import { disposeMaterials, getEmissiveMaterial, getMaterial, materialForCategory } from "./materials";
import { disposeFixtureModels, getFixtureModel } from "./fixtures";
import { BloomPipeline } from "./post";
import {
  EYE_M,
  WALL_THICKNESS_M,
  type Scene3D,
  type SceneCameraPose,
  type ScenePrism,
} from "../scene/scene-build";

/** What the renderer reports back up to the (store-aware) WalkView shell. */
export interface WalkRendererOpts {
  /** A locked-mode crosshair click resolved to a camera under the reticle (or
   *  null for empty space). The shell routes it to the store's setSelectedCamera. */
  onPickCamera(id: string | null): void;
  /** Optional: fired when the effective render quality changes — including the
   *  automatic High→Low fallback — so the HUD label can reflect the real state.
   *  Manual toggles fire it too (idempotently). Nice-to-have, not required. */
  onQualityChange?(q: RenderQuality): void;
}

/** Render quality: "high" runs the bloom composer; "low" is a plain forward
 *  render (the perf valve for the GTX 1650 target). */
export type RenderQuality = "high" | "low";

/** Coverage-cone display policy. `selected` lights only the selected camera;
 *  `nearby` adds up to 8 cameras nearest the player (≤ 9 shadow casters total);
 *  `off` shows no cones. */
export type CoverageMode = "selected" | "nearby" | "off";

const DEG = Math.PI / 180;
const WALK_SPEED = 4.2; // m/s (spike-calibrated)
const RUN_SPEED = 8.5; // m/s (Shift)

// R4 auto quality fallback: sample locked-mode frame times at High and, if the
// GPU can't hold the budget, drop to Low ONCE so the GTX 1650 degrades gracefully.
// Sampling is gated on controls.isLocked (real in-scene load, not the idle
// preview) and skips a warmup window (first-render shader compile / texture upload
// spikes would poison an early median). The median over the sample window is
// compared to the budget; a manual quality choice disables this entirely.
const AUTO_WARMUP_FRAMES = 8; // locked frames skipped before sampling (compile spikes)
const AUTO_SAMPLE_FRAMES = 60; // locked frames sampled before the one-shot decision
const AUTO_FRAME_MS_BUDGET = 28; // median locked frame time (ms) above which High → Low (~36 fps)
// Forward renderer: EVERY house PointLight is evaluated per fragment (no light
// culling), so this count is a hard fill-rate budget on entry-level Turing
// (GTX 1650) — the proven spike used 5 fixed downlights. Keep it a small
// multiple of that, evenly spread over the footprint (see addHouseLights),
// rather than a dense fixed grid that saturated ~48 lights on a big floor.
// R3 reduced from 12 → 8 to make forward-render room for the pit pendants below.
// Budget honestly: these static lights are NOT the whole forward path. The same
// scene also carries up to MAX_SHADOW_LIGHTS (9) coverage SpotLights (see
// addCoverageLight) whenever coverageMode is `nearby` — each PCF-sampling a 2048²
// shadow map, the most expensive lights the lit shader loops over. So peak
// concurrent = 3 base (ambient/hemi/dir) + 8 house + 8 pit + up to 9 coverage
// spots ≈ 28 fragment-evaluated lights, NOT 19. (`selected`/`off` modes keep only
// 1/0 coverage spots, so the static ~19 is the floor, not the ceiling.) The 12 → 8
// house cut buys headroom against that ~28 worst case — where the 9 shadow spots
// dominate cost — rather than trading against an imaginary sub-20 static budget.
const MAX_HOUSE_LIGHTS = 8; // forward-rendering fill-rate budget for warm downlights
const HOUSE_LIGHT_STEP_M = 22; // MINIMUM downlight grid spacing (widened per-floor to stay under the budget)
const MAX_SHADOW_LIGHTS = 9; // hard cap on shadow-casting coverage spotlights
const BASEBOARD_H = 0.12; // baseboard trim height, metres (spec R1)
const CEILING_PANEL_STEP_M = 7; // recessed-light panel grid spacing, metres
const MAX_CEILING_PANELS = 24; // cap on emissive ceiling panels (look-only, no lights)
const PANEL_EMISSIVE_I = 2.2; // recessed ceiling-panel emissive level (recede-able)

// R3 pit pendants: ONE warm shadow-free PointLight per gaming-table cluster so the
// pits pool in light and read as the room's focus. Table centroids are grid-
// bucketed (PIT_GRID_M) into pits; the densest MAX_PIT_LIGHTS pits get a pendant.
const MAX_PIT_LIGHTS = 8;
const PIT_GRID_M = 12; // bucket size for merging nearby tables into one pit light
const PIT_LIGHT_H = 2.4; // pendant hang height, metres (clamped under the ceiling)
const PIT_LIGHT_COLOR = 0xffbf7a; // warm pendant
const PIT_LIGHT_INTENSITY = 50;
const PIT_LIGHT_RANGE = 18;
const PIT_LIGHT_DECAY = 1.6;

// Table kinds that anchor a pit light, and (a subset) that get a ring of stools.
const PIT_TABLE_KINDS: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  "blackjack", "roulette", "baccarat", "poker", "craps", "wheel",
]);
const STOOL_TABLE_KINDS: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  "blackjack", "roulette", "baccarat", "poker", "craps",
]);
const STOOLS_PER_TABLE = 8; // cap of low-poly stools ringed around each card table
const STOOL_GAP = 0.35; // gap outside the table footprint the stool ring sits at

// R3 neon signage — thin emissive valance along the top of each functional room's
// walls, coloured by function bucket (matches src/categories.ts functionBucket).
// Modest intensity + small area so it never outshines the green coverage cones.
const SIGNAGE_H_BELOW_CEIL = 0.28; // valance drop below the ceiling, metres
const SIGNAGE_VAL_H = 0.14; // valance strip height, metres
const SIGNAGE_VAL_D = 0.05; // valance strip depth, metres
const SIGNAGE_INSET_M = 0.08; // pull the strip inside the room so neighbours don't co-plane
const SIGNAGE_EMISSIVE_I = 1.1;
const NEON_GAMING = 0xff9a3d; // gaming floor — warm amber
const NEON_BAR = 0x3ad0e6; // bar / sportsbook — cyan
const NEON_PREMIUM = 0xd94fce; // high-limit / poker / showroom — magenta
const NEON_FNB = 0xffb060; // food & retail — warm

// Camera-primary world-recede: when a camera is selected the world dims + the fog
// deepens so the lit coverage cone + emphasized camera body dominate. Applied by
// scaling stored base values (exact restore), never a rebuild.
const BASE_FOG_DENSITY = 0.005;
const FOCUS_LIGHT_SCALE = 0.4; // house/pit/ambient/hemi/fill dimmed to this on focus
const FOCUS_FOG_SCALE = 1.5; // fog density deepened by this on focus
const FOCUS_EMISSIVE_SCALE = 0.4; // signage + ceiling-panel glow dimmed to this on focus

// model metre-space [x, y] (x-east, y-north) -> three (x, h, -y), Y-up.
const v3 = (x: number, y: number, h: number): THREE.Vector3 => new THREE.Vector3(x, h, -y);

// Forward direction in three-space from stored angles (heading° from +x CCW,
// tilt° BELOW horizontal — the spike's camDir3). tilt 90° ⇒ straight down.
function camDir3(headingDeg: number, tiltDeg: number): THREE.Vector3 {
  const h = headingDeg * DEG;
  const t = tiltDeg * DEG;
  return new THREE.Vector3(Math.cos(h) * Math.cos(t), -Math.sin(t), -Math.sin(h) * Math.cos(t));
}

// Orientation looking along camDir3, then rolled about the view axis (local Z).
/** Bake a flat vertex colour onto a geometry so many parts can merge into one
 *  vertex-coloured mesh under a single material (one draw call per camera). */
function colored(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** A bullet/box security camera, ~0.24 m long, lens pointing local −Z (the view
 *  direction poseQuaternion aligns to): housing + sun-hood + lens barrel + glass
 *  cap + a short ceiling stalk. Reads as a camera from across a room where the
 *  old plain box read as a green blob. */
function buildBulletCamGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const housing = new THREE.BoxGeometry(0.13, 0.12, 0.24);
  housing.translate(0, 0, 0.02);
  parts.push(colored(housing, 0x9298a2));
  const hood = new THREE.BoxGeometry(0.16, 0.02, 0.26);
  hood.translate(0, 0.075, -0.02);
  parts.push(colored(hood, 0x5f646d));
  const barrel = new THREE.CylinderGeometry(0.05, 0.055, 0.12, 18);
  barrel.rotateX(Math.PI / 2); // cylinder axis Y -> Z (points down the lens)
  barrel.translate(0, 0, -0.16);
  parts.push(colored(barrel, 0x2b2e35));
  const glass = new THREE.CylinderGeometry(0.042, 0.042, 0.012, 18);
  glass.rotateX(Math.PI / 2);
  glass.translate(0, 0, -0.225);
  parts.push(colored(glass, 0x0b0d13));
  const stalk = new THREE.CylinderGeometry(0.018, 0.018, 0.12, 10);
  stalk.translate(0, 0.14, 0.03);
  parts.push(colored(stalk, 0x5f646d));
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error("bullet cam geometry merge failed");
  return merged;
}

/** A ceiling dome camera: flush base plate + smoked bottom hemisphere hanging
 *  below it. No aim — domes see 360°. */
function buildDomeCamGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.CylinderGeometry(0.13, 0.13, 0.03, 22);
  base.translate(0, 0.055, 0);
  parts.push(colored(base, 0x9298a2));
  // Bottom hemisphere (theta from equator to south pole) so the dome hangs down.
  const dome = new THREE.SphereGeometry(0.12, 22, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  dome.translate(0, 0.04, 0);
  parts.push(colored(dome, 0x191c24));
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error("dome cam geometry merge failed");
  return merged;
}

/** A low-poly bar stool (~0.53 m): a cushioned seat disc on a thin metal post
 *  over a foot ring. Built ONCE and shared across every stool instance on the
 *  floor (one InstancedMesh, one draw call for potentially thousands). Vertex-
 *  coloured so the seat/post read differently under the shared stool material. */
function buildStoolGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const seat = new THREE.CylinderGeometry(0.17, 0.17, 0.07, 12);
  seat.translate(0, 0.5, 0);
  parts.push(colored(seat, 0x3c2f48)); // cushion (matches fixtures CUSHION)
  const post = new THREE.CylinderGeometry(0.03, 0.04, 0.44, 8);
  post.translate(0, 0.27, 0);
  parts.push(colored(post, 0x3a3d42)); // metal post
  const foot = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 12);
  foot.translate(0, 0.02, 0);
  parts.push(colored(foot, 0x3a3d42)); // foot ring
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error("stool geometry merge failed");
  return merged;
}

/** Neon-valance colour for a unit, by function bucket (id-prefix, matching
 *  src/categories.ts functionBucket), else null (circulation / cage / BOH / core
 *  stay dark — no signage). Bar/sportsbook split to cyan, high-limit/poker/show
 *  to magenta, gaming to amber, food/retail to warm. */
function signageColorFor(id: string, category: Category): number | null {
  if (id.startsWith("bar-") || id.startsWith("sport-")) return NEON_BAR;
  if (id.startsWith("food-")) return NEON_FNB;
  if (id.startsWith("poker-") || id.startsWith("hilimit-") || id.startsWith("showroom-")) return NEON_PREMIUM;
  if (id.startsWith("pit-")) return NEON_GAMING;
  if (category === "retail") return NEON_FNB;
  return null;
}

function poseQuaternion(headingDeg: number, tiltDeg: number, rollDeg: number): THREE.Quaternion {
  const dir = camDir3(headingDeg, tiltDeg);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir, new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  if (rollDeg) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollDeg * DEG));
  return q;
}

function ringToShape(ring: MetreXY[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(ring[0][0], ring[0][1]);
  for (let i = 1; i < ring.length; i++) s.lineTo(ring[i][0], ring[i][1]);
  s.closePath();
  return s;
}
// ShapeGeometry lies in XY; rotateX(-90°) maps (x, y, 0) -> (x, 0, -y), exactly
// the model->three mapping. All flat/extruded geometry goes through these two.
function flatGeo(ring: MetreXY[], h: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(ringToShape(ring));
  g.rotateX(-Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}
function prismGeo(ring: MetreXY[], base: number, top: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(ringToShape(ring), { depth: top - base, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // extrusion +z becomes +y (up)
  g.translate(0, base, 0);
  return g;
}

function centroid(ring: MetreXY[] | null): MetreXY | null {
  if (!ring || ring.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

/** Mean of every fixture's centroid — the "gaming floor" centre, used to spawn
 *  the walker in the action rather than a dead corner. Null when no fixtures. */
function fixturesCentroid(scene: Scene3D): MetreXY | null {
  let x = 0, y = 0, n = 0;
  for (const p of scene.fixturePrisms) {
    const c = centroid(p.ring);
    if (c) { x += c[0]; y += c[1]; n++; }
  }
  return n > 0 ? [x / n, y / n] : null;
}

/** The `at` of the camera nearest a point (so spawn faces a CCTV unit). */
function nearestCameraAt(scene: Scene3D, at: MetreXY): MetreXY | null {
  let best: MetreXY | null = null;
  let bd = Infinity;
  for (const c of scene.cameras) {
    const d = dist2(c.at, at[0], at[1]);
    if (d < bd) { bd = d; best = c.at; }
  }
  return best;
}

// Dispose every geometry/material/light under an object before it's discarded —
// three keeps GPU resources alive until explicitly freed, and the walk view
// rebuilds its whole scene on each floor/edit.
function disposeObject(o: THREE.Object3D): void {
  o.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh> & Partial<THREE.Light>;
    // Skip geometry tagged userData.shared — the cached canonical fixture models
    // (fixtures.ts) are reused across every rebuild and freed only in
    // disposeFixtureModels(). A fixture InstancedMesh still hits the isInstancedMesh
    // branch below, so its per-rebuild instance buffers are always released; only
    // the shared source geometry is spared. All other (per-rebuild) geometry —
    // walls, merged prisms, ceiling panels — is disposed as before.
    if (mesh.geometry && !mesh.geometry.userData?.shared) mesh.geometry.dispose();
    const mat = (child as THREE.Mesh).material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      // Skip materials shared from materials.ts (tagged userData.shared) — they
      // outlive any single rebuild and are freed only in disposeMaterials(). The
      // per-rebuild geometry above is always disposed.
      for (const m of mats) if (!m.userData?.shared) m.dispose();
    }
    // An InstancedMesh (walls, baseboards) owns GPU instance buffers beyond its
    // geometry — free them too.
    if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
    const asLight = child as THREE.Light;
    if (typeof asLight.dispose === "function" && (child as THREE.Light).isLight) asLight.dispose();
  });
}

export class WalkRenderer {
  private readonly container: HTMLElement;
  private readonly opts: WalkRendererOpts;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: PointerLockControls;
  private readonly clock = new THREE.Clock();

  // Rebuild scopes: worldGroup = static shell + house lights (per floor/edit);
  // camBodyGroup = pickable camera bodies (per floor/edit); frustumGroup =
  // selected-camera gizmo (per selection); coverageGroup = spotlight cones (per
  // mode/selection/floor + throttled while moving).
  private readonly worldGroup = new THREE.Group();
  private readonly camBodyGroup = new THREE.Group();
  private readonly frustumGroup = new THREE.Group();
  private readonly coverageGroup = new THREE.Group();

  // Camera model resources, built ONCE and shared across every camera mesh (a
  // large venue has ~1000 cameras — per-camera geometry/materials would be
  // wasteful). Two merged, vertex-coloured geometries (bullet body + lens/hood/
  // stalk; dome base + smoked hemisphere) and two shared materials — the base
  // (faint green emissive so cameras are findable in the dark) and a bright
  // selection material. Selection is a per-mesh material-pointer swap, never a
  // rebuild. Disposed once in dispose(); camBodyGroup children are removed
  // WITHOUT disposal (they only reference these shared resources).
  private readonly bulletCamGeo = buildBulletCamGeo();
  private readonly domeCamGeo = buildDomeCamGeo();
  private readonly camMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.35,
    emissive: new THREE.Color(0x39ff88),
    emissiveIntensity: 0.06,
  });
  private readonly camSelMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0.35,
    emissive: new THREE.Color(0x39ff88),
    emissiveIntensity: 0.85,
  });

  // Emissive recessed-light panels on the ceiling — a look-only "the ceiling is
  // lit" read (the actual light objects arrive in R3). Shared across every panel
  // in the merged mesh; tagged so clearGroup skips it and it's freed only in
  // dispose().
  private readonly panelMat = new THREE.MeshStandardMaterial({
    color: 0x0b0b0d,
    emissive: new THREE.Color(0xffe6c2),
    emissiveIntensity: PANEL_EMISSIVE_I,
    roughness: 1,
    metalness: 0,
  });

  // R3 props: one shared low-poly stool geometry + material, instanced per floor
  // (one InstancedMesh for every stool around every card table). Tagged shared so
  // clearGroup frees only the per-rebuild instance buffers; the geometry/material
  // outlive rebuilds and are freed once in dispose().
  private readonly stoolGeo = buildStoolGeo();
  private readonly stoolMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0.25,
  });

  // R3 camera-primary world-recede state. `focused` is true while a camera is
  // selected; applyWorldDim then scales every recede-able light (base stashed in
  // userData.baseIntensity), deepens the fog, and dims the emissive accents listed
  // in worldEmissive (each with its true base level for exact restore). The
  // coverage spotlights (coverageGroup) and camera-body emissive are NEVER in
  // scope — they stay full so the cone + selected body pop.
  private focused = false;
  private worldEmissive: Array<{ mat: THREE.MeshStandardMaterial; base: number }> = [];

  private readonly raycaster = new THREE.Raycaster();
  private readonly reticle = new THREE.Vector2(0, 0);
  private readonly keys = new Set<string>();

  private sceneData: Scene3D | null = null;
  private selectedId: string | null = null;
  private coverageMode: CoverageMode = "selected";
  private spawnedOrdinal: number | null = null;
  // Structural / camera signatures of the last scene, so setScene rebuilds only
  // the scope that actually changed (see the setScene comment). null ⇒ nothing
  // built yet, so the first scene rebuilds everything.
  private worldSig: string | null = null;
  private cameraSig: string | null = null;
  private lastCoverageAt = 0;
  private readonly lastCoveragePos = new THREE.Vector3();
  // Live coverage spotlights keyed by camera id, so a pose edit that leaves the
  // SET of lit cameras unchanged updates each light IN PLACE rather than
  // disposing + re-creating it — the latter frees and re-allocates a 2048²
  // shadow render target per frame during a routine slider drag (VRAM churn on
  // the GTX 1650 target). Kept in sync with coverageGroup's children.
  private readonly coverageLights = new Map<string, THREE.SpotLight>();
  private raf: number | null = null;

  // R4 quality valve. `quality` selects the render path in tick(): "high" runs the
  // bloom composer, "low" a plain forward render. The pipeline is built once and
  // kept alive across toggles (switching back to High must be instant — no composer
  // rebuild). `manualQuality` latches true the moment the user picks a quality, and
  // permanently disables the auto-fallback so it never fights a manual choice.
  // `autoFellBack` guards the fallback to fire at most once; the frame-time window
  // and warmup counter feed that one-shot decision (see tick()).
  private quality: RenderQuality = "high";
  private pipeline: BloomPipeline | null = null;
  private manualQuality = false;
  private autoFellBack = false;
  private autoWarmup = AUTO_WARMUP_FRAMES;
  private readonly frameSamples: number[] = [];

  constructor(container: HTMLElement, opts: WalkRendererOpts) {
    this.container = container;
    this.opts = opts;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(this.pixelRatioForQuality(this.quality));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // R1 pipeline: ACES tone mapping compresses the warm-downlight + green-cone
    // highlights into a filmic range; sRGB output so the procedural albedo
    // textures (tagged SRGBColorSpace) decode correctly.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.panelMat.userData.shared = true;
    this.stoolGeo.userData.shared = true;
    this.stoolMat.userData.shared = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c10);
    // Slightly thinner than the pre-realism 0.006 so the new procedural surfaces
    // read, while the world still recedes into cool haze behind the cones. The
    // camera-primary world-recede deepens this from the stored BASE_FOG_DENSITY.
    this.scene.fog = new THREE.FogExp2(0x0a0c10, BASE_FOG_DENSITY);
    this.scene.add(this.worldGroup, this.camBodyGroup, this.frustumGroup, this.coverageGroup);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 600);
    this.camera.position.copy(v3(0, 0, EYE_M));

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);

    // R4: bloom composer for the High path. Built once; kept alive across quality
    // toggles. References this.scene + this.camera by identity, so floor rebuilds
    // (which swap the scene's children, not the Scene object) need no re-wiring.
    // Built before resize() so the first resize sizes its render targets too.
    this.pipeline = new BloomPipeline(this.renderer, this.scene, this.camera);

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.addEventListener("click", this.onCanvasClick);

    this.resize();
    this.clock.start();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---- public API ----------------------------------------------------------

  setScene(scene: Scene3D): void {
    this.sceneData = scene;

    // setScene fires on EVERY building edit — including per-tick camera-pose
    // drags (updateCameraLive replaces `building` on each input event). Rebuilding
    // the whole static world (merged prisms, wall InstancedMesh, ceiling, and up
    // to MAX_HOUSE_LIGHTS PointLights) plus the coverage shadow spotlights on
    // every such tick is the editor's heaviest per-interaction cost — and during
    // a pose drag NOTHING structural changed, only a camera moved. So diff the
    // incoming scene into two scopes and touch only what changed: worldGroup
    // (static shell + house lights) on a structural change, and camera bodies +
    // selection gizmo + coverage cones on a camera change. build3dScene is a pure
    // function of the data, so an unchanged floor yields a byte-identical scene
    // and a matching signature.
    const worldSig = worldSignature(scene);
    const cameraSig = cameraSignature(scene);
    const worldChanged = worldSig !== this.worldSig;
    const camerasChanged = cameraSig !== this.cameraSig;
    this.worldSig = worldSig;
    this.cameraSig = cameraSig;

    if (worldChanged) this.rebuildWorld(scene);
    if (camerasChanged) this.rebuildCameraBodies(scene);

    // Spawn only on the FIRST scene or a real floor change — never mid-drag, or
    // respawning would teleport the player during a held pose gesture.
    if (this.spawnedOrdinal !== scene.ordinal) {
      this.spawnedOrdinal = scene.ordinal;
      this.spawn(scene);
    }

    // The selection gizmo and coverage cones follow the camera poses; only a
    // camera change can move or add/remove them. A world-only edit (ceiling,
    // structure, fixture) leaves the persisted gizmo/cones valid — and the
    // spotlights re-cast their shadows onto the new geometry every frame anyway.
    if (camerasChanged) {
      this.applySelection();
      this.recomputeCoverage();
    }
  }

  setSelectedCamera(id: string | null): void {
    this.selectedId = id;
    this.applySelection();
    this.recomputeCoverage(); // selected camera is part of every non-off cone set
  }

  setCoverageMode(mode: CoverageMode): void {
    this.coverageMode = mode;
    this.recomputeCoverage();
  }

  /** Public quality control (the HUD button). A manual choice latches
   *  `manualQuality`, permanently disabling the auto-fallback so it never
   *  overrides the operator. Never disposes the pipeline — toggling back to High
   *  is an instant render-path switch. */
  setQuality(q: RenderQuality): void {
    this.manualQuality = true;
    this.applyQuality(q);
  }

  /** Switch the render path without touching `manualQuality` (so the auto-fallback
   *  can use it). Notifies the HUD when the effective quality actually changes. */
  /** Device pixel ratio per quality. Low renders at 1× (≈4× fewer fragments than
   *  a 2× display) — the single biggest fill-rate lever on the GTX 1650. */
  private pixelRatioForQuality(q: RenderQuality): number {
    return q === "low" ? 1 : Math.min(window.devicePixelRatio, 2);
  }

  /** Coverage shadow-map resolution per quality. Low uses 1024² (≈4× cheaper per
   *  shadow render than 2048²) while KEEPING shadows so coverage stays
   *  occlusion-honest — up to 9 of these render every frame. */
  private shadowMapSizeForQuality(): number {
    return this.quality === "low" ? 1024 : 2048;
  }

  private applyQuality(q: RenderQuality): void {
    if (this.quality === q) return;
    this.quality = q;
    // Low mode must shed the DOMINANT costs, not just bloom: drop pixel ratio
    // (main lever) and shrink the coverage shadow maps. Bloom is additionally
    // skipped by the tick() render-path branch. High restores full fidelity.
    const pr = this.pixelRatioForQuality(q);
    this.renderer.setPixelRatio(pr);
    this.pipeline?.setPixelRatio(pr);
    this.resize(); // re-apply the drawing-buffer size at the new ratio (renderer + composer)
    this.recomputeCoverage(); // rebuild coverage spotlights at the new shadow-map size
    this.opts.onQualityChange?.(q);
  }

  /** Camera id under the screen-centre reticle, or null. */
  pickCenter(): string | null {
    this.raycaster.setFromCamera(this.reticle, this.camera);
    const hits = this.raycaster.intersectObjects(this.camBodyGroup.children, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const id = o.userData.cameraId;
        if (typeof id === "string") return id;
        o = o.parent;
      }
    }
    return null;
  }

  /** Request pointer lock (the WalkView "click to walk" overlay calls this). */
  lock(): void {
    this.controls.lock();
  }

  /** Release pointer lock — WalkView calls this the instant a camera is picked
   *  so the OS cursor is freed to reach the pose panel (a pointer-locked cursor
   *  is pinned to screen centre and can't click the HUD). */
  unlock(): void {
    this.controls.unlock();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep the bloom composer's render targets matched to the canvas.
    this.pipeline?.setSize(w, h);
  }

  dispose(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.removeEventListener("click", this.onCanvasClick);
    if (this.controls.isLocked) this.controls.unlock();
    this.controls.dispose();
    this.clearGroup(this.worldGroup);
    this.clearCameraBodies(); // shared geo/mat — don't dispose per body
    this.clearGroup(this.frustumGroup);
    this.clearGroup(this.coverageGroup);
    this.coverageLights.clear();
    // Dispose the shared camera-model resources exactly once.
    this.bulletCamGeo.dispose();
    this.domeCamGeo.dispose();
    this.camMat.dispose();
    this.camSelMat.dispose();
    // Free the shared procedural materials/textures + the emissive panel material
    // exactly once. clearGroup skips shared materials by design (they survive
    // every rebuild), so this is the only place they're released.
    this.panelMat.dispose();
    // R3 shared prop resources (stool geometry + material) — freed once here; the
    // per-rebuild stool InstancedMesh buffers were released by clearGroup.
    this.stoolGeo.dispose();
    this.stoolMat.dispose();
    disposeMaterials();
    // Free the cached canonical fixture geometries + their shared body/emissive
    // materials exactly once (clearGroup skips these userData.shared resources).
    disposeFixtureModels();
    // R4: free the bloom composer + all its passes/render targets before the
    // renderer (UnrealBloomPass owns a mip chain of targets that would otherwise
    // leak on every walk-mode teardown).
    this.pipeline?.dispose();
    this.pipeline = null;
    this.renderer.dispose();
    // dispose() frees three's internal caches but does NOT release the GL
    // context — that's forceContextLoss()'s job. Without it, every walk-mode
    // toggle constructs a fresh WebGLRenderer+canvas whose context lingers
    // until GC, so ~16 toggles hit Chrome's live-context cap and the browser
    // drops the OLDEST context — the still-mounted MapLibre map's — blanking
    // the map behind the overlay with no recovery.
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ---- scene build ---------------------------------------------------------

  private rebuildWorld(scene: Scene3D): void {
    this.clearGroup(this.worldGroup);
    const g = this.worldGroup;
    // Recede-able emissive accents are re-collected each rebuild (the shared
    // materials persist; the meshes don't). applyWorldDim at the end applies the
    // current focus state to the freshly built lights/emissive/fog.
    this.worldEmissive = [];

    // Troweled-concrete ground under everything. PlaneGeometry UVs are 0..1;
    // rescale them to metres so the shared concrete texture tiles at real-world
    // scale like the metre-UV floor/prism geometry.
    const groundGeo = new THREE.PlaneGeometry(2400, 2400);
    const guv = groundGeo.attributes.uv;
    for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) * 2400, guv.getY(i) * 2400);
    guv.needsUpdate = true;
    const ground = new THREE.Mesh(groundGeo, getMaterial("concrete"));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    ground.receiveShadow = true;
    g.add(ground);

    // Footprint slab (concrete beneath the unit floors).
    if (scene.footprintRing) {
      const slab = new THREE.Mesh(flatGeo(scene.footprintRing, 0), getMaterial("concrete"));
      slab.receiveShadow = true;
      g.add(slab);
    }

    // Per-unit floor patches — the main floor read. Materialed by category, plus
    // the unit id-prefix bucket so the casino's category-"room" spaces still split
    // into gaming-carpet / F&B-wood / BOH-concrete.
    for (const patch of scene.floorPatches) {
      if (patch.ring.length < 3) continue;
      const mesh = new THREE.Mesh(flatGeo(patch.ring, 0.02), materialForCategory(patch.category, patch.id));
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    // Walls (wall paint) + baseboard trim, both instanced.
    this.addWalls(scene, g);

    // Extruded prisms, merged per kind, each drawn with a shared material:
    //  · circulation/lobby low slabs → the category's stone/carpet floor material
    //  · structural columns/obstacles → concrete
    this.addPrismGroup(scene.slabPrisms, (k) => materialForCategory(k as Category), g);
    this.addPrismGroup(scene.structurePrisms, () => getMaterial("concrete"), g);

    // Fixtures — R2: detailed parametric models, instanced per kind (one or two
    // draw calls per kind), replacing the old brushed-metal box prisms.
    this.addFixtures(scene, g);

    // R3 props: stools ringed around the card tables (one InstancedMesh total).
    this.addStools(scene, g);

    // Ceiling — acoustic tile (DoubleSide baked into the material). castShadow OFF
    // so coverage lights aren't killed by the plane they hang from (spike-proven).
    if (scene.footprintRing) {
      const ceil = new THREE.Mesh(flatGeo(scene.footprintRing, scene.ceilingM + 0.02), getMaterial("ceilingTile"));
      ceil.castShadow = false;
      g.add(ceil);
      this.addCeilingPanels(scene, g);
    }

    this.addHouseLights(scene, g);
    // R3 atmosphere: pit pendants (bounded warm PointLights) + neon signage
    // valances (emissive geometry, no light objects).
    this.addPitLights(scene, g);
    this.addSignage(scene, g);

    // Apply the current camera-primary recede state to the freshly built lights,
    // emissive accents and fog (persists across a world-only edit while focused).
    this.applyWorldDim();
  }

  /** Sparse grid of small emissive quads on the ceiling so it reads as lit — no
   *  light objects (that's R3), just bright geometry. Merged into one mesh under
   *  the shared emissive panel material; capped at MAX_CEILING_PANELS. */
  private addCeilingPanels(scene: Scene3D, group: THREE.Group): void {
    const ring = scene.footprintRing;
    if (!ring) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const step = Math.max(CEILING_PANEL_STEP_M, Math.sqrt((spanX * spanY) / MAX_CEILING_PANELS));
    const hy = scene.ceilingM - 0.03;
    const quads: THREE.BufferGeometry[] = [];
    for (let x = minX + step / 2; x <= maxX && quads.length < MAX_CEILING_PANELS; x += step) {
      for (let y = minY + step / 2; y <= maxY && quads.length < MAX_CEILING_PANELS; y += step) {
        if (!pointInRing([x, y], ring)) continue;
        const q = new THREE.PlaneGeometry(0.7, 1.3);
        q.rotateX(Math.PI / 2); // face down (−Y)
        q.translate(x, hy, -y); // model (x,y) → three (x, ·, −y)
        quads.push(q);
      }
    }
    if (quads.length === 0) return;
    const merged = mergeGeometries(quads, false);
    quads.forEach((q) => q.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, this.panelMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    // Recede-able: the ceiling glow dims with the world when a camera is focused.
    this.worldEmissive.push({ mat: this.panelMat, base: PANEL_EMISSIVE_I });
  }

  private addWalls(scene: Scene3D, group: THREE.Group): void {
    const segs = scene.wallSegs;
    if (segs.length === 0) return;
    // Wall boxes (unit box scaled to len × height × thickness) and a matching
    // baseboard box (short, slightly proud of the wall face) share one per-segment
    // transform — one InstancedMesh each, both with shared materials.
    const wallProto = new THREE.BoxGeometry(1, 1, WALL_THICKNESS_M);
    const baseProto = new THREE.BoxGeometry(1, 1, WALL_THICKNESS_M * 1.15);
    const walls = new THREE.InstancedMesh(wallProto, getMaterial("wallPaint"), segs.length);
    const bases = new THREE.InstancedMesh(baseProto, getMaterial("woodPanel"), segs.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (const s of segs) {
      const dx = s.b[0] - s.a[0];
      const dy = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const top = s.topM;
      const cx = (s.a[0] + s.b[0]) / 2;
      const cy = (s.a[1] + s.b[1]) / 2;
      // model heading atan2(dy,dx); in three (-y) space the yaw about +Y matches.
      q.setFromAxisAngle(up, Math.atan2(dy, dx));
      m.compose(v3(cx, cy, top / 2), q, new THREE.Vector3(len, top, 1));
      walls.setMatrixAt(n, m);
      m.compose(v3(cx, cy, BASEBOARD_H / 2), q, new THREE.Vector3(len, BASEBOARD_H, 1));
      bases.setMatrixAt(n, m);
      n++;
    }
    walls.count = n;
    bases.count = n;
    walls.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    walls.castShadow = true;
    walls.receiveShadow = true;
    bases.castShadow = true;
    bases.receiveShadow = true;
    group.add(walls, bases);
  }

  private addPrismGroup(
    prisms: ScenePrism[],
    matFor: (kind: string) => THREE.MeshStandardMaterial,
    group: THREE.Group,
  ): void {
    const byKind = new Map<string, THREE.BufferGeometry[]>();
    for (const p of prisms) {
      if (p.topM <= p.baseM || p.ring.length < 3) continue;
      const arr = byKind.get(p.kind) ?? [];
      arr.push(prismGeo(p.ring, p.baseM, p.topM));
      byKind.set(p.kind, arr);
    }
    for (const [kind, geos] of byKind) {
      const merged = mergeGeometries(geos);
      geos.forEach((geo) => geo.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, matFor(kind));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  /** Fixtures as detailed instanced models (R2). Group the fixture prisms by
   *  kind; for each kind build ONE InstancedMesh of the cached canonical body
   *  geometry (fixtures.ts) — plus a SECOND InstancedMesh for the emissive part
   *  when the kind has one (slot screens, bar bottles, stage lamps). Per instance:
   *  position = footprint centroid at floor y (baseM); yaw = footprint principal
   *  axis; scale = fit the canonical to the real footprint. So a floor of 300
   *  slots is 2 draw calls, not 300 meshes, and no geometry is built per rebuild —
   *  only fresh instance matrices. The canonical geometries are userData.shared,
   *  so clearGroup frees each InstancedMesh's instance buffers but never the
   *  shared source geometry (that's disposeFixtureModels() in dispose()). */
  private addFixtures(scene: Scene3D, group: THREE.Group): void {
    const byKind = new Map<FixtureKind, ScenePrism[]>();
    for (const p of scene.fixturePrisms) {
      if (p.ring.length < 3) continue;
      const kind = p.kind as FixtureKind;
      const arr = byKind.get(kind);
      if (arr) arr.push(p);
      else byKind.set(kind, [p]);
    }
    if (byKind.size === 0) return;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (const [kind, prisms] of byKind) {
      const model = getFixtureModel(kind);
      const body = new THREE.InstancedMesh(model.geometry, model.material, prisms.length);
      const emissive =
        model.emissiveGeometry && model.emissiveMaterial
          ? new THREE.InstancedMesh(model.emissiveGeometry, model.emissiveMaterial, prisms.length)
          : null;
      let n = 0;
      for (const p of prisms) {
        const frame = footprintFrame(p.ring);
        if (!frame) continue;
        // Clamp the footprint extents so a degenerate/huge polygon can't produce a
        // sub-centimetre or building-sized model.
        const len = clampSpan(frame.lengthM);
        const wid = clampSpan(frame.widthM);
        // "length" fit scales uniformly (preserve aspect, height follows footprint);
        // "bbox" fit stretches the footprint independently and keeps the authored
        // real-metre height (Y scale 1).
        if (model.fit === "length") scl.set(len, len, len);
        else scl.set(len, 1, wid);
        // model[x,y] -> three(x, h, -y); base sits at the fixture's floor (baseM).
        pos.set(frame.centroid[0], p.baseM, -frame.centroid[1]);
        q.setFromAxisAngle(up, frame.angleRad);
        m.compose(pos, q, scl);
        body.setMatrixAt(n, m);
        if (emissive) emissive.setMatrixAt(n, m);
        n++;
      }
      if (n === 0) {
        // No placeable instances — release the InstancedMesh buffers we allocated.
        body.dispose();
        emissive?.dispose();
        continue;
      }
      body.count = n;
      body.instanceMatrix.needsUpdate = true;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      if (emissive) {
        emissive.count = n;
        emissive.instanceMatrix.needsUpdate = true;
        // Self-lit accents: never receive shadows, and don't cast either — a glowing
        // screen occluding a coverage cone would be wrong, and it saves shadow-pass
        // cost (the spec excepts receiveShadow; dropping castShadow is the same intent).
        emissive.castShadow = false;
        emissive.receiveShadow = false;
        group.add(emissive);
      }
    }
  }

  private addHouseLights(scene: Scene3D, group: THREE.Group): void {
    // Rebalanced for ACES tone mapping (which darkens/desaturates the raw image):
    // raised so the space isn't muddy, but kept cool + dim so the green coverage
    // cones and camera bodies stay the brightest, most saturated things in frame.
    // Every recede-able light stamps its full intensity in userData.baseIntensity
    // so applyWorldDim can scale it and restore it exactly (camera-primary focus).
    const ambient = new THREE.AmbientLight(0x8090b0, 1.15);
    ambient.userData.baseIntensity = 1.15;
    const hemi = new THREE.HemisphereLight(0x46506e, 0x14161a, 1.5);
    hemi.userData.baseIntensity = 1.5;
    group.add(ambient, hemi);
    // Soft overhead "house lighting" fill — a straight-down DirectionalLight has
    // no distance falloff, so it lights every floor evenly and makes the floor
    // materials actually read (the warm PointLights below sit just under the
    // ceiling and only pool light directly beneath each). No shadow: the shadow
    // budget belongs to the coverage cones. Kept cool + moderate so cameras/cones
    // stay the brightest, most saturated things in frame (camera-primary).
    const fill = new THREE.DirectionalLight(0xbcc6e0, 1.15);
    fill.userData.baseIntensity = 1.15;
    fill.position.set(0, 10, 0);
    fill.target.position.set(0, 0, 0);
    group.add(fill, fill.target);

    const ring = scene.footprintRing;
    const pts = ring ?? scene.floorPatches.flatMap((p) => p.ring);
    if (pts.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    // Sit the warm downlights lower than flush-to-ceiling so they wash the FLOOR,
    // not just blast the ceiling tile 0.3 m above them.
    const h = Math.min(scene.ceilingM - 0.3, scene.ceilingM * 0.7);
    // Widen the grid step on large floors so the bounded light budget spreads
    // evenly across the whole footprint instead of clustering in the min-corner
    // (a plain cap fills row-major and bottom-left-biases). sqrt(area/budget)
    // yields ≈budget cells; the HOUSE_LIGHT_STEP_M floor keeps small rooms from
    // over-lighting. Range-55 lights overlap generously at these spacings.
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const step = Math.max(HOUSE_LIGHT_STEP_M, Math.sqrt((spanX * spanY) / MAX_HOUSE_LIGHTS));
    let placed = 0;
    for (let x = minX + step / 2; x <= maxX && placed < MAX_HOUSE_LIGHTS; x += step) {
      for (let y = minY + step / 2; y <= maxY && placed < MAX_HOUSE_LIGHTS; y += step) {
        if (ring && !pointInRing([x, y], ring)) continue;
        const p = new THREE.PointLight(0xffd9a0, 55, 60, 1.25);
        p.userData.baseIntensity = 55;
        p.position.copy(v3(x, y, h));
        group.add(p);
        placed++;
      }
    }
  }

  /** Pit pendants: cluster the gaming-table fixtures into pit regions (grid-bucket
   *  their centroids at PIT_GRID_M) and drop ONE warm, shadow-free PointLight over
   *  each of the densest MAX_PIT_LIGHTS pits at PIT_LIGHT_H, so the tables pool in
   *  light as the room's focus. Bounded + shadow-free — merged into the forward
   *  light budget (see MAX_HOUSE_LIGHTS). No-op on floors with no tables. */
  private addPitLights(scene: Scene3D, group: THREE.Group): void {
    const buckets = new Map<string, { x: number; y: number; n: number }>();
    for (const p of scene.fixturePrisms) {
      if (!PIT_TABLE_KINDS.has(p.kind as FixtureKind)) continue;
      const c = centroid(p.ring);
      if (!c) continue;
      const key = `${Math.floor(c[0] / PIT_GRID_M)}:${Math.floor(c[1] / PIT_GRID_M)}`;
      const b = buckets.get(key);
      if (b) {
        b.x += c[0];
        b.y += c[1];
        b.n++;
      } else {
        buckets.set(key, { x: c[0], y: c[1], n: 1 });
      }
    }
    if (buckets.size === 0) return;
    // Densest pits first, so a floor with more clusters than the cap lights the
    // busiest tables rather than whichever bucket hashed first.
    const pits = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, MAX_PIT_LIGHTS);
    const h = Math.min(PIT_LIGHT_H, scene.ceilingM - 0.2);
    for (const pit of pits) {
      const light = new THREE.PointLight(PIT_LIGHT_COLOR, PIT_LIGHT_INTENSITY, PIT_LIGHT_RANGE, PIT_LIGHT_DECAY);
      light.userData.baseIntensity = PIT_LIGHT_INTENSITY;
      light.position.copy(v3(pit.x / pit.n, pit.y / pit.n, h));
      group.add(light);
    }
  }

  /** Neon signage: a thin emissive valance along the top of every functional
   *  room's walls, coloured by function bucket (signageColorFor). Strips are
   *  merged per colour into ONE mesh each (a handful of draw calls) under the
   *  shared emissive materials, and registered as recede-able so they dim on
   *  camera focus. Cheap geometry, NO extra light objects. */
  private addSignage(scene: Scene3D, group: THREE.Group): void {
    const h = scene.ceilingM - SIGNAGE_H_BELOW_CEIL;
    if (h <= 0) return;
    const byColor = new Map<number, THREE.BufferGeometry[]>();
    for (const patch of scene.floorPatches) {
      const ring = patch.ring;
      if (ring.length < 3) continue;
      const color = signageColorFor(patch.id, patch.category);
      if (color == null) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 0.1) continue;
        // Left normal (interior for a CCW ring) pulls the strip inside the wall so
        // a shared edge doesn't co-plane two rooms' valances.
        const nx = -dy / len;
        const ny = dx / len;
        const cx = (a[0] + b[0]) / 2 + nx * SIGNAGE_INSET_M;
        const cy = (a[1] + b[1]) / 2 + ny * SIGNAGE_INSET_M;
        const gm = new THREE.BoxGeometry(len, SIGNAGE_VAL_H, SIGNAGE_VAL_D);
        gm.rotateY(Math.atan2(dy, dx)); // align +X to the edge (wall yaw convention)
        gm.translate(cx, h, -cy); // model (x,y) → three (x, ·, −y)
        const arr = byColor.get(color);
        if (arr) arr.push(gm);
        else byColor.set(color, [gm]);
      }
    }
    for (const [color, geos] of byColor) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((gm) => gm.dispose());
      if (!merged) continue;
      const mat = getEmissiveMaterial(color, SIGNAGE_EMISSIVE_I);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      this.worldEmissive.push({ mat, base: SIGNAGE_EMISSIVE_I });
    }
  }

  /** Props: a ring of low-poly stools around every card table, all in ONE
   *  InstancedMesh (one draw call for the whole floor's stools). Placement is
   *  derived from each table's footprintFrame — an ellipse just outside the
   *  footprint (STOOL_GAP), STOOLS_PER_TABLE evenly around it. The stool geometry
   *  is radially symmetric, so instances need position only (no yaw). */
  private addStools(scene: Scene3D, group: THREE.Group): void {
    interface Ring {
      cx: number;
      cy: number;
      ca: number;
      sa: number;
      rx: number;
      ry: number;
      base: number;
    }
    const rings: Ring[] = [];
    for (const p of scene.fixturePrisms) {
      if (!STOOL_TABLE_KINDS.has(p.kind as FixtureKind)) continue;
      if (p.ring.length < 3) continue;
      const frame = footprintFrame(p.ring);
      if (!frame) continue;
      rings.push({
        cx: frame.centroid[0],
        cy: frame.centroid[1],
        ca: Math.cos(frame.angleRad),
        sa: Math.sin(frame.angleRad),
        rx: clampSpan(frame.lengthM) / 2 + STOOL_GAP,
        ry: clampSpan(frame.widthM) / 2 + STOOL_GAP,
        base: p.baseM,
      });
    }
    const total = rings.length * STOOLS_PER_TABLE;
    if (total === 0) return;
    const stools = new THREE.InstancedMesh(this.stoolGeo, this.stoolMat, total);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let idx = 0;
    for (const r of rings) {
      for (let i = 0; i < STOOLS_PER_TABLE; i++) {
        const th = (i / STOOLS_PER_TABLE) * Math.PI * 2;
        const ox = Math.cos(th) * r.rx;
        const oy = Math.sin(th) * r.ry;
        // Rotate the local ellipse offset into model space by the table's yaw.
        const mx = r.cx + ox * r.ca - oy * r.sa;
        const my = r.cy + ox * r.sa + oy * r.ca;
        pos.set(mx, r.base, -my);
        m.compose(pos, q, one);
        stools.setMatrixAt(idx++, m);
      }
    }
    stools.instanceMatrix.needsUpdate = true;
    stools.castShadow = true;
    stools.receiveShadow = true;
    group.add(stools);
  }

  /** Camera-primary world-recede. Scales every recede-able light to its stored
   *  base × the focus factor, deepens the fog, and dims the signage/ceiling
   *  emissive — or restores all three exactly when unfocused. Cheap: property
   *  writes only, no rebuild, no allocation. The coverage spotlights and camera-
   *  body emissive are out of scope and stay full. */
  private applyWorldDim(): void {
    const lf = this.focused ? FOCUS_LIGHT_SCALE : 1;
    // Every stamped light is a DIRECT child of worldGroup, so a shallow walk
    // suffices (this runs per-tick during a pose drag — no deep traverse).
    for (const o of this.worldGroup.children) {
      const base = o.userData.baseIntensity;
      if (typeof base === "number" && (o as THREE.Light).isLight) {
        (o as THREE.Light).intensity = base * lf;
      }
    }
    const ef = this.focused ? FOCUS_EMISSIVE_SCALE : 1;
    for (const e of this.worldEmissive) e.mat.emissiveIntensity = e.base * ef;
    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.density = BASE_FOG_DENSITY * (this.focused ? FOCUS_FOG_SCALE : 1);
    }
  }

  /** Toggle the world-recede on (a camera is selected) or off, then apply it. */
  private setFocus(on: boolean): void {
    this.focused = on;
    this.applyWorldDim();
  }

  private rebuildCameraBodies(scene: Scene3D): void {
    this.clearCameraBodies();
    for (const pose of scene.cameras) {
      const isDome = pose.kind === "dome";
      const body = new THREE.Mesh(isDome ? this.domeCamGeo : this.bulletCamGeo, this.camMat);
      body.position.copy(v3(pose.at[0], pose.at[1], pose.mountM));
      // Dome bodies mount flush and see 360°, so they take no aim rotation; a
      // fixed/ptz body aims its lens (local −Z) down the pose direction.
      if (!isDome) {
        body.quaternion.copy(poseQuaternion(pose.headingDeg, pose.tiltDeg, pose.rollDeg));
      }
      body.userData.cameraId = pose.id;
      this.camBodyGroup.add(body);
    }
  }

  /** Remove camera bodies WITHOUT disposing — they reference the shared camera
   *  geometry/material, which outlive any single rebuild (disposed in dispose). */
  private clearCameraBodies(): void {
    for (let i = this.camBodyGroup.children.length - 1; i >= 0; i--) {
      this.camBodyGroup.remove(this.camBodyGroup.children[i]);
    }
  }

  private spawn(scene: Scene3D): void {
    // Spawn in the ACTION, not a dead corner: the mean of the fixture centroids
    // (the gaming floor) so the operator lands among tables/slots and the
    // realism is visible on entry — falling back to the footprint centre, then
    // the first camera. Then face the nearest camera (camera-primary: a CCTV
    // unit is in view on arrival).
    let at: MetreXY | null = fixturesCentroid(scene);
    if (!at) at = centroid(scene.footprintRing);
    if (!at) at = scene.cameras[0] ? [scene.cameras[0].at[0] - 6, scene.cameras[0].at[1] - 6] : [0, 0];

    const sel = this.selectedId ? scene.cameras.find((c) => c.id === this.selectedId) : undefined;
    let faceAt: MetreXY | null = sel ? sel.at : nearestCameraAt(scene, at);

    this.camera.position.copy(v3(at[0], at[1], EYE_M));
    if (faceAt && (faceAt[0] !== at[0] || faceAt[1] !== at[1])) {
      this.camera.lookAt(v3(faceAt[0], faceAt[1], EYE_M));
    }
    this.camera.position.y = EYE_M;
  }

  // ---- selection gizmo -----------------------------------------------------

  private applySelection(): void {
    this.clearGroup(this.frustumGroup);
    // Camera-primary: a selected camera makes the rest of the world recede (dim
    // lights, deepen fog, dim signage) so the lit cone + emphasized body dominate.
    this.setFocus(this.selectedId != null);
    // Emphasise the selected camera body by swapping its shared material pointer
    // to the bright selection material (mutating emissiveIntensity would hit the
    // ONE shared base material and light every camera). Cheap: a pointer swap
    // per body, no geometry churn.
    for (const child of this.camBodyGroup.children) {
      (child as THREE.Mesh).material =
        child.userData.cameraId === this.selectedId ? this.camSelMat : this.camMat;
    }
    if (!this.sceneData || !this.selectedId) return;
    const pose = this.sceneData.cameras.find((c) => c.id === this.selectedId);
    if (!pose) return; // selected camera is on another floor — no gizmo here
    const pos = v3(pose.at[0], pose.at[1], pose.mountM);
    if (pose.kind === "dome") {
      // Wireframe bottom-hemisphere gizmo (OQ-5) instead of a frustum pyramid.
      const geo = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      const gizmo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x39ff88, wireframe: true }));
      gizmo.position.copy(pos);
      this.frustumGroup.add(gizmo);
    } else {
      const pc = new THREE.PerspectiveCamera(pose.vfovDeg, 16 / 9, 0.1, pose.rangeM);
      pc.position.copy(pos);
      pc.quaternion.copy(poseQuaternion(pose.headingDeg, pose.tiltDeg, pose.rollDeg));
      pc.updateMatrixWorld(true);
      this.frustumGroup.add(new THREE.CameraHelper(pc));
    }
  }

  // ---- coverage cones ------------------------------------------------------

  /** The cameras that should currently be lit, ≤ MAX_SHADOW_LIGHTS. */
  private chooseCoverageCameras(): SceneCameraPose[] {
    if (this.coverageMode === "off" || !this.sceneData) return [];
    const poses = this.sceneData.cameras;
    const selected = this.selectedId ? poses.find((p) => p.id === this.selectedId) ?? null : null;
    if (this.coverageMode === "selected") return selected ? [selected] : [];
    // nearby: selected + up to 8 cameras nearest the player, deduped, ≤ 9.
    const px = this.camera.position.x;
    const py = -this.camera.position.z;
    const nearest = [...poses]
      .sort((a, b) => dist2(a.at, px, py) - dist2(b.at, px, py))
      .slice(0, 8);
    const set = new Map<string, SceneCameraPose>();
    if (selected) set.set(selected.id, selected);
    for (const p of nearest) {
      if (set.size >= MAX_SHADOW_LIGHTS) break;
      set.set(p.id, p);
    }
    return [...set.values()].slice(0, MAX_SHADOW_LIGHTS);
  }

  private recomputeCoverage(): void {
    this.lastCoverageAt = performance.now();
    this.lastCoveragePos.copy(this.camera.position);

    const chosen = this.chooseCoverageCameras();
    const chosenIds = new Set(chosen.map((p) => p.id));
    // Same lit-camera SET as last time (the pose-drag case: one camera moved but
    // the set is identical): re-aim each existing spotlight in place, keeping its
    // shadow render target. Disposing + re-creating would realloc a 2048² target
    // per frame during the drag. A set change (mode/floor/nearby drift) still
    // does a full teardown so removed lights free their targets.
    const sameSet =
      chosenIds.size === this.coverageLights.size &&
      [...chosenIds].every((id) => this.coverageLights.has(id));
    if (sameSet) {
      for (const pose of chosen) this.updateCoverageLight(this.coverageLights.get(pose.id)!, pose);
      return;
    }
    this.clearGroup(this.coverageGroup);
    this.coverageLights.clear();
    for (const pose of chosen) this.addCoverageLight(pose);
  }

  private addCoverageLight(pose: SceneCameraPose): void {
    const spot = new THREE.SpotLight(0x39ff88, 30, pose.rangeM, 0.5, 0.3, 0);
    spot.castShadow = true;
    const sm = this.shadowMapSizeForQuality();
    spot.shadow.mapSize.set(sm, sm);
    spot.shadow.camera.near = 0.2;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.03;
    this.updateCoverageLight(spot, pose);
    this.coverageGroup.add(spot, spot.target);
    this.coverageLights.set(pose.id, spot);
  }

  /** Re-aim/re-scale an existing spotlight to a pose without recreating it (so
   *  its shadow render target survives). Covers everything a pose edit can move:
   *  position, cone angle, range, and aim. */
  private updateCoverageLight(spot: THREE.SpotLight, pose: SceneCameraPose): void {
    const pos = v3(pose.at[0], pose.at[1], pose.mountM);
    const isDome = pose.kind === "dome";
    spot.position.copy(pos);
    spot.angle = isDome ? 1.2 : Math.min((pose.fovDeg / 2) * DEG, 1.05);
    spot.distance = pose.rangeM;
    spot.shadow.camera.far = pose.rangeM + 2;
    // Untilted cams still paint the floor: aim 15° down when tilt is 0.
    const effTilt = isDome ? 90 : pose.tiltDeg > 0 ? pose.tiltDeg : 15;
    const dir = camDir3(pose.headingDeg, effTilt).multiplyScalar(Math.min(pose.rangeM, 10));
    spot.target.position.copy(pos.clone().add(dir));
  }

  // ---- loop + input --------------------------------------------------------

  private readonly tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.controls.isLocked) {
      const sp = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      const f = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const r = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      if (f) this.controls.moveForward(f * sp * dt);
      if (r) this.controls.moveRight(r * sp * dt);
      this.camera.position.y = EYE_M; // stay at eye height regardless of look pitch

      // Throttled nearby recompute: never per-frame — only after ≥ 2 s AND a
      // real move (> 1 m) since the last coverage rebuild.
      if (this.coverageMode === "nearby") {
        const now = performance.now();
        if (now - this.lastCoverageAt > 2000 && this.camera.position.distanceTo(this.lastCoveragePos) > 1) {
          this.recomputeCoverage();
        }
      }

      this.sampleAutoQuality(dt);
    }

    if (this.quality === "high" && this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  };

  /** One-shot auto quality fallback. While locked at High (real in-scene load),
   *  collect frame times past a warmup window; once the sample window fills,
   *  compare the median to the budget and drop to Low a SINGLE time if the GPU
   *  can't hold it. Never fires after a manual choice, never upgrades, never fires
   *  twice. `dt` is the clamped per-frame delta in seconds. */
  private sampleAutoQuality(dt: number): void {
    if (this.autoFellBack || this.manualQuality || this.quality !== "high") return;
    if (this.autoWarmup > 0) {
      this.autoWarmup--;
      return;
    }
    this.frameSamples.push(dt * 1000);
    if (this.frameSamples.length < AUTO_SAMPLE_FRAMES) return;
    const sorted = [...this.frameSamples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameSamples.length = 0;
    if (median > AUTO_FRAME_MS_BUDGET) {
      this.autoFellBack = true;
      this.applyQuality("low");
      // eslint-disable-next-line no-console
      console.info(
        `[walk] auto quality fallback: median ${median.toFixed(1)}ms > ${AUTO_FRAME_MS_BUDGET}ms at High → Low`,
      );
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private readonly onCanvasClick = (): void => {
    if (!this.controls.isLocked) return; // unlocked clicks go to the HUD/overlay
    this.opts.onPickCamera(this.pickCenter());
  };

  private clearGroup(g: THREE.Group): void {
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      disposeObject(c);
      g.remove(c);
    }
  }
}

function dist2(at: MetreXY, x: number, y: number): number {
  const dx = at[0] - x;
  const dy = at[1] - y;
  return dx * dx + dy * dy;
}

// ---- fixture footprint frame -----------------------------------------------
// A fixture is placed by scaling+rotating a canonical model (fixtures.ts) onto
// its polygon. footprintFrame derives that placement PURELY from the ring (the
// Scene3D contract carries no orientation field — the renderer synthesises it),
// returning the area centroid, the principal-axis yaw, and the oriented extents.

const FIXTURE_MIN_SPAN_M = 0.3; // clamp tiny/degenerate footprints
const FIXTURE_MAX_SPAN_M = 40; // clamp runaway footprints (bad polygons)

const clampSpan = (v: number): number =>
  v < FIXTURE_MIN_SPAN_M ? FIXTURE_MIN_SPAN_M : v > FIXTURE_MAX_SPAN_M ? FIXTURE_MAX_SPAN_M : v;

interface FootprintFrame {
  centroid: MetreXY;
  /** Yaw about +Y aligning the model's local +X to the footprint's LONG axis.
   *  Measured atan2-style in model space, matching the wall convention so the
   *  model→three (x, ·, −y) mapping lands the length along the real long axis. */
  angleRad: number;
  lengthM: number; // extent along the long axis (≥ widthM)
  widthM: number; // extent perpendicular
}

/** Area (signed-shoelace) centroid of an open ring; falls back to the vertex mean
 *  for a ~zero-area (collinear) ring. */
function polygonCentroid(ring: MetreXY[]): MetreXY {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let mx = 0;
    let my = 0;
    for (const [x, y] of ring) {
      mx += x;
      my += y;
    }
    return [mx / n, my / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Convex hull (Andrew's monotone chain), CCW, no repeated endpoint. */
function convexHull(pts: MetreXY[]): MetreXY[] {
  const p = [...pts].sort((u, v) => (u[0] === v[0] ? u[1] - v[1] : u[0] - v[0]));
  if (p.length < 3) return p;
  const cross = (o: MetreXY, a: MetreXY, b: MetreXY): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: MetreXY[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: MetreXY[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Derive a fixture's placement frame from its polygon ring. The orientation +
 *  extents come from the MINIMUM-AREA bounding rectangle (rotating calipers over
 *  the convex hull): for a rectangular fixture that rectangle IS the fixture, so
 *  a table/slot/bar snaps exactly to its outline; irregular rings get the tightest
 *  oriented box. Runs once per fixture per rebuild (never per frame). */
function footprintFrame(ring: MetreXY[]): FootprintFrame | null {
  if (ring.length < 3) return null;
  const centroid = polygonCentroid(ring);
  const hull = convexHull(ring);
  if (hull.length < 3) {
    // Collinear/degenerate: axis along the extent, a thin default width.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const dx = maxX - minX;
    const dy = maxY - minY;
    return {
      centroid,
      angleRad: Math.atan2(dy, dx),
      lengthM: Math.max(Math.hypot(dx, dy), FIXTURE_MIN_SPAN_M),
      widthM: FIXTURE_MIN_SPAN_M,
    };
  }
  let bestArea = Infinity;
  let bestAngle = 0;
  let bestLen = 0;
  let bestWid = 0;
  const h = hull.length;
  for (let i = 0; i < h; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % h];
    const ex = bx - ax;
    const ey = by - ay;
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-9) continue;
    const ux = ex / elen;
    const uy = ey / elen;
    // Project every hull point onto the edge axis (u) and its perpendicular.
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [px, py] of hull) {
      const pu = px * ux + py * uy;
      const pv = -px * uy + py * ux;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const wU = maxU - minU;
    const wV = maxV - minV;
    const area = wU * wV;
    if (area < bestArea) {
      bestArea = area;
      bestAngle = Math.atan2(uy, ux); // long axis resolved below
      bestLen = wU;
      bestWid = wV;
    }
  }
  // Ensure lengthM is the LONGER side; if the edge axis was the short one, swap
  // the extents and rotate the yaw 90° so +X still lands along the long axis.
  let angle = bestAngle;
  let lengthM = bestLen;
  let widthM = bestWid;
  if (widthM > lengthM) {
    [lengthM, widthM] = [widthM, lengthM];
    angle += Math.PI / 2;
  }
  return { centroid, angleRad: angle, lengthM, widthM };
}

// ---- change detection ------------------------------------------------------
// Compact signatures over the two rebuild scopes so setScene can skip the scope
// that didn't change. Cheap relative to the GPU teardown they gate (a merged-
// geometry + light-array rebuild), and same order as build3dScene itself, which
// already re-walked this data. Ids/kinds are comma-free generated slugs, so a
// single join(",") is unambiguous.

function pushRing(out: (string | number)[], ring: MetreXY[] | null): void {
  if (!ring) {
    out.push("-");
    return;
  }
  out.push(ring.length);
  for (const [x, y] of ring) out.push(x, y);
}

function pushPrisms(out: (string | number)[], prisms: ScenePrism[]): void {
  out.push(prisms.length);
  for (const p of prisms) {
    out.push(p.id, p.kind, p.baseM, p.topM);
    pushRing(out, p.ring);
  }
}

/** Signature of everything the world scope renders — the static shell (ground,
 *  slab, floor patches, walls, prisms, ceiling) and house lights — i.e. every
 *  Scene3D field EXCEPT the cameras. Changes ⇒ rebuildWorld. */
function worldSignature(s: Scene3D): string {
  const out: (string | number)[] = [s.ordinal, s.ceilingM];
  pushRing(out, s.footprintRing);
  out.push(s.floorPatches.length);
  for (const fp of s.floorPatches) {
    out.push(fp.id, fp.category);
    pushRing(out, fp.ring);
  }
  out.push(s.wallSegs.length);
  for (const w of s.wallSegs) out.push(w.a[0], w.a[1], w.b[0], w.b[1], w.topM);
  pushPrisms(out, s.slabPrisms);
  pushPrisms(out, s.structurePrisms);
  pushPrisms(out, s.fixturePrisms);
  return out.join(",");
}

/** Signature of the camera scope — bodies, selection gizmo and coverage cones.
 *  Uses the resolved poses (so a ceiling change that re-clamps mountM also flips
 *  this and moves the bodies). Changes ⇒ rebuildCameraBodies + coverage. */
function cameraSignature(s: Scene3D): string {
  const out: (string | number)[] = [];
  for (const c of s.cameras) {
    out.push(
      c.id, c.at[0], c.at[1], c.mountM, c.headingDeg, c.tiltDeg, c.rollDeg,
      c.fovDeg, c.vfovDeg, c.rangeM, c.kind, c.mount,
    );
  }
  return out.join(",");
}

