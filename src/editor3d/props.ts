// Set dressing for the walk editor (Phase D of the AAA venue render pass,
// docs/superpowers/plans/2026-08-01-aaa-venue-render.md).
//
// three.js is imported here ONLY inside src/editor3d/ so the bundle boundary stays
// grep-auditable and the single-file viewer never pulls it in.
//
// Real venues are DENSE. Not with hero objects — with the hundred small things
// nobody consciously notices and everybody notices the absence of: sprinkler heads
// and air diffusers on the ceiling grid, an exit sign over every door, a bin by
// the seating, a queue rail at the counter. Their absence is a large part of why
// the walk view read as a model of a building rather than a building.
//
// Every prop here is derived from data that ALREADY EXISTS in every venue —
// amenity points, fixture footprints, unit rings — rather than scattered at
// random. That matters twice over: the placement is meaningful (the exit sign is
// over a real exit), and it costs no authoring.
//
// Everything is instanced per kind, so the whole floor's dressing is a handful of
// draw calls.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AmenityKind, MetreXY } from "../types";
import type { SceneAmenity, SceneFloorPatch, ScenePrism } from "../scene/scene-build";

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// ---- deterministic jitter ----------------------------------------------------

/** Stable hash of a string to [0,1). Deterministic so a rebuild never reshuffles
 *  the dressing — a bin that teleports when you toggle a layer reads as a bug. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ---- ceiling services --------------------------------------------------------

/** Grid spacing for sprinklers/diffusers, metres. Roughly the real thing: heads
 *  on a ~3.5 m grid, diffusers about every third bay. */
const SERVICE_STEP_M = 3.6;
const MAX_SERVICE_PER_UNIT = 260;

function sprinklerGeo(): THREE.BufferGeometry {
  const drop = new THREE.CylinderGeometry(0.012, 0.012, 0.09, 6);
  drop.translate(0, -0.045, 0);
  const head = new THREE.CylinderGeometry(0.035, 0.02, 0.03, 8);
  head.translate(0, -0.1, 0);
  const g = mergeGeometries([drop, head], false);
  [drop, head].forEach((x) => x.dispose());
  return g ?? new THREE.BufferGeometry();
}

function diffuserGeo(): THREE.BufferGeometry {
  const plate = new THREE.BoxGeometry(0.58, 0.03, 0.58);
  plate.translate(0, -0.015, 0);
  const throat = new THREE.BoxGeometry(0.42, 0.06, 0.42);
  throat.translate(0, -0.055, 0);
  const g = mergeGeometries([plate, throat], false);
  [plate, throat].forEach((x) => x.dispose());
  return g ?? new THREE.BufferGeometry();
}

function speakerGeo(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 10);
  g.translate(0, -0.02, 0);
  return g;
}

// ---- amenity props -----------------------------------------------------------

/** Illuminated exit sign — a small box with an emissive face. */
function exitSignGeo(): { body: THREE.BufferGeometry; face: THREE.BufferGeometry } {
  const body = new THREE.BoxGeometry(0.42, 0.2, 0.06);
  const face = new THREE.BoxGeometry(0.36, 0.15, 0.075);
  return { body, face };
}

/** Freestanding ATM / kiosk cabinet with a screen. */
function atmGeo(): { body: THREE.BufferGeometry; face: THREE.BufferGeometry } {
  const base = new THREE.BoxGeometry(0.72, 1.5, 0.6);
  base.translate(0, 0.75, 0);
  const hood = new THREE.BoxGeometry(0.76, 0.16, 0.66);
  hood.translate(0, 1.58, 0);
  const body = mergeGeometries([base, hood], false) ?? base;
  [base, hood].forEach((x) => x.dispose());
  const face = new THREE.BoxGeometry(0.44, 0.34, 0.04);
  face.translate(0, 1.24, 0.3);
  return { body, face };
}

/** Wayfinding pylon — a tall thin blade with a lit face, the thing that makes a
 *  concourse read as a public building rather than a hallway. */
