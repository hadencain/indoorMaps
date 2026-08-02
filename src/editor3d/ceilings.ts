// Ceiling systems for the walk editor (Phase C of the AAA venue render pass,
// docs/superpowers/plans/2026-08-01-aaa-venue-render.md).
//
// three.js is imported here ONLY inside src/editor3d/ so the bundle boundary stays
// grep-auditable and the single-file viewer never pulls it in.
//
// THE PROBLEM THIS SOLVES: the walk view drew ONE triangulated plane of acoustic
// tile across the whole footprint at a single height. Every venue therefore had
// the same ceiling, and — worse — the same SECTION: floor at 0, ceiling at H,
// nothing in between anywhere. Real interiors are legible in section before they
// are legible in plan. A corridor runs low under a bulkhead and opens into a hall;
// a plant room has no ceiling at all, just deck and duct; a lobby is coffered. That
// vertical rhythm is most of what "designed" looks like, and none of it was here.
//
// So the ceiling is now built PER UNIT, at a height chosen for what the space is,
// with a skirt closing the step wherever a unit's ceiling sits below the level's.
// Everything merges per material, so a floor is a handful of draw calls regardless
// of how many rooms it has.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Category, MetreXY } from "../types";
import type { SceneFloorPatch } from "../scene/scene-build";
import { getMaterial } from "./materials";
import { kelvinColor, zoneFor } from "./lighting";

/** How a space's ceiling is built.
 *  - "tile"     suspended acoustic grid — offices, shops, corridors, restrooms
 *  - "coffered" deep recessed panels with a lit cove — lobbies, gaming halls
 *  - "exposed"  no ceiling at all: structural deck, joists and duct runs on show
 *               — plant rooms, back of house, loading */
export type CeilingSystem = "tile" | "coffered" | "exposed";

interface CeilingSpec {
  system: CeilingSystem;
  /** Preferred finished height, metres. The actual height is the lesser of this
   *  and the level's ceiling, so a low level never has ceilings poking through
   *  its own slab, and a tall level gets the vertical layering that makes it read
   *  as tall. */
  preferredM: number;
}

const CEILING_SPEC: Record<Category, CeilingSpec> = {
  lobby: { system: "coffered", preferredM: 99 }, // full height — lobbies are the tall space
  room: { system: "coffered", preferredM: 99 },
  retail: { system: "tile", preferredM: 3.6 },
  office: { system: "tile", preferredM: 2.8 },
  corridor: { system: "tile", preferredM: 3.1 },
  restroom: { system: "tile", preferredM: 2.7 },
  storage: { system: "exposed", preferredM: 99 },
  mechanical: { system: "exposed", preferredM: 99 },
  stairs: { system: "tile", preferredM: 99 },
  elevator: { system: "tile", preferredM: 2.6 },
  outside: { system: "tile", preferredM: 0 }, // never built (see buildCeilings)
};

/** Unit-id bucket override, mirroring materials.ts and lighting.ts so finish,
 *  light and ceiling all agree about what a space is. The casino's spaces are all
 *  category "room"; its back-of-house should show deck and duct, not coffers. */
function idBucketSpec(id: string): CeilingSpec | null {
  if (id.startsWith("boh-") || id.startsWith("cage-")) return { system: "exposed", preferredM: 99 };
  if (id.startsWith("food-") || id.startsWith("bar-")) return { system: "tile", preferredM: 3.4 };
  return null;
}

export function ceilingSpecFor(category: Category, id?: string): CeilingSpec {
  return (id ? idBucketSpec(id) : null) ?? CEILING_SPEC[category] ?? CEILING_SPEC.corridor;
}

// ---- geometry helpers --------------------------------------------------------

