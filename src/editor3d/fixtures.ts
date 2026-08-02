// Parametric, instanced fixture-model library for the walk editor (R2 of the 3D
// realism pass, docs/3d-realism-spec.md). three.js is imported here ONLY inside
// src/editor3d/ so the bundle boundary stays grep-auditable and the single-file
// viewer never pulls it in.
//
// Each FixtureKind gets a CANONICAL low-poly model, built ONCE and cached. The
// renderer scales/rotates the canonical to every fixture's real footprint via a
// per-instance matrix (walk-renderer.addFixtures), so a floor with 300 slots is
// ONE InstancedMesh draw, not 300 meshes.
//
// Coordinate space of a canonical model (three.js Y-up, matching the renderer's
// v3 mapping model[x,y] -> three(x, h, -y)):
//   · +X = the fixture's "length" (its footprint principal axis), centred on 0
//   · +Z = the fixture's "width" (perpendicular), centred on 0
//   · +Y = up, base sitting at y = 0
// Two `fit` strategies drive how the renderer scales the canonical:
//   · "bbox"   — X∈[-0.5,0.5], Z∈[-0.5,0.5] are UNIT; Y is authored in REAL
//                METRES (a card table's felt is at y≈0.9). The renderer scales
//                (lengthM, 1, widthM): footprint stretches independently, height
//                is the fixed real height. Used by everything with a fixed
//                real-world height regardless of footprint (tables, slot, bar,
//                counter, seating, stage, planter, wheel, parking).
//   · "length" — the whole model is authored in UNIT space (X∈[-0.5,0.5], Y and
//                Z as proportions of the length). The renderer scales uniformly
//                (lengthM, lengthM, lengthM), preserving aspect. Used by `car`,
//                whose height genuinely scales with its footprint.
//
// Sharing / disposal contract (mirrors materials.ts): the shared body material,
// the per-emissive-colour materials, and every cached canonical geometry are
// tagged `userData.shared = true`. The renderer's clearGroup teardown disposes
// per-rebuild InstancedMesh instance buffers but SKIPS anything tagged shared —
// these canonical resources outlive every rebuild and are freed exactly once, in
// disposeFixtureModels(), from the renderer's dispose().

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { FixtureKind } from "../types";

export type FixtureFit = "bbox" | "length";

/** A cached canonical fixture model. `geometry`+`material` are the opaque body
 *  (one InstancedMesh); the optional `emissiveGeometry`+`emissiveMaterial` are a
 *  SECOND InstancedMesh for self-lit parts (slot screens, bar bottles, stage
 *  lights) so they can bloom without dragging the whole body bright. `height` is
 *  the canonical bounding-box height (metres for "bbox", unit for "length"). */
export interface FixtureModel {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  emissiveGeometry?: THREE.BufferGeometry;
  emissiveMaterial?: THREE.Material;
  fit: FixtureFit;
  height: number;
  /** Measured plan extents of the canonical body, in the model's own units
   *  (real metres for "bbox"). The renderer fits these into the authored
   *  footprint — see planFitScale. Measured, never hand-declared, so a model
   *  edit can't silently desync its own size. */
  spanX: number;
  spanZ: number;
}

/** Per-axis scale placing a canonical model inside an authored footprint.
 *
 *  THE SIZING CONTRACT: a fixture polygon is a REAL FOOTPRINT, not a scale
 *  multiplier. The model is fitted *into* it preserving the model's own plan
 *  aspect — a slot machine renders slot-machine-shaped whether its polygon was
 *  drawn 0.6 m or 0.9 m deep, and can never overflow the footprint.
 *   · "bbox"   — uniform in plan (X/Z), identity in Y: height is authored in
 *                real metres and must not follow the footprint.
 *   · "length" — uniform on all three axes: the car's height genuinely scales.
 *  Degenerate spans/footprints fall back to 1 rather than emitting NaN or a
 *  zero-scale (invisible) instance. */