function pylonGeo(): { body: THREE.BufferGeometry; face: THREE.BufferGeometry } {
  const post = new THREE.BoxGeometry(0.5, 2.4, 0.14);
  post.translate(0, 1.2, 0);
  const foot = new THREE.BoxGeometry(0.6, 0.06, 0.3);
  foot.translate(0, 0.03, 0);
  const body = mergeGeometries([post, foot], false) ?? post;
  [post, foot].forEach((x) => x.dispose());
  const face = new THREE.BoxGeometry(0.42, 1.5, 0.16);
  face.translate(0, 1.45, 0);
  return { body, face };
}

/** Waste/recycling bin. */
function binGeo(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.24, 0.21, 0.85, 12);
  body.translate(0, 0.425, 0);
  const lid = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 12);
  lid.translate(0, 0.88, 0);
  const g = mergeGeometries([body, lid], false);
  [body, lid].forEach((x) => x.dispose());
  return g ?? new THREE.BufferGeometry();
}

/** Queue stanchion: post, base, and the belt stub. */
function stanchionGeo(): THREE.BufferGeometry {
  const base = new THREE.CylinderGeometry(0.17, 0.19, 0.04, 10);
  base.translate(0, 0.02, 0);
  const post = new THREE.CylinderGeometry(0.028, 0.028, 0.95, 8);
  post.translate(0, 0.5, 0);
  const cap = new THREE.CylinderGeometry(0.05, 0.05, 0.09, 8);
  cap.translate(0, 1.0, 0);
  const g = mergeGeometries([base, post, cap], false);
  [base, post, cap].forEach((x) => x.dispose());
  return g ?? new THREE.BufferGeometry();
}

/** Which amenity kinds get a floor-standing cabinet, and which get a sign. */
const CABINET_KINDS: ReadonlySet<AmenityKind> = new Set<AmenityKind>(["atm", "ticketing"]);
const PYLON_KINDS: ReadonlySet<AmenityKind> = new Set<AmenityKind>(["info", "restroom", "dining"]);
const SIGN_KINDS: ReadonlySet<AmenityKind> = new Set<AmenityKind>(["exit", "firstaid"]);

// ---- shared resources --------------------------------------------------------

interface Lib {
  sprinkler: THREE.BufferGeometry;
  diffuser: THREE.BufferGeometry;
  speaker: THREE.BufferGeometry;
  bin: THREE.BufferGeometry;
  stanchion: THREE.BufferGeometry;
  exitBody: THREE.BufferGeometry;
  exitFace: THREE.BufferGeometry;
  atmBody: THREE.BufferGeometry;
  atmFace: THREE.BufferGeometry;
  pylonBody: THREE.BufferGeometry;
  pylonFace: THREE.BufferGeometry;
}

let lib: Lib | null = null;

function getLib(): Lib {
  if (!lib) {
    const ex = exitSignGeo();
    const atm = atmGeo();
    const py = pylonGeo();
    lib = {
      sprinkler: sprinklerGeo(),
      diffuser: diffuserGeo(),
      speaker: speakerGeo(),
      bin: binGeo(),
      stanchion: stanchionGeo(),
      exitBody: ex.body,
      exitFace: ex.face,
      atmBody: atm.body,
      atmFace: atm.face,
      pylonBody: py.body,
      pylonFace: py.face,
    };
    for (const g of Object.values(lib)) g.userData.shared = true;
  }
  return lib;
}

let serviceMat: THREE.MeshStandardMaterial | null = null;
let plasticMat: THREE.MeshStandardMaterial | null = null;
let steelMat: THREE.MeshStandardMaterial | null = null;
let exitMat: THREE.MeshStandardMaterial | null = null;
let screenMat: THREE.MeshStandardMaterial | null = null;

function getServiceMat(): THREE.MeshStandardMaterial {
  if (!serviceMat) {
    serviceMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.45, metalness: 0.6 });
    serviceMat.userData.shared = true;
  }
  return serviceMat;
}
function getPlasticMat(): THREE.MeshStandardMaterial {
  if (!plasticMat) {
    plasticMat = new THREE.MeshStandardMaterial({ color: 0x2f333a, roughness: 0.7, metalness: 0.1 });
    plasticMat.userData.shared = true;
  }
  return plasticMat;
}
function getSteelMat(): THREE.MeshStandardMaterial {
  if (!steelMat) {
    steelMat = new THREE.MeshStandardMaterial({ color: 0xa8aeb6, roughness: 0.3, metalness: 0.88 });
    steelMat.userData.shared = true;
  }
  return steelMat;
}
/** Exit-sign green, bright enough to bloom — the one thing in a venue that is
 *  *supposed* to be the most legible object in the room. */