/** A horizontal face from an open metre ring at height `h`, facing DOWN. */
function ringPlane(ring: MetreXY[], h: number): THREE.BufferGeometry | null {
  if (ring.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(ring[0][0], ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], ring[i][1]);
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  // rotateX(−90°), NOT +90°: the model→three mapping is (x, y) → (x, ·, −y), and
  // only the negative rotation produces it. The positive one mirrors the plane to
  // +z, which silently places every ceiling on the wrong side of the origin —
  // the room looks like it has no ceiling at all rather than a misplaced one.
  // Same convention as flatGeo/prismGeo in walk-renderer.ts.
  g.rotateX(-Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

/** The vertical band closing the step between a unit's finished ceiling and the
 *  level's, run around the unit's ring. Without it a corridor ceiling at 3.1 m in
 *  a 4.5 m level floats in mid-air with daylight around its edge. */
function skirt(ring: MetreXY[], fromM: number, toM: number, thick: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  if (toM - fromM < 0.05) return out;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const g = new THREE.BoxGeometry(len, toM - fromM, thick);
    g.rotateY(Math.atan2(dy, dx));
    g.translate((a[0] + b[0]) / 2, (fromM + toM) / 2, -(a[1] + b[1]) / 2);
    out.push(g);
  }
  return out;
}

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

/** Even–odd point-in-ring. Local copy: coverage.ts's `pointInRing` is the same
 *  test, but this module is otherwise free of app imports and the helper is four
 *  lines. */
function inRing(x: number, y: number, ring: MetreXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- system builders ---------------------------------------------------------

/** Coffer grid spacing, metres — the bay rhythm of a coffered ceiling. */
const COFFER_STEP_M = 5.5;
/** How far the coffer beams hang below the ceiling plane. */
const COFFER_DROP_M = 0.34;
const COFFER_BEAM_W = 0.36;
/** Cap on coffer bays per unit so a 200 m concourse can't emit tens of thousands
 *  of beam boxes. Beyond it the ceiling stays a plain plane, which at that size
 *  is what you'd see from any realistic vantage anyway. */
const MAX_COFFERS_PER_UNIT = 220;

/** Structural joist spacing for an exposed ceiling, metres. */
const JOIST_STEP_M = 1.5;
const MAX_JOISTS_PER_UNIT = 90;

interface Batches {
  tile: THREE.BufferGeometry[];
  plaster: THREE.BufferGeometry[];
  deck: THREE.BufferGeometry[];
  metal: THREE.BufferGeometry[];
  /** Emissive cove strips, keyed by colour temperature so a lobby's cove and a
   *  gaming hall's cove glow at their own zone's temperature. */
  cove: Map<number, THREE.BufferGeometry[]>;
}

/** Coffered: a plaster soffit at `h`, crossed by downstand beams on a bay grid,
 *  with a warm cove strip tucked inside each beam run. */
function buildCoffered(
  ring: MetreXY[],
  h: number,
  kelvin: number,
  batches: Batches,
): void {
  const plane = ringPlane(ring, h);
  if (plane) batches.plaster.push(plane);

  const [minX, minY, maxX, maxY] = ringBBox(ring);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // Widen the bay on a large room so the grid ALWAYS lands, rather than silently
  // falling back to a blank plane exactly in the biggest, most-looked-at spaces.
  // sqrt(area/cap) yields ≈cap bays; the constant is the floor for small rooms.
  const step = Math.max(COFFER_STEP_M, Math.sqrt((spanX * spanY) / MAX_COFFERS_PER_UNIT));

  const coveGeos = batches.cove.get(kelvin) ?? [];
  const beamY = h - COFFER_DROP_M / 2;
  // Beams running both ways on the bay grid; each is clipped to the ring by
  // sampling its midpoint, which is exact for the rectilinear rooms these venues
  // are made of and degrades to "a beam is skipped" rather than "a beam escapes".
  for (let x = minX + step; x < maxX - 0.5; x += step) {
    if (!inRing(x, (minY + maxY) / 2, ring)) continue;
    const g = new THREE.BoxGeometry(COFFER_BEAM_W, COFFER_DROP_M, spanY);
    g.translate(x, beamY, -(minY + maxY) / 2);
    batches.plaster.push(g);
    const c = new THREE.BoxGeometry(0.07, 0.05, spanY * 0.98);
    c.translate(x, h - COFFER_DROP_M - 0.02, -(minY + maxY) / 2);
    coveGeos.push(c);
  }
  for (let y = minY + step; y < maxY - 0.5; y += step) {
    if (!inRing((minX + maxX) / 2, y, ring)) continue;
    const g = new THREE.BoxGeometry(spanX, COFFER_DROP_M, COFFER_BEAM_W);
    g.translate((minX + maxX) / 2, beamY, -y);
    batches.plaster.push(g);
    const c = new THREE.BoxGeometry(spanX * 0.98, 0.05, 0.07);
    c.translate((minX + maxX) / 2, h - COFFER_DROP_M - 0.02, -y);
    coveGeos.push(c);
  }
  batches.cove.set(kelvin, coveGeos);
}

/** Exposed: NO finished ceiling. A concrete deck at the structural height, steel
 *  joists under it, and a duct run down the long axis. The single clearest way to
 *  say "you are behind the scenes now". */
function buildExposed(ring: MetreXY[], structM: number, batches: Batches): void {
  const deck = ringPlane(ring, structM);
  if (deck) batches.deck.push(deck);

  const [minX, minY, maxX, maxY] = ringBBox(ring);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const alongX = spanX >= spanY; // joists span the SHORT way, like real framing
  const count = Math.ceil((alongX ? spanY : spanX) / JOIST_STEP_M);
  if (count > MAX_JOISTS_PER_UNIT) return;

  const jy = structM - 0.22;
  if (alongX) {
    for (let y = minY + JOIST_STEP_M / 2; y < maxY; y += JOIST_STEP_M) {
      if (!inRing((minX + maxX) / 2, y, ring)) continue;
      const g = new THREE.BoxGeometry(spanX, 0.3, 0.09);
      g.translate((minX + maxX) / 2, jy, -y);
      batches.metal.push(g);
    }
  } else {
    for (let x = minX + JOIST_STEP_M / 2; x < maxX; x += JOIST_STEP_M) {
      if (!inRing(x, (minY + maxY) / 2, ring)) continue;
      const g = new THREE.BoxGeometry(0.09, 0.3, spanY);
      g.translate(x, jy, -(minY + maxY) / 2);
      batches.metal.push(g);
    }
  }
  // One rectangular duct run down the long axis, slung below the joists.
  const duct = alongX
    ? new THREE.BoxGeometry(spanX * 0.9, 0.42, 0.55)
    : new THREE.BoxGeometry(0.55, 0.42, spanY * 0.9);
  duct.translate((minX + maxX) / 2, structM - 0.62, -(minY + maxY) / 2);
  batches.metal.push(duct);
}

// ---- public API --------------------------------------------------------------

/**
 * Build every ceiling on a floor.
 *
 * `structM` is the level's ceiling — the structural soffit everything hangs from.
 * Each unit gets the system its category (refined by id bucket) calls for, at the
 * lesser of its preferred height and `structM`, plus a skirt closing the step when
 * it sits lower. Batches are merged per material, so the whole floor's ceilings
 * cost a handful of draw calls.
 */
export function buildCeilings(patches: SceneFloorPatch[], structM: number): THREE.Object3D[] {
  const batches: Batches = { tile: [], plaster: [], deck: [], metal: [], cove: new Map() };

  for (const patch of patches) {
    if (patch.ring.length < 3) continue;
    if (patch.category === "outside") continue; // no ceiling over exterior areas
    const spec = ceilingSpecFor(patch.category, patch.id);
    const h = Math.min(spec.preferredM, structM);
    if (h <= 0.6) continue;

    if (spec.system === "exposed") {
      buildExposed(patch.ring, structM, batches);
      continue;
    }
    if (spec.system === "coffered") {
      buildCoffered(patch.ring, h, zoneFor(patch.category, patch.id).kelvin, batches);
    } else {
      const plane = ringPlane(patch.ring, h);
      if (plane) batches.tile.push(plane);
    }
    // Close the step up to the structural soffit. Plaster, because a bulkhead is
    // a built element, not a continuation of the tile grid.
    if (structM - h > 0.05) {
      batches.plaster.push(...skirt(patch.ring, h, structM, 0.12));
    }
  }

  const out: THREE.Object3D[] = [];
  const emit = (parts: THREE.BufferGeometry[], mat: THREE.Material, cast: boolean): void => {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    // Ceilings never cast: they hang between the coverage spotlights and the
    // floor, and a shadow-casting ceiling plane blacks out the very coverage the
    // tool exists to show (the same reason the original single plane had
    // castShadow off).
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    out.push(mesh);
  };

  emit(batches.tile, getMaterial("ceilingTile"), false);
  emit(batches.plaster, getPlasterMaterial(), false);
  emit(batches.deck, getDeckMaterial(), false);
  emit(batches.metal, getServiceMaterial(), false);
  for (const [kelvin, parts] of batches.cove) {
    emit(parts, getCoveMaterial(kelvin), false);
  }
  return out;
}

// ---- shared materials --------------------------------------------------------

let plasterMat: THREE.MeshStandardMaterial | null = null;
let serviceMat: THREE.MeshStandardMaterial | null = null;
let deckMat: THREE.MeshStandardMaterial | null = null;
const coveCache = new Map<number, THREE.MeshStandardMaterial>();

/** Structural soffit — raw concrete deck. DoubleSide because a horizontal face
 *  built by the rotateX(−90°) convention has its normal pointing UP, so a
 *  FrontSide material renders nothing at all to anyone standing under it. */
export function getDeckMaterial(): THREE.MeshStandardMaterial {
  if (!deckMat) {
    const src = getMaterial("concrete");
    deckMat = new THREE.MeshStandardMaterial({
      map: src.map,
      normalMap: src.normalMap,
      roughness: 0.95,
      metalness: 0,
      color: 0x9aa0a6,
      side: THREE.DoubleSide,
    });
    // Textures are BORROWED from the shared concrete material, which owns and
    // frees them — this material must never dispose them.
    deckMat.userData.shared = true;
  }
  return deckMat;
}

/** Painted plaster soffit — flatter and slightly warmer than the tile grid, so a
 *  coffered ceiling reads as a different construction from a suspended one. */
function getPlasterMaterial(): THREE.MeshStandardMaterial {
  if (!plasterMat) {
    plasterMat = new THREE.MeshStandardMaterial({
      color: 0xaea99e,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    plasterMat.userData.shared = true;
  }
  return plasterMat;
}

/** Galvanised services — joists, duct, hangers. */
function getServiceMaterial(): THREE.MeshStandardMaterial {
  if (!serviceMat) {
    serviceMat = new THREE.MeshStandardMaterial({ color: 0x8d939b, roughness: 0.5, metalness: 0.75 });
    serviceMat.userData.shared = true;
  }
  return serviceMat;
}

/** Emissive cove strip at a zone's colour temperature. */
function getCoveMaterial(kelvin: number): THREE.MeshStandardMaterial {
  let m = coveCache.get(kelvin);
  if (!m) {
    const c = kelvinColor(kelvin);
    m = new THREE.MeshStandardMaterial({
      color: c.clone().multiplyScalar(0.2),
      emissive: c,
      emissiveIntensity: 2.6,
      roughness: 1,
      metalness: 0,
    });
    m.userData.shared = true;
    coveCache.set(kelvin, m);
  }
  return m;
}

/** Dispose the shared ceiling materials. Call ONCE from the renderer's dispose(). */
export function disposeCeilings(): void {
  plasterMat?.dispose();
  plasterMat = null;
  serviceMat?.dispose();
  serviceMat = null;
  // dispose() on the deck frees the material only — its maps belong to the shared
  // concrete material and are freed by disposeMaterials().
  deckMat?.dispose();
  deckMat = null;
  for (const m of coveCache.values()) m.dispose();
  coveCache.clear();
}