export function planFitScale(
  model: Pick<FixtureModel, "fit" | "spanX" | "spanZ">,
  lengthM: number,
  widthM: number,
): { x: number; y: number; z: number } {
  const sx = model.spanX > 1e-6 ? lengthM / model.spanX : NaN;
  const sz = model.spanZ > 1e-6 ? widthM / model.spanZ : NaN;
  if (model.fit === "length") {
    const k = Number.isFinite(sx) && sx > 0 ? sx : 1;
    return { x: k, y: k, z: k };
  }
  const cands = [sx, sz].filter((v) => Number.isFinite(v) && v > 0);
  const k = cands.length > 0 ? Math.min(...cands) : 1;
  return { x: k, y: 1, z: k };
}

// ---- palette (sRGB hex; THREE.Color converts to linear working space) --------
// Colours are baked as VERTEX colours on the merged body geometry and read by a
// single shared vertex-coloured MeshStandardMaterial — one material, one draw
// call per kind. This is the deliberate trade for instancing: an InstancedMesh
// takes ONE material, so per-part material variety (felt vs wood vs metal) is
// expressed as colour, not as separate textured materials. The values track the
// materials.ts family base colours (felt green, wood browns, brushed metal grey,
// marble stone) so fixtures read as the same world as the floors/walls.

const FELT = 0x1f6b40;
const WOOD = 0x4a3320;
const WOOD_DARK = 0x2a1c11;
const LEATHER = 0x241a14;
const METAL = 0x8b9098;
const METAL_DARK = 0x3a3d42;
const CHIP_TRAY = 0x181b20;
const STONE = 0xcac6bf;
const CUSHION = 0x3c2f48;
const FOLIAGE_A = 0x2f6b2c;
const FOLIAGE_B = 0x3f8038;
const SOIL = 0x18110b;
const PLANTER_BOX = 0x50412f;
const CAR_BODY = 0x53606c;
const GLASS = 0x0b0d13;
const TIRE = 0x111316;
const ASPHALT = 0x2b2d31;
const LINE_PAINT = 0xcfcaba;
const STAGE_DECK = 0x1b1920;

// Emissive accents — kept modest on purpose: the CCTV coverage cones + camera
// bodies stay the brightest, most saturated things in frame (camera-primary,
// the spec's core constraint). The human tunes intensities after screenshots.
const SCREEN = 0x6fa8c8; // slot screen — a lit LCD, not a neon panel (was over-saturated cyan)
const SCREEN_I = 0.55;
const BOTTLE = 0xffb060; // back-bar bottle glow — warm amber, tiny area
const BOTTLE_I = 0.7;
const STAGE_LIGHT = 0xffd39a; // truss lamps — warm
const STAGE_LIGHT_I = 1.0;

// ---- primitive helpers -------------------------------------------------------
// Every part is an INDEXED primitive (Box/Cylinder/Sphere/Cone) with position,
// normal, uv — so mergeGeometries stays happy (mixing indexed + non-indexed, e.g.
// Icosahedron, would throw; foliage therefore uses low-seg spheres, not polyhedra).

/** Bake a flat vertex colour so many parts merge into one vertex-coloured body
 *  mesh under a single shared material (one draw call per kind). */
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

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colored(g, hex);
}

/** Emissive box — NO vertex colour (the emissive material carries the colour). */
function ebox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

type CylAxis = "y" | "x" | "z";

function cyl(
  rTop: number,
  rBot: number,
  h: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  hex: number,
  axis: CylAxis = "y",
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (axis === "x") g.rotateZ(Math.PI / 2); // Y -> X
  else if (axis === "z") g.rotateX(Math.PI / 2); // Y -> Z
  g.translate(x, y, z);
  return colored(g, hex);
}

function sphere(r: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 8, 6);
  g.translate(x, y, z);
  return colored(g, hex);
}

/** A rounded "racetrack" slab: a centre box capped by half-cylinder discs at one
 *  or both ends along ±X. `ends` = 1 rounds only the −X end (a blackjack dealer
 *  arc); 2 rounds both (poker/baccarat/roulette oval). Returns the parts to push. */