function getExitMat(): THREE.MeshStandardMaterial {
  if (!exitMat) {
    exitMat = new THREE.MeshStandardMaterial({
      color: 0x04120a,
      emissive: 0x2fe07a,
      emissiveIntensity: 3.2,
      roughness: 1,
      metalness: 0,
    });
    exitMat.userData.shared = true;
  }
  return exitMat;
}
function getScreenMat(): THREE.MeshStandardMaterial {
  if (!screenMat) {
    screenMat = new THREE.MeshStandardMaterial({
      color: 0x05080c,
      emissive: 0x74a6d8,
      emissiveIntensity: 1.5,
      roughness: 1,
      metalness: 0,
    });
    screenMat.userData.shared = true;
  }
  return screenMat;
}

// ---- placement helpers -------------------------------------------------------

function ringBBox(ring: MetreXY[]): [number, number, number, number] {
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
  return [minX, minY, maxX, maxY];
}

function inRing(x: number, y: number, ring: MetreXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Build one InstancedMesh from a list of (position, yaw) placements. */
function instance(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  places: Array<{ x: number; y: number; h: number; yaw: number }>,
  cast: boolean,
): THREE.InstancedMesh | null {
  if (places.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, places.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (let i = 0; i < places.length; i++) {
    const pl = places[i];
    q.setFromAxisAngle(UP, pl.yaw);
    p.set(pl.x, pl.h, -pl.y);
    m.compose(p, q, ONE);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  return mesh;
}

type Place = { x: number; y: number; h: number; yaw: number };

export interface PropsBuild {
  meshes: THREE.Object3D[];
}

/**
 * Build the floor's set dressing.
 *
 * `ceilingFor` gives each unit's FINISHED ceiling (ceilings.ts), so services land
 * on the plane they'd really be fixed to rather than floating at the structural
 * soffit. Exposed-ceiling spaces are skipped for diffusers/tiles — a plant room's
 * services are already modelled as duct.
 */
export function buildProps(
  patches: SceneFloorPatch[],
  amenities: SceneAmenity[],
  fixtures: ScenePrism[],
  ceilingFor: (patch: SceneFloorPatch) => number,
  hasFinishedCeiling: (patch: SceneFloorPatch) => boolean,
): PropsBuild {
  const L = getLib();
  const sprinklers: Place[] = [];
  const diffusers: Place[] = [];
  const speakers: Place[] = [];

  // ---- ceiling services on the grid ------------------------------------------
  for (const patch of patches) {
    if (patch.ring.length < 3) continue;
    if (patch.category === "outside") continue;
    if (!hasFinishedCeiling(patch)) continue;
    const h = ceilingFor(patch);
    if (h <= 1.5) continue;
    const [minX, minY, maxX, maxY] = ringBBox(patch.ring);
    // Widen the grid on big rooms so one concourse can't emit thousands of heads.
    const step = Math.max(
      SERVICE_STEP_M,
      Math.sqrt(((maxX - minX) * (maxY - minY)) / MAX_SERVICE_PER_UNIT),
    );
    let n = 0;
    for (let x = minX + step / 2; x <= maxX && n < MAX_SERVICE_PER_UNIT; x += step) {
      for (let y = minY + step / 2; y <= maxY && n < MAX_SERVICE_PER_UNIT; y += step) {
        if (!inRing(x, y, patch.ring)) continue;
        sprinklers.push({ x, y, h, yaw: 0 });
        // Every third head in each direction also carries a diffuser, and every
        // ninth a speaker — the real rhythm, where sprinklers are dense and air
        // and audio are sparse.
        if (n % 3 === 0) diffusers.push({ x: x + step * 0.4, y, h, yaw: 0 });
        if (n % 9 === 0) speakers.push({ x, y: y + step * 0.4, h, yaw: 0 });
        n++;
      }
    }
  }

  // ---- amenity props ----------------------------------------------------------
  const exitBodies: Place[] = [];
  const cabinets: Place[] = [];
  const pylons: Place[] = [];
  const bins: Place[] = [];

  // Which unit an amenity stands in, so a sign hangs at that space's own ceiling.
  const ceilAt = (at: MetreXY): number => {
    for (const patch of patches) {
      if (patch.ring.length >= 3 && inRing(at[0], at[1], patch.ring)) return ceilingFor(patch);
    }
    return 3;
  };

  for (const a of amenities) {
    // Deterministic yaw from the id: props that all face the same way are as
    // obviously placed-by-a-loop as props that all sit on a grid.
    const yaw = (hash01(a.id) - 0.5) * Math.PI * 2;
    if (SIGN_KINDS.has(a.kind)) {
      const h = Math.max(2.2, Math.min(ceilAt(a.at) - 0.35, 3.4));
      exitBodies.push({ x: a.at[0], y: a.at[1], h, yaw });
    } else if (CABINET_KINDS.has(a.kind)) {
      cabinets.push({ x: a.at[0], y: a.at[1], h: 0, yaw });
    } else if (PYLON_KINDS.has(a.kind)) {
      pylons.push({ x: a.at[0], y: a.at[1], h: 0, yaw });
    }
    // A bin beside most amenities — the single most ubiquitous object in any
    // public building and, before this, entirely absent from all seven venues.
    if (hash01(`${a.id}:bin`) < 0.55) {
      bins.push({ x: a.at[0] + 1.1, y: a.at[1] + 0.5, h: 0, yaw });
    }
  }

  // ---- queue stanchions at counters -------------------------------------------
  const stanchions: Place[] = [];
  for (const f of fixtures) {
    if (f.kind !== "counter") continue;
    if (f.ring.length < 3) continue;
    const [minX, minY, maxX, maxY] = ringBBox(f.ring);
    const lenX = maxX - minX;
    const lenY = maxY - minY;
    const alongX = lenX >= lenY;
    const run = alongX ? lenX : lenY;
    const count = Math.min(6, Math.max(2, Math.round(run / 2.2)));
    // A rail line standing 1.6 m off the service face, the way a real queue does.
    const off = 1.6;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = alongX ? minX + t * lenX : maxX + off;
      const y = alongX ? maxY + off : minY + t * lenY;
      stanchions.push({ x, y, h: 0, yaw: 0 });
    }
  }

  const meshes: THREE.Object3D[] = [];
  const push = (m: THREE.InstancedMesh | null): void => {
    if (m) meshes.push(m);
  };
  // Services never cast: they hang between the coverage spotlights and the floor,
  // and a sprinkler head that stipples the whole floor with shadow dots is both
  // wrong and expensive.
  push(instance(L.sprinkler, getServiceMat(), sprinklers, false));
  push(instance(L.diffuser, getServiceMat(), diffusers, false));
  push(instance(L.speaker, getPlasticMat(), speakers, false));
  push(instance(L.exitBody, getPlasticMat(), exitBodies, false));
  push(instance(L.exitFace, getExitMat(), exitBodies, false));
  push(instance(L.atmBody, getPlasticMat(), cabinets, true));
  push(instance(L.atmFace, getScreenMat(), cabinets, false));
  push(instance(L.pylonBody, getPlasticMat(), pylons, true));
  push(instance(L.pylonFace, getScreenMat(), pylons, false));
  push(instance(L.bin, getPlasticMat(), bins, true));
  push(instance(L.stanchion, getSteelMat(), stanchions, true));
  return { meshes };
}

/** Dispose the shared prop geometry + materials. Call ONCE from dispose(). */
export function disposeProps(): void {
  if (lib) {
    for (const g of Object.values(lib)) g.dispose();
    lib = null;
  }
  serviceMat?.dispose();
  serviceMat = null;
  plasticMat?.dispose();
  plasticMat = null;
  steelMat?.dispose();
  steelMat = null;
  exitMat?.dispose();
  exitMat = null;
  screenMat?.dispose();
  screenMat = null;
}
