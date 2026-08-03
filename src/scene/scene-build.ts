// 3D scene description — pure, metre-space, renderer-agnostic.
//
// render.ts's sibling: Building + ordinal in, plain data out (prisms, wall
// segments, camera poses) — same inputs, different output shape (prisms vs
// GeoJSON). The Three.js adapter in src/editor3d/ maps this description to
// meshes; a future Babylon/WebGPU swap replaces only that adapter.
//
// FORBIDDEN IMPORTS (spec "Forbidden relationships", docs/3d-editor-spec.md,
// grep-audited): three.js, React, MapLibre, the zustand store. Only pure
// sibling modules (types / render tables / coverage constants / geo).

import type {
  AmenityKind,
  Building,
  CameraKind,
  Category,
  MetreXY,
  OpeningStyle,
  Unit,
} from "../types";
import {
  DEFAULT_FIXTURE_HEIGHT_M,
  FIXTURE_HEIGHT_M,
  OPENING_SIZE_M,
  UNIT_HEIGHT_M,
  levelCeilingM,
  resolveOpeningStyle,
  resolveStructureExtent,
} from "../render";
import { MOUNT_H } from "../coverage";
import { polygonArea } from "../geo";
import { occupantNamesByUnit } from "../occupants";

/** First-person eye height above the floor slab, metres (walk-mode camera). */
export const EYE_M = 1.7;

/** Synthesized wall thickness, metres. Walls have no thickness data field —
 *  a SceneWall is an infinitely thin segment; the renderer extrudes it as a
 *  box this deep so it reads as a solid wall at eye level. */
export const WALL_THICKNESS_M = 0.15;

/** Vertical FOV derived from a horizontal FOV at a 16:9 sensor aspect:
 *  vfov = 2·atan(tan(hfov/2) · 9/16), in degrees — the spec's default rule
 *  (OQ-2), used when Camera.vfovDeg is absent. Exact projection trig, valid
 *  only for hfov < 180° (tan(hfov/2) flips sign past that), so the input is
 *  clamped into [1, 179] first: the data model permits wide wedges
 *  (180 < fovDeg < 360) and hand-edited files reach here unvalidated; domes
 *  ignore vfov anyway (OQ-5 hemisphere gizmo). The 2D tilt band (vfovHalfRad
 *  in coverage.ts) clamps a LINEAR approximation of the same rule — a
 *  recorded OQ-2 divergence: the 3D frustum wants the true angle, the 2D
 *  band keeps its shipped numbers. */
export function deriveVfovDeg(fovDeg: number): number {
  const h = Math.min(179, Math.max(1, fovDeg));
  return (2 * Math.atan(Math.tan((h * Math.PI) / 360) * (9 / 16)) * 180) / Math.PI;
}

/** Drop below the ceiling for a ceiling-mounted camera with no authored height. */
const CEILING_MOUNT_DROP_M = 0.6;
/** Practical ceiling for an unauthored mount: a 12 m atrium does not put its
 *  cameras 11.4 m up — installers work off catwalks/poles around this height. */
const MAX_DEFAULT_MOUNT_M = 7;

/**
 * Display mount height for a camera with no authored `mountM`, given the floor's
 * ceiling. Cameras are ceiling-mounted hardware: pinning every unauthored camera
 * to the flat MOUNT_H (4 m) left them floating mid-air in a 7 m casino hall and
 * reading as "too low to the ground" in walk mode.
 *
 * At the 3.2 m default ceiling this returns the legacy value (4 m clamped to
 * 3.1 m by the caller), so existing venues render unchanged. 3D-ONLY: the 2D
 * tiltBand keeps using the raw stored value — and is null for untilted/dome
 * cameras anyway, so coverage geometry never moves because of this.
 */
export function defaultMountM(ceilingM: number): number {
  return Math.min(
    Math.max(MOUNT_H, ceilingM - CEILING_MOUNT_DROP_M),
    MAX_DEFAULT_MOUNT_M,
  );
}

/** A vertical extrusion of an open metre ring, baseM..topM above the floor
 *  slab. `kind` is the source object's category/kind string — the renderer's
 *  material lookup key, never geometry. */
export interface ScenePrism {
  id: string;
  kind: string;
  ring: MetreXY[];
  baseM: number;
  topM: number;
}