function racetrack(
  lenX: number,
  depthZ: number,
  thickY: number,
  y: number,
  hex: number,
  ends: 1 | 2,
  seg = 14,
): THREE.BufferGeometry[] {
  const r = depthZ / 2;
  const out: THREE.BufferGeometry[] = [];
  if (ends === 2) {
    const bodyLen = Math.max(lenX - 2 * r, 0.01);
    out.push(box(bodyLen, thickY, depthZ, 0, y, 0, hex));
    out.push(cyl(r, r, thickY, seg, bodyLen / 2, y, 0, hex));
    out.push(cyl(r, r, thickY, seg, -bodyLen / 2, y, 0, hex));
  } else {
    // One rounded end at −X: box occupies the +X side, cap rounds the −X face.
    const bodyLen = Math.max(lenX - r, 0.01);
    out.push(box(bodyLen, thickY, depthZ, (lenX - bodyLen) / 2, y, 0, hex));
    out.push(cyl(r, r, thickY, seg, lenX / 2 - bodyLen, y, 0, hex));
  }
  return out;
}

// ---- raw model spec ----------------------------------------------------------

interface RawModel {
  body: THREE.BufferGeometry[];
  emissive?: THREE.BufferGeometry[];
  emissiveColor?: number;
  emissiveIntensity?: number;
  fit: FixtureFit;
}

/** Shared card-table builder (blackjack / poker / baccarat differ by end shape).
 *  Fixed real height ≈0.9 m, "bbox" fit. */
function cardTable(ends: 1 | 2, feltDepth: number, apronDepth: number): RawModel {
  const body: THREE.BufferGeometry[] = [];
  // Stability foot + pedestal.
  body.push(box(0.5, 0.05, 0.4, 0, 0.025, 0, METAL_DARK));
  body.push(box(0.34, 0.72, 0.3, 0, 0.41, 0, WOOD_DARK));
  // Wooden apron (the table body / rail) then the felt inset on top.
  body.push(...racetrack(0.98, apronDepth, 0.12, 0.82, WOOD, ends));
  body.push(...racetrack(0.9, feltDepth, 0.04, 0.9, FELT, ends));
  // Padded leather bumper along the two long edges.
  body.push(box(0.86, 0.05, 0.05, 0, 0.9, feltDepth / 2, LEATHER));
  body.push(box(0.86, 0.05, 0.05, 0, 0.9, -feltDepth / 2, LEATHER));
  // Chip tray at the −X (dealer) end.
  body.push(box(0.22, 0.05, 0.09, -0.34, 0.93, 0, CHIP_TRAY));
  return { body, fit: "bbox" };
}

function rouletteTable(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(0.5, 0.05, 0.4, -0.1, 0.025, 0, METAL_DARK));
  body.push(box(0.34, 0.72, 0.3, -0.1, 0.41, 0, WOOD_DARK));
  // Oval felt betting layout on the −X two-thirds.
  body.push(...racetrack(0.6, 0.56, 0.12, 0.82, WOOD, 2));
  const felt = racetrack(0.54, 0.5, 0.04, 0.9, FELT, 2);
  for (const g of felt) g.translate(-0.1, 0, 0);
  body.push(...felt);
  // Wheel assembly at the +X end (kept inside the normalized ±0.5 footprint box).
  const wx = 0.32;
  body.push(cyl(0.17, 0.17, 0.06, 20, wx, 0.9, 0, WOOD, "y")); // bowl rim
  body.push(cyl(0.14, 0.14, 0.08, 20, wx, 0.95, 0, WOOD_DARK, "y")); // wheel head
  body.push(cyl(0.05, 0.05, 0.11, 12, wx, 0.97, 0, METAL, "y")); // hub
  body.push(box(0.26, 0.02, 0.02, wx, 1.0, 0, METAL)); // spokes
  body.push(box(0.02, 0.02, 0.26, wx, 1.0, 0, METAL));
  return { body, fit: "bbox" };
}

