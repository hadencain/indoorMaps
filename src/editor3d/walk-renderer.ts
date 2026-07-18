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
import type { Category } from "../types";
import { CATEGORY_COLORS } from "../categories";
import { pointInRing } from "../coverage";
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
}

/** Coverage-cone display policy. `selected` lights only the selected camera;
 *  `nearby` adds up to 8 cameras nearest the player (≤ 9 shadow casters total);
 *  `off` shows no cones. */
export type CoverageMode = "selected" | "nearby" | "off";

const DEG = Math.PI / 180;
const WALK_SPEED = 4.2; // m/s (spike-calibrated)
const RUN_SPEED = 8.5; // m/s (Shift)
// Forward renderer: EVERY house PointLight is evaluated per fragment (no light
// culling), so this count is a hard fill-rate budget on entry-level Turing
// (GTX 1650) — the proven spike used 5 fixed downlights. Keep it a small
// multiple of that, evenly spread over the footprint (see addHouseLights),
// rather than a dense fixed grid that saturated ~48 lights on a big floor.
const MAX_HOUSE_LIGHTS = 12; // forward-rendering fill-rate budget for warm downlights
const HOUSE_LIGHT_STEP_M = 22; // MINIMUM downlight grid spacing (widened per-floor to stay under the budget)
const MAX_SHADOW_LIGHTS = 9; // hard cap on shadow-casting coverage spotlights
const STRUCTURE_COLOR = "#9a9aa0"; // structures render as neutral concrete grey
const SLAB_FALLBACK = "#3a4150"; // low circulation slabs when no category colour

// Fixture kind → base colour (ported verbatim from the spike's palette so the
// walk view reads the same as the proven noir spike).
const FIX_COLOR: Record<string, number> = {
  blackjack: 0x1d5c3a, roulette: 0x1d5c3a, poker: 0x1d5c3a, baccarat: 0x1d5c3a,
  craps: 0x1d5c3a, wheel: 0x1d5c3a, slot: 0x5a3a6e, bar: 0x6e4a2a, counter: 0x6e4a2a,
  seating: 0x44484f, stage: 0x333640, planter: 0x2f4a2f, car: 0x4a5058, parking: 0x22252c,
};

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

// Dispose every geometry/material/light under an object before it's discarded —
// three keeps GPU resources alive until explicitly freed, and the walk view
// rebuilds its whole scene on each floor/edit.
function disposeObject(o: THREE.Object3D): void {
  o.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh> & Partial<THREE.Light>;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (child as THREE.Mesh).material;
    if (mat) {
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
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

  constructor(container: HTMLElement, opts: WalkRendererOpts) {
    this.container = container;
    this.opts = opts;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c10);
    this.scene.fog = new THREE.FogExp2(0x0a0c10, 0.006);
    this.scene.add(this.worldGroup, this.camBodyGroup, this.frustumGroup, this.coverageGroup);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 600);
    this.camera.position.copy(v3(0, 0, EYE_M));

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);

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

    // Dark ground plane under everything (spike recipe).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: 0x101218, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    ground.receiveShadow = true;
    g.add(ground);

    // Footprint slab.
    if (scene.footprintRing) {
      const slab = new THREE.Mesh(
        flatGeo(scene.footprintRing, 0),
        new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.95 }),
      );
      slab.receiveShadow = true;
      g.add(slab);
    }

    // Per-unit floor patches, coloured by category (readability at eye level).
    for (const patch of scene.floorPatches) {
      if (patch.ring.length < 3) continue;
      const mesh = new THREE.Mesh(
        flatGeo(patch.ring, 0.02),
        new THREE.MeshStandardMaterial({ color: categoryColor(patch.category), roughness: 0.9 }),
      );
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    // Walls as ONE InstancedMesh of unit boxes scaled per segment.
    this.addWalls(scene, g);

    // Extruded prisms, merged per material kind.
    this.addPrismGroup(scene.slabPrisms, (k) => slabColor(k), g);
    this.addPrismGroup(scene.structurePrisms, () => STRUCTURE_COLOR, g);
    this.addPrismGroup(scene.fixturePrisms, (k) => FIX_COLOR[k] ?? 0x555555, g);

    // Ceiling — castShadow OFF so coverage lights aren't killed by the plane
    // they hang from (spike-proven).
    if (scene.footprintRing) {
      const ceil = new THREE.Mesh(
        flatGeo(scene.footprintRing, scene.ceilingM + 0.02),
        new THREE.MeshStandardMaterial({ color: 0x191b22, roughness: 1, side: THREE.DoubleSide }),
      );
      ceil.castShadow = false;
      g.add(ceil);
    }

    this.addHouseLights(scene, g);
  }

  private addWalls(scene: Scene3D, group: THREE.Group): void {
    const segs = scene.wallSegs;
    if (segs.length === 0) return;
    const proto = new THREE.BoxGeometry(1, 1, WALL_THICKNESS_M);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.85 });
    const inst = new THREE.InstancedMesh(proto, mat, segs.length);
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
      const mid = v3((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, top / 2);
      // model heading atan2(dy,dx); in three (-y) space the yaw about +Y matches.
      q.setFromAxisAngle(up, Math.atan2(dy, dx));
      m.compose(mid, q, new THREE.Vector3(len, top, 1));
      inst.setMatrixAt(n++, m);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }

  private addPrismGroup(
    prisms: ScenePrism[],
    colorFor: (kind: string) => THREE.ColorRepresentation,
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
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({ color: colorFor(kind), roughness: 0.82 }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  private addHouseLights(scene: Scene3D, group: THREE.Group): void {
    group.add(new THREE.AmbientLight(0x8090b0, 0.8));
    group.add(new THREE.HemisphereLight(0x39405a, 0x14161a, 1.0));

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
    const h = scene.ceilingM - 0.3;
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
        const p = new THREE.PointLight(0xffd9a0, 45, 55, 1.6);
        p.position.copy(v3(x, y, h));
        group.add(p);
        placed++;
      }
    }
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
    const first = scene.cameras[0] ?? null;
    let at: MetreXY;
    let faceAt: MetreXY | null = null;
    if (first) {
      at = [first.at[0] - 6, first.at[1] - 6];
      faceAt = first.at;
    } else {
      at = centroid(scene.footprintRing) ?? [0, 0];
    }
    const sel = this.selectedId ? scene.cameras.find((c) => c.id === this.selectedId) : undefined;
    if (sel) faceAt = sel.at;
    this.camera.position.copy(v3(at[0], at[1], EYE_M));
    if (faceAt && (faceAt[0] !== at[0] || faceAt[1] !== at[1])) {
      this.camera.lookAt(v3(faceAt[0], faceAt[1], EYE_M));
    }
    this.camera.position.y = EYE_M;
  }

  // ---- selection gizmo -----------------------------------------------------

  private applySelection(): void {
    this.clearGroup(this.frustumGroup);
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
    const spot = new THREE.SpotLight(0x39ff88, 60, pose.rangeM, 0.5, 0.3, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
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
    }

    this.renderer.render(this.scene, this.camera);
  };

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

function categoryColor(c: Category): THREE.ColorRepresentation {
  return CATEGORY_COLORS[c];
}

function slabColor(kind: string): THREE.ColorRepresentation {
  return (CATEGORY_COLORS as Record<string, string | undefined>)[kind] ?? SLAB_FALLBACK;
}