/** A hole cut through a wall — a doorway, cased opening or shopfront. Positioned
 *  ALONG the wall (`atM` is the distance from the wall's `a` end to the hole's
 *  centre), so the renderer never has to re-solve which wall an opening belongs
 *  to or where on it the opening sits. */
export interface SceneWallHole {
  id: string;
  style: OpeningStyle;
  /** Centre of the hole, metres from the wall's `a` end. */
  atM: number;
  widthM: number;
  /** Sill height. 0 for every current style (they all reach the floor); the field
   *  exists so an interior window is a data change, not a geometry change. */
  sillM: number;
  /** Head height above the floor. */
  headM: number;
  /** Which side of the wall faces OUT of the host unit, as a sign on the wall's
   *  left normal (−dy, dx): +1 means the left normal points away from the host,
   *  −1 means the right normal does. Solved here because this module has the host
   *  polygon and the renderer does not — it decides which way a door leaf swings,
   *  and which face of a shopfront the signage is lettered on. Getting it wrong
   *  puts every shop's sign inside the shop. */
  outward: 1 | -1;
  /** Occupant/unit name to letter onto the header above a storefront. Absent for
   *  every other style — a signage band over an office door is not architecture,
   *  it's noise. */
  label?: string;
}

/** One wall segment, floor (0) to `topM`. Thin by convention — the renderer
 *  applies WALL_THICKNESS_M. */
export interface SceneWall {
  a: MetreXY;
  b: MetreXY;
  topM: number;
  /** Finish key — the host unit's category, or "envelope" for the building
   *  outline. The renderer's material lookup; never geometry. */
  finish: Category | "envelope";
  /** Openings cut through this wall, in ascending `atM`. Usually empty: the
   *  renderer keeps hole-free walls on the fast instanced path. */
  holes: SceneWallHole[];
}

/** A flat per-unit floor patch (carpet colour by category) laid over the
 *  slab so the space reads at eye level. */
export interface SceneFloorPatch {
  id: string;
  category: Category;
  ring: MetreXY[];
}

/** A CCTV camera pose with every absent-able field resolved — the renderer
 *  never reads a `?? default` again. Angle conventions are the stored ones
 *  (types.ts): headingDeg from +x CCW (atan2-native), tiltDeg BELOW
 *  horizontal, rollDeg CW looking along the view direction. */
export interface SceneCameraPose {
  id: string;
  name: string;
  at: MetreXY;
  mountM: number;
  headingDeg: number;
  tiltDeg: number;
  rollDeg: number;
  fovDeg: number;
  vfovDeg: number;
  rangeM: number;
  kind: CameraKind;
  mount: "ceiling" | "wall" | "column";
}

/** A point-of-interest marker resolved for the 3D scene. Amenities are already
 *  authored in every venue (exits, ATMs, info desks, first aid) and produced NO
 *  geometry at all — they were a 2D badge and nothing else. They are the cheapest
 *  honest density in the building, because the positions are real data rather
 *  than scattered decoration. */
export interface SceneAmenity {
  id: string;
  kind: AmenityKind;
  at: MetreXY;
}

/** Slab thickness between a floor's ceiling and the floor plate above it, metres.
 *  The data model stores ceilings, not slab levels, so floor-to-floor is derived:
 *  storeyHeightM = this level's ceiling + SLAB_M. Needed the moment more than one
 *  floor is on screen at once. */
export const SLAB_M = 0.45;

/** Everything the 3D renderer needs for one floor, in local metres.
 *  `footprintRing` is null when the ordinal has no usable footprint polygon
 *  (no slab, no exterior envelope). */
export interface Scene3D {
  ordinal: number;
  ceilingM: number;
  footprintRing: MetreXY[] | null;
  floorPatches: SceneFloorPatch[];
  wallSegs: SceneWall[];
  slabPrisms: ScenePrism[];
  structurePrisms: ScenePrism[];
  fixturePrisms: ScenePrism[];
  amenities: SceneAmenity[];
  cameras: SceneCameraPose[];
  /** Atrium / light-well outlines cut through THIS floor's plate. The renderer
   *  subtracts them from the floor patches and the slab, and from the ceiling of
   *  the floor below. Empty for every venue that has none. */
  voids: MetreXY[][];
  /** Voids belonging to the floor ABOVE, which cut THIS floor's ceiling. A void is
   *  authored once, on the plate it removes, but it opens two surfaces: the plate
   *  itself and the ceiling under it. Resolving both here keeps the renderer from
   *  needing the whole Building. */
  ceilingVoids: MetreXY[][];
  /** Floor-to-floor rise of this level: ceilingM + SLAB_M. The offset a
   *  neighbouring floor is drawn at when a void makes it visible. */
  storeyHeightM: number;
}