function crapsTable(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  // Four legs.
  for (const sx of [-0.45, 0.45]) {
    for (const sz of [-0.3, 0.3]) body.push(box(0.06, 0.9, 0.06, sx, 0.45, sz, WOOD_DARK));
  }
  body.push(box(1.0, 0.16, 0.66, 0, 0.98, 0, WOOD)); // table body
  body.push(box(0.92, 0.03, 0.58, 0, 1.07, 0, FELT)); // felt inset
  // Raised end walls + side rails (the craps "walls").
  body.push(box(0.05, 0.26, 0.66, -0.47, 1.15, 0, WOOD));
  body.push(box(0.05, 0.26, 0.66, 0.47, 1.15, 0, WOOD));
  body.push(box(1.0, 0.09, 0.05, 0, 1.12, 0.32, LEATHER));
  body.push(box(1.0, 0.09, 0.05, 0, 1.12, -0.32, LEATHER));
  return { body, fit: "bbox" };
}

function moneyWheel(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(0.4, 0.08, 0.4, 0, 0.04, 0, METAL_DARK)); // base
  body.push(box(0.1, 1.3, 0.1, 0, 0.7, 0, METAL)); // post
  // Vertical wheel (disc plane in XY, axis along Z) up top.
  const wy = 1.42;
  body.push(cyl(0.48, 0.48, 0.04, 24, 0, wy, -0.02, METAL_DARK, "z")); // backing rim
  body.push(cyl(0.44, 0.44, 0.06, 24, 0, wy, 0.04, WOOD, "z")); // wheel face
  body.push(cyl(0.08, 0.08, 0.12, 12, 0, wy, 0.06, METAL, "z")); // hub
  body.push(box(0.86, 0.03, 0.02, 0, wy, 0.09, WOOD_DARK)); // spokes
  body.push(box(0.03, 0.86, 0.02, 0, wy, 0.09, WOOD_DARK));
  body.push(box(0.04, 0.12, 0.03, 0, wy + 0.52, 0.06, LEATHER)); // top pointer
  return { body, fit: "bbox" };
}

function slotMachine(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  // Real cabinet height ≈1.8 m WITH the topper — deliberately above the 1.7 m
  // walk eye line. At the old 1.56 m the operator looked DOWN on a sea of
  // cabinet tops and a slot bank read as low furniture instead of a machine row.
  body.push(box(0.5, 0.55, 0.55, 0, 0.275, 0, METAL_DARK)); // base cabinet
  body.push(box(0.56, 0.85, 0.5, 0, 0.975, 0, METAL)); // body
  body.push(box(0.56, 0.06, 0.22, 0, 0.6, 0.28, METAL)); // button deck
  body.push(box(0.5, 0.4, 0.18, 0, 1.6, 0, METAL_DARK)); // topper
  const emissive: THREE.BufferGeometry[] = [];
  emissive.push(ebox(0.46, 0.55, 0.03, 0, 1.05, 0.26)); // main screen
  emissive.push(ebox(0.44, 0.1, 0.04, 0, 1.72, 0.09)); // topper light strip
  emissive.push(ebox(0.5, 0.05, 0.03, 0, 0.06, 0.28)); // R3: base glow strip (slot-row floor wash)
  return { body, emissive, emissiveColor: SCREEN, emissiveIntensity: SCREEN_I, fit: "bbox" };
}

function barCounter(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 1.0, 0.4, 0, 0.5, 0, WOOD_DARK)); // mass
  body.push(box(1.0, 1.05, 0.12, 0, 0.525, 0.2, WOOD)); // front face
  body.push(box(1.02, 0.06, 0.62, 0, 1.08, 0.02, STONE)); // stone top overhang
  body.push(box(1.0, 0.04, 0.04, 0, 0.12, 0.34, METAL)); // foot rail
  body.push(box(1.0, 0.9, 0.16, 0, 0.7, -0.4, METAL_DARK)); // back-bar
  body.push(box(1.0, 0.04, 0.2, 0, 1.0, -0.38, WOOD_DARK)); // back-bar shelf
  const emissive: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const x = -0.42 + (i * 0.84) / 5;
    emissive.push(ebox(0.05, 0.2, 0.05, x, 0.85, -0.4)); // bottle glow
  }
  return { body, emissive, emissiveColor: BOTTLE, emissiveIntensity: BOTTLE_I, fit: "bbox" };
}

function counter(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 0.95, 0.5, 0, 0.475, 0, WOOD_DARK)); // mass
  body.push(box(1.0, 1.0, 0.12, 0, 0.5, 0.24, WOOD)); // front face
  body.push(box(1.02, 0.05, 0.6, 0, 1.02, 0, STONE)); // top
  body.push(box(0.96, 0.1, 0.05, 0, 0.06, 0.27, METAL_DARK)); // kick
  return { body, fit: "bbox" };
}

function seating(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 0.18, 0.98, 0, 0.09, 0, WOOD_DARK)); // plinth
  body.push(box(0.94, 0.16, 0.5, 0, 0.34, 0.18, CUSHION)); // seat
  body.push(box(0.94, 0.42, 0.16, 0, 0.55, -0.34, CUSHION)); // backrest
  body.push(box(0.1, 0.32, 0.7, -0.45, 0.42, 0, CUSHION)); // arms
  body.push(box(0.1, 0.32, 0.7, 0.45, 0.42, 0, CUSHION));
  return { body, fit: "bbox" };
}

function stage(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 0.3, 1.0, 0, 0.15, 0, STAGE_DECK)); // deck
  body.push(box(1.02, 0.04, 1.02, 0, 0.31, 0, METAL_DARK)); // edge lip
  // Two truss uprights at the back corners + a crossbar.
  body.push(box(0.06, 2.0, 0.06, -0.46, 1.3, -0.46, METAL));
  body.push(box(0.06, 2.0, 0.06, 0.46, 1.3, -0.46, METAL));
  body.push(box(0.94, 0.06, 0.06, 0, 2.28, -0.46, METAL)); // crossbar
  const emissive: THREE.BufferGeometry[] = [];
  for (const x of [-0.3, 0, 0.3]) emissive.push(ebox(0.08, 0.06, 0.08, x, 2.22, -0.44)); // lamps
  return { body, emissive, emissiveColor: STAGE_LIGHT, emissiveIntensity: STAGE_LIGHT_I, fit: "bbox" };
}

function planter(): RawModel {
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 0.5, 1.0, 0, 0.25, 0, PLANTER_BOX)); // box
  body.push(box(1.02, 0.06, 1.02, 0, 0.5, 0, WOOD_DARK)); // rim
  body.push(box(0.88, 0.05, 0.88, 0, 0.5, 0, SOIL)); // soil
  // Low-poly foliage blobs (indexed spheres, two greens).
  const blobs: Array<[number, number, number, number, number]> = [
    [0.26, 0.0, 0.72, 0.0, FOLIAGE_A],
    [0.2, -0.28, 0.66, 0.22, FOLIAGE_B],
    [0.22, 0.26, 0.68, -0.2, FOLIAGE_A],
    [0.18, 0.05, 0.86, 0.24, FOLIAGE_B],
    [0.18, -0.2, 0.82, -0.24, FOLIAGE_A],
  ];
  for (const [r, x, y, z, c] of blobs) body.push(sphere(r, x, y, z, c));
  return { body, fit: "bbox" };
}

function car(): RawModel {
  // Authored in UNIT space (length = 1); "length" fit scales uniformly so the
  // car keeps real proportions. Wheels sit at y=0 so the base is on the floor.
  const body: THREE.BufferGeometry[] = [];
  body.push(box(0.96, 0.1, 0.38, 0, 0.13, 0, CAR_BODY)); // lower body
  body.push(box(0.9, 0.14, 0.4, 0, 0.19, 0, CAR_BODY)); // main body
  body.push(box(0.46, 0.13, 0.36, -0.02, 0.3, 0, CAR_BODY)); // cabin frame
  body.push(box(0.42, 0.11, 0.34, -0.02, 0.3, 0, GLASS)); // greenhouse glass
  for (const sx of [-0.3, 0.3]) {
    for (const sz of [-0.19, 0.19]) body.push(cyl(0.09, 0.09, 0.07, 12, sx, 0.09, sz, TIRE, "z"));
  }
  return { body, fit: "length" };
}