/** True when `ring` cannot form a real face: fewer than 3 vertices or ~zero
 *  area (collapsed / self-touching outlines emit no geometry). Same threshold
 *  collectWalls (coverage.ts) uses, so 2D and 3D skip the same polygons. */
function degenerate(ring: MetreXY[]): boolean {
  return ring.length < 3 || polygonArea(ring) < 1e-6;
}

/** Quantisation for wall-endpoint identity, metres. Demo geometry carries 2-decimal
 *  coordinates and hand-drawn geometry snaps to a grid, so a millimetre bucket
 *  merges genuinely shared edges without ever merging distinct ones. */
const WALL_EPS = 1e-3;

const qz = (v: number): number => Math.round(v / WALL_EPS);

/** Order-independent key for an undirected edge, so unit A's edge (p,q) and the
 *  abutting unit B's edge (q,p) resolve to the SAME wall. */
function edgeKey(a: MetreXY, b: MetreXY): string {
  const ka = `${qz(a[0])},${qz(a[1])}`;
  const kb = `${qz(b[0])},${qz(b[1])}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Finish precedence when two units share a wall. The more specific finish wins,
 *  so a shop's partition against a corridor reads as the shop's wall rather than
 *  depending on which unit the loop happened to visit first. `envelope` outranks
 *  everything: an exterior wall is an exterior wall from both sides. */
const FINISH_RANK: Record<string, number> = {
  envelope: 100,
  retail: 60,
  lobby: 55,
  room: 50,
  office: 45,
  restroom: 40,
  mechanical: 35,
  storage: 30,
  stairs: 25,
  elevator: 25,
  corridor: 10,
  outside: 0,
};

/** Accumulates wall segments, MERGING coincident edges.
 *
 *  Every unit pushes all of its own edges, so a partition shared by two rooms was
 *  previously emitted TWICE — two boxes occupying the same volume, giving a wall
 *  of doubled apparent thickness and z-fighting down every shared face in the
 *  building. Keying edges undirected collapses those to one wall, which also means
 *  an opening cut into it is cut once and is open from both sides. */
class WallSet {
  private readonly byKey = new Map<string, SceneWall>();

  add(a: MetreXY, b: MetreXY, topM: number, finish: Category | "envelope"): void {
    const key = edgeKey(a, b);
    const existing = this.byKey.get(key);
    if (existing) {
      // Keep the taller wall and the more specific finish; a shared edge is one
      // wall, and it should be as tall as the taller space asks for.
      existing.topM = Math.max(existing.topM, topM);
      if ((FINISH_RANK[finish] ?? 0) > (FINISH_RANK[existing.finish] ?? 0)) existing.finish = finish;
      return;
    }
    this.byKey.set(key, { a, b, topM, finish, holes: [] });
  }

  get(a: MetreXY, b: MetreXY): SceneWall | undefined {
    return this.byKey.get(edgeKey(a, b));
  }

  all(): SceneWall[] {
    return [...this.byKey.values()];
  }
}

/** Add every edge of an open ring (edge i -> (i+1)%n — the Unit.polygon closing
 *  convention, matching collectWalls). */
function pushEdges(out: WallSet, ring: MetreXY[], topM: number, finish: Category | "envelope"): void {
  for (let i = 0; i < ring.length; i++) {
    out.add(ring[i], ring[(i + 1) % ring.length], topM, finish);
  }
}

/** Squared distance from `p` to segment `a`–`b`, plus the clamped projection
 *  parameter t ∈ [0,1] of the foot of the perpendicular. */
function segDist2(p: MetreXY, a: MetreXY, b: MetreXY): { d2: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { d2: (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2, t: 0 };
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const fx = a[0] + dx * t;
  const fy = a[1] + dy * t;
  return { d2: (p[0] - fx) ** 2 + (p[1] - fy) ** 2, t };
}

/** Area-weighted centroid of an open ring. Local to this module — geo.ts's
 *  polygonCentroid is the same maths, but importing it here would be the third
 *  copy of a two-line helper rather than the second. */
function ringCentroid(ring: MetreXY[]): MetreXY {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a2) < 1e-9) {
    // Degenerate ring: fall back to the vertex mean rather than dividing by ~0.
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

/**
 * Default clear width for an opening, given its style and the wall it sits in.
 *
 * A door is a door at any wall length — 0.95 m whether it's in a 3 m partition or
 * a 40 m one. But a shopfront is not a fixed object: it is THE BAY, and a mall
 * tenant glazes essentially its whole frontage. A fixed 6.5 m default put a
 * kiosk-sized window in the middle of a 60 m anchor-store wall, which read as a
 * service hatch rather than as a shop. Cased openings scale for the same reason
 * at a lower ratio: a portal between two casino halls is generous but is still a
 * portal, not a missing wall.
 */
function defaultWidthM(style: OpeningStyle, base: number, wallLen: number): number {
  if (style === "storefront") return Math.min(Math.max(wallLen * 0.78, base), 26);
  if (style === "opening") return Math.min(Math.max(wallLen * 0.4, base), 14);
  if (style === "gate") return Math.min(Math.max(wallLen * 0.3, base), 9);
  return base;
}

/** Minimum jamb left at each end of a wall, metres — a hole is never allowed to
 *  reach a corner, because a doorway flush with a corner has no wall to hang its
 *  frame on and reads as a missing wall rather than a door. */
const MIN_JAMB_M = 0.35;

/**
 * Cut every opening on this floor into the wall it belongs to.
 *
 * An `Opening` stores only a point (`at`) and its host unit, so the wall and the
 * position along it are SOLVED here: take the host unit's polygon, find the edge
 * whose perpendicular distance to `at` is smallest, and convert the projection
 * parameter into a distance along the merged wall. Solving it once here means the
 * renderer, the door furniture and any future consumer all agree.
 *
 * Openings whose host unit is missing, is on another floor, or has no wall (a low
 * circulation slab) are skipped — the same silent skip the rest of this module
 * applies to degenerate geometry.
 */
function cutOpenings(
  b: Building,
  ordinal: number,
  walls: WallSet,
  unitsById: Map<string, Unit>,
  ceilingM: number,
): void {
  const labels = occupantNamesByUnit(b);
  for (const op of b.openings) {
    const unit = unitsById.get(op.unit);
    if (!unit || unit.ordinal !== ordinal || degenerate(unit.polygon)) continue;
    // Low-slab categories (corridor/lobby) emit no walls, so there is nothing to
    // cut — their "doors" are notional graph edges across an open threshold.
    if (UNIT_HEIGHT_M[unit.category] < 3) continue;

    // Nearest edge of the host unit.
    const ring = unit.polygon;
    let bestI = -1;
    let bestD2 = Infinity;
    let bestT = 0;
    for (let i = 0; i < ring.length; i++) {
      const { d2, t } = segDist2(op.at, ring[i], ring[(i + 1) % ring.length]);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
        bestT = t;
      }
    }
    if (bestI < 0) continue;
    const a = ring[bestI];
    const c = ring[(bestI + 1) % ring.length];
    const wall = walls.get(a, c);
    if (!wall) continue;

    const wallLen = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (wallLen < 2 * MIN_JAMB_M + 0.3) continue; // too short to hold any opening

    const style = resolveOpeningStyle(op.style, op.kind, unit.category);
    const size = OPENING_SIZE_M[style];
    // Width is clamped so the hole always leaves a jamb at both ends. A 6.5 m
    // shopfront default in a 4 m bay becomes a 3.3 m shopfront rather than
    // deleting the wall.
    const maxW = Math.max(0.3, wallLen - 2 * MIN_JAMB_M);
    const widthM = Math.min(op.widthM ?? defaultWidthM(style, size.widthM, wallLen), maxW);
    // Head is clamped under the wall so a 3 m storefront in a 2.6 m room becomes a
    // full-height opening instead of a hole through the ceiling.
    const headM = Math.min(op.heightM ?? size.heightM, Math.min(wall.topM, ceilingM) - 0.12);
    if (headM <= 0.5) continue;

    // The wall may be stored a→c or c→a (whichever unit reached it first), so map
    // the projection parameter into THAT wall's own direction before using it.
    const sameDir = qz(wall.a[0]) === qz(a[0]) && qz(wall.a[1]) === qz(a[1]);
    const tAlong = sameDir ? bestT : 1 - bestT;
    const half = widthM / 2;
    const atM = Math.min(Math.max(tAlong * wallLen, MIN_JAMB_M + half), wallLen - MIN_JAMB_M - half);

    // Overlap guard: two openings solved onto the same wall (a shop with a door
    // either side of a column) must not merge into one hole that swallows the pier
    // between them. Skip the later one rather than emitting crossed geometry.
    if (wall.holes.some((h) => Math.abs(h.atM - atM) < (h.widthM + widthM) / 2)) continue;

    // Which side of the wall is OUTSIDE the host unit: test the host's centroid
    // against the wall's left normal. The centroid is inside the polygon for the
    // convex-ish rooms these venues are made of, so its side is the host's side
    // and the opposite one is the concourse.
    const wdx = wall.b[0] - wall.a[0];
    const wdy = wall.b[1] - wall.a[1];
    const cen = ringCentroid(ring);
    const mx = (wall.a[0] + wall.b[0]) / 2;
    const my = (wall.a[1] + wall.b[1]) / 2;
    // left normal (−wdy, wdx) · (centroid − midpoint)
    const sideOfHost = -wdy * (cen[0] - mx) + wdx * (cen[1] - my);
    const outward: 1 | -1 = sideOfHost > 0 ? -1 : 1;

    wall.holes.push({
      id: op.id,
      style,
      atM,
      widthM,
      sillM: 0,
      headM,
      outward,
      label: style === "storefront" ? labels.get(unit.id) ?? unit.name : undefined,
    });
  }
  for (const w of walls.all()) w.holes.sort((x, y) => x.atM - y.atM);
}

/**
 * Build the renderer-agnostic 3D scene for one floor.
 *
 * Derivations (all display-time — nothing here is written back to the data):
 * - `ceilingM`: levelCeilingM(b, ordinal) — authored Level.ceilingM, absent ⇒
 *   DEFAULT_CEILING_M.
 * - `footprintRing`: the ordinal's footprint polygon (≥ 3 verts) else null.
 * - `floorPatches`: every unit on the ordinal with a ≥ 3-vertex polygon.
 * - `wallSegs`: edges of full-height units (UNIT_HEIGHT_M ≥ 3) plus the
 *   footprint ring (exterior envelope), all rising to `ceilingM`. Mirrors
 *   collectWalls (coverage.ts) geometry — same edge convention, same
 *   degenerate skip, same footprint envelope — so 2D and 3D occlude against
 *   the same segments. Low-slab unit edges (corridor/lobby) become
 *   `slabPrisms` instead of walls: the recorded OQ-6 divergence (2D keeps
 *   treating every unit edge as a blocker).
 * - `slabPrisms`: units with 0 < UNIT_HEIGHT_M < 3, floor to that height.
 * - `structurePrisms`: structures on the ordinal. topM = the authored heightM
 *   clamped into [0, `ceilingM`] at render time (the stored value is
 *   preserved — spec failure-mode rule: the user may raise the ceiling next);
 *   absent ⇒ full height. baseM absent ⇒ 0, clamped into [0, topM]
 *   (degenerate-safe). Same clamps as structuresToGeoJSON, so 2D and 3D
 *   render identical prisms even from hand-edited negative values.
 * - `fixturePrisms`: fixtures on the ordinal at their synthesized display
 *   height (FIXTURE_HEIGHT_M, unknown kinds ⇒ DEFAULT_FIXTURE_HEIGHT_M);
 *   zero-height kinds (e.g. parking) emit nothing.
 * - `cameras`: every camera on the ordinal, absents resolved. mountM (absent
 *   ⇒ MOUNT_H) is display-clamped into [0.1, ceilingM − 0.1] so the gizmo
 *   stays under the authored ceiling — a deliberate divergence from the 2D
 *   tiltBand, which uses the raw stored value (clamped only at 0).
 */
export function build3dScene(b: Building, ordinal: number): Scene3D {
  const ceilingM = levelCeilingM(b, ordinal);

  const fp = b.footprints?.find((f) => f.ordinal === ordinal && f.polygon.length >= 3);
  const footprintRing = fp?.polygon ?? null;

  const floorPatches: SceneFloorPatch[] = [];
  const walls = new WallSet();
  const slabPrisms: ScenePrism[] = [];
  const unitsById = new Map<string, Unit>();
  for (const u of b.units) {
    unitsById.set(u.id, u);
    if (u.ordinal !== ordinal) continue;
    if (u.polygon.length >= 3) {
      floorPatches.push({ id: u.id, category: u.category, ring: u.polygon });
    }
    if (degenerate(u.polygon)) continue;
    const h = UNIT_HEIGHT_M[u.category];
    if (h >= 3) {
      pushEdges(walls, u.polygon, ceilingM, u.category);
    } else if (h > 0) {
      slabPrisms.push({ id: u.id, kind: u.category, ring: u.polygon, baseM: 0, topM: h });
    }
    // h === 0 (outside): floor patch only — never extruded.
  }
  if (footprintRing) pushEdges(walls, footprintRing, ceilingM, "envelope");
  cutOpenings(b, ordinal, walls, unitsById, ceilingM);
  const wallSegs = walls.all();

  const structurePrisms: ScenePrism[] = [];
  for (const s of b.structures ?? []) {
    if (s.ordinal !== ordinal || degenerate(s.polygon)) continue;
    // resolveStructureExtent is the SINGLE source shared with structuresToGeoJSON
    // (render.ts), so the 2D extrusion and this 3D prism can never disagree on a
    // structure's height (heightM ceiling-capped, baseM clamped into [0, topM]).
    const { baseM, topM } = resolveStructureExtent(s.heightM, s.baseM, ceilingM);
    structurePrisms.push({ id: s.id, kind: s.kind, ring: s.polygon, baseM, topM });
  }

  const fixturePrisms: ScenePrism[] = [];
  for (const f of b.fixtures ?? []) {
    if (f.ordinal !== ordinal || degenerate(f.polygon)) continue;
    const topM = FIXTURE_HEIGHT_M[f.kind] ?? DEFAULT_FIXTURE_HEIGHT_M;
    if (topM <= 0) continue;
    fixturePrisms.push({ id: f.id, kind: f.kind, ring: f.polygon, baseM: 0, topM });
  }

  const voids: MetreXY[][] = [];
  for (const v of b.voids ?? []) {
    if (v.ordinal !== ordinal || degenerate(v.polygon)) continue;
    voids.push(v.polygon);
  }

  const ceilingVoids: MetreXY[][] = [];
  for (const v of b.voids ?? []) {
    if (v.ordinal !== ordinal + 1 || degenerate(v.polygon)) continue;
    ceilingVoids.push(v.polygon);
  }

  const amenities: SceneAmenity[] = [];
  for (const a of b.amenities ?? []) {
    if (a.ordinal !== ordinal) continue;
    amenities.push({ id: a.id, kind: a.kind, at: a.at });
  }

  const cameras: SceneCameraPose[] = [];
  for (const c of b.cameras) {
    if (c.ordinal !== ordinal) continue;
    cameras.push({
      id: c.id,
      name: c.name,
      at: c.at,
      mountM: Math.max(0.1, Math.min(c.mountM ?? defaultMountM(ceilingM), ceilingM - 0.1)),
      headingDeg: c.heading,
      tiltDeg: c.tiltDeg ?? 0,
      rollDeg: c.rollDeg ?? 0,
      fovDeg: c.fovDeg,
      // Authored override clamped into the same sane (0°, 180°) window the 2D
      // twin (vfovHalfRad) enforces — hand-edited files reach here unvalidated.
      vfovDeg:
        c.vfovDeg != null
          ? Math.min(179, Math.max(1, c.vfovDeg))
          : deriveVfovDeg(c.fovDeg),
      rangeM: c.rangeM,
      kind: c.kind,
      mount: c.mount ?? "ceiling",
    });
  }

  return {
    ordinal,
    ceilingM,
    footprintRing,
    floorPatches,
    wallSegs,
    slabPrisms,
    structurePrisms,
    fixturePrisms,
    amenities,
    cameras,
    voids,
    ceilingVoids,
    storeyHeightM: ceilingM + SLAB_M,
  };
}