function parkingPad(): RawModel {
  // Near-flat stall pad. NOTE: scene-build drops zero-height fixtures, and
  // FIXTURE_HEIGHT_M.parking === 0, so `parking` never reaches fixturePrisms and
  // this model is currently dormant. Built for completeness / future data.
  const body: THREE.BufferGeometry[] = [];
  body.push(box(1.0, 0.02, 1.0, 0, 0.01, 0, ASPHALT));
  body.push(box(0.04, 0.025, 1.0, -0.48, 0.013, 0, LINE_PAINT));
  body.push(box(0.04, 0.025, 1.0, 0.48, 0.013, 0, LINE_PAINT));
  return { body, fit: "bbox" };
}

const BUILDERS: Record<FixtureKind, () => RawModel> = {
  blackjack: () => cardTable(1, 0.6, 0.66),
  poker: () => cardTable(2, 0.64, 0.7),
  baccarat: () => cardTable(2, 0.6, 0.66),
  roulette: rouletteTable,
  craps: crapsTable,
  wheel: moneyWheel,
  slot: slotMachine,
  bar: barCounter,
  counter,
  seating,
  stage,
  planter,
  car,
  parking: parkingPad,
};

// ---- shared materials --------------------------------------------------------

let bodyMaterial: THREE.MeshStandardMaterial | null = null;
let detailMap: THREE.CanvasTexture | null = null;
let detailRough: THREE.CanvasTexture | null = null;

/** Fine surface detail shared by every fixture body: a near-white speckle+streak
 *  map that MULTIPLIES the baked vertex colours (so it adds texture without
 *  touching hue), plus a matching roughness map.
 *
 *  Without it every fixture in the venue was a perfectly uniform shade at a
 *  single roughness — the reason a bank of slot cabinets read as blocked-out
 *  primitives even after the models themselves gained real detail. Surface
 *  variation is what separates "a box the right shape" from "an object".
 *  Primitive UVs are 0..1 per face, so this lands once per face at a scale that
 *  suits everything from a chip tray to a bar front. */
function buildDetailTextures(): void {
  // fixtures.test.ts asserts the canonical models' real-world SPANS (a slot
  // cabinet is 0.5–0.8 m wide, a card table is longer than it is deep) and runs
  // in plain node with no DOM — that geometry maths is the part worth testing and
  // it should stay runnable without a browser. Skip the canvas work there; the
  // material simply renders untextured, which no test looks at.
  if (typeof document === "undefined") return;
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const rc = document.createElement("canvas");
  rc.width = rc.height = S;
  const rctx = rc.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(S, S);
  const rimg = rctx.createImageData(S, S);
  // Deterministic hash noise — never Math.random, so the texture is identical
  // every session (a surface that shimmers between reloads reads as a bug).
  const h2 = (x: number, y: number): number => {
    let h = (Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x27d4eb2d)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const speck = h2(x, y);
      const streak = h2(Math.floor(x / 3), y * 7) * 0.5 + h2(x, Math.floor(y / 9)) * 0.5;
      // Kept close to 1 on purpose: this modulates, it does not recolour.
      const v = 0.88 + speck * 0.09 + streak * 0.06;
      const o = (y * S + x) * 4;
      const c = Math.round(Math.min(1, v) * 255);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = c;
      img.data[o + 3] = 255;
      const r = Math.round((0.42 + streak * 0.4 + speck * 0.1) * 255);
      rimg.data[o] = rimg.data[o + 1] = rimg.data[o + 2] = r;
      rimg.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  detailMap = new THREE.CanvasTexture(canvas);
  detailMap.colorSpace = THREE.SRGBColorSpace;
  detailMap.wrapS = detailMap.wrapT = THREE.RepeatWrapping;
  detailMap.anisotropy = 8;
  detailRough = new THREE.CanvasTexture(rc);
  detailRough.colorSpace = THREE.NoColorSpace;
  detailRough.wrapS = detailRough.wrapT = THREE.RepeatWrapping;
  detailRough.anisotropy = 8;
}

/** The single shared vertex-coloured body material for every fixture kind. One
 *  material ⇒ one draw call per kind's opaque InstancedMesh. Semi-matte / lightly
 *  metallic so fixtures read as solid objects without out-glinting the cameras. */
function getBodyMaterial(): THREE.MeshStandardMaterial {
  if (!bodyMaterial) {
    if (!detailMap) buildDetailTextures();
    bodyMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: detailMap,
      roughnessMap: detailRough,
      roughness: 0.75,
      metalness: 0.22,
    });
    bodyMaterial.userData.shared = true;
  }
  return bodyMaterial;
}

const emissiveCache = new Map<string, THREE.MeshStandardMaterial>();

/** Shared emissive material for a self-lit fixture part, cached by colour+level.
 *  Colour lives on the material (not vertex colours) so a whole emissive mesh
 *  glows one colour. Kept modest so slot screens etc. never outshine the cones. */
function getEmissiveMaterial(color: number, intensity: number): THREE.MeshStandardMaterial {
  const key = `${color}:${intensity}`;
  let m = emissiveCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 1,
      metalness: 0,
    });
    m.userData.shared = true;
    emissiveCache.set(key, m);
  }
  return m;
}

// ---- registry + build/cache --------------------------------------------------

const registry = new Map<FixtureKind, FixtureModel>();

function buildModel(kind: FixtureKind): FixtureModel {
  const raw = BUILDERS[kind]();
  const geometry = mergeGeometries(raw.body, false);
  if (!geometry) throw new Error(`fixture body merge failed: ${kind}`);
  raw.body.forEach((g) => g.dispose());
  // Normals come from the source primitives (Box/Cylinder/Sphere) and survive the
  // merge — no recompute (which would smooth across the hard box edges).
  geometry.computeBoundingBox();
  geometry.userData.shared = true; // clearGroup must NOT dispose the cached body
  const bb = geometry.boundingBox;
  const height = bb ? bb.max.y - bb.min.y : 1;
  const spanX = bb ? bb.max.x - bb.min.x : 1;
  const spanZ = bb ? bb.max.z - bb.min.z : 1;

  const model: FixtureModel = {
    geometry,
    material: getBodyMaterial(),
    fit: raw.fit,
    height,
    spanX,
    spanZ,
  };

  if (raw.emissive && raw.emissive.length > 0 && raw.emissiveColor != null) {
    const eg = mergeGeometries(raw.emissive, false);
    raw.emissive.forEach((g) => g.dispose());
    if (eg) {
      eg.userData.shared = true;
      model.emissiveGeometry = eg;
      model.emissiveMaterial = getEmissiveMaterial(raw.emissiveColor, raw.emissiveIntensity ?? 1);
    }
  }
  return model;
}

/** The cached canonical model for a fixture kind. Built (geometry + shared
 *  materials) on first use; every later call returns the SAME instance, so a
 *  scene rebuild only allocates fresh InstancedMeshes, never geometry. */
export function getFixtureModel(kind: FixtureKind): FixtureModel {
  let m = registry.get(kind);
  if (!m) {
    m = buildModel(kind);
    registry.set(kind, m);
  }
  return m;
}

/** Dispose every cached canonical geometry + the shared body/emissive materials.
 *  Call ONCE from the renderer's dispose() — never per rebuild (clearGroup skips
 *  these shared resources by design). Safe to call before any build. */
export function disposeFixtureModels(): void {
  for (const m of registry.values()) {
    m.geometry.dispose();
    m.emissiveGeometry?.dispose();
  }
  registry.clear();
  bodyMaterial?.dispose();
  bodyMaterial = null;
  detailMap?.dispose();
  detailMap = null;
  detailRough?.dispose();
  detailRough = null;
  for (const m of emissiveCache.values()) m.dispose();
  emissiveCache.clear();
}
