// Camera coverage geometry — pure, metre-space, no React / no MapLibre.
// Same discipline as geo.ts / astar.ts: testable in isolation.
//
// P4 implemented the naive radial FOV fallback (`sectorRing`, kept below as the
// documented fallback). P5 replaces the lie with real line-of-sight:
// `collectWalls` + `raySegmentT` + `computeVisibility` produce an occlusion-
// clipped visibility polygon per camera. P6 unions those honest polygons into
// coverage / blind-spot analysis (`computeCoverage`). The rendering source is
// shared, so P4→P5 is a pure geometry swap with zero UI churn.

import type { Building, Camera, MetreXY } from "./types";
import { polygonArea } from "./geo";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";

/** Number of arc samples used to round the range boundary of a sector.
 *  ~4° per step reads as a smooth arc without exploding vertex count. */
const ARC_STEP_DEG = 4;

/**
 * Naive radial FOV ring for one camera, in local metres.
 *
 * NOT occlusion-aware — the wedge ignores walls (P4 fallback geometry).
 *
 * - `dome` (or fovDeg >= 360): a full circle ring of arc points around `at`
 *   (no apex — the ring is closed by convention like a Unit polygon).
 * - `fixed` / `ptz`: `[at, ...arc points]` — the camera apex plus an arc of
 *   points at `rangeM` swept across `fovDeg`, centred on `heading`. The wedge
 *   closes back through the apex.
 *
 * Heading convention: degrees from +x axis, CCW positive (atan2-native).
 * Returns an open ring (no repeated last point), matching Unit.polygon.
 */
export function sectorRing(cam: Camera): MetreXY[] {
  const [cx, cy] = cam.at;
  const R = cam.rangeM;
  const full = cam.kind === "dome" || cam.fovDeg >= 360;
  const h = (cam.heading * Math.PI) / 180;
  const half = full ? Math.PI : (cam.fovDeg * Math.PI) / 180 / 2;

  const span = 2 * half; // total angular width in radians
  const steps = Math.max(1, Math.ceil(span / ((ARC_STEP_DEG * Math.PI) / 180)));

  const arc: MetreXY[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = h - half + (span * i) / steps;
    arc.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
  }

  if (full) {
    // Closed star/circle ring around the apex; drop the duplicated last point
    // (i === steps re-hits the i === 0 angle for a full sweep).
    arc.pop();
    return arc;
  }
  // Sector: apex + arc fan; the wedge closes through the apex.
  return [[cx, cy], ...arc];
}

/**
 * Even-odd point-in-polygon test (ray casting) on an OPEN ring — no repeated
 * last point, same convention as Unit.polygon and VisibilityPolygon.ring.
 *
 * Cast a ray from `pt` along +x and count edge crossings; odd ⇒ inside. Points
 * exactly on an edge are boundary cases (may report either way) — acceptable
 * for a click-hit test where the user is clicking interior space, not tracing
 * an edge to the pixel.
 */
export function pointInRing(pt: MetreXY, ring: MetreXY[]): boolean {
  const [px, py] = pt;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// P5 — Wall occlusion (exact endpoint-casting visibility polygon)
// ---------------------------------------------------------------------------

/** One camera's occlusion-clipped line-of-sight footprint, in local metres. */
export interface VisibilityPolygon {
  cameraId: string;
  ordinal: number;
  /** Closed-by-convention open ring (no repeated last pt), like Unit.polygon. */
  ring: MetreXY[];
}

/** Per-floor coverage analysis result (P6). All rings in local metres. */
export interface CoverageResult {
  ordinal: number;
  coveredRings: MetreXY[][]; // union of visibility polys, clipped to floor (render green)
  blindRings: MetreXY[][]; // floor minus covered (render red)
  floorAreaM2: number;
  coveredAreaM2: number;
  coveragePct: number; // coveredAreaM2 / floorAreaM2, 0..1
}

/** A wall segment a camera can be occluded by. */
export interface Segment {
  a: MetreXY;
  b: MetreXY;
}

const ARC_RAD = (ARC_STEP_DEG * Math.PI) / 180;
/** Corner-ray epsilon (radians): the ±offset rays slip just past a corner so
 *  the fan lands on whatever wall is behind — the "peek around the corner". */
const EPS_RAD = 1e-4;

/**
 * All wall segments a camera on `ordinal` can be occluded by: every edge of
 * every unit polygon on that floor. Degenerate rings (near-zero area) are
 * skipped so self-touching / zero-area polygons don't emit spurious rays.
 *
 * Doors are NOT punched out — a unit outline is a closed ring, so a camera does
 * not see through an open doorway. This makes coverage conservatively
 * *under*-reported (the safe direction for a security tool). Accepted v1 limit.
 */
export function collectWalls(building: Building, ordinal: number): Segment[] {
  const segs: Segment[] = [];
  for (const u of building.units) {
    if (u.ordinal !== ordinal) continue;
    const p = u.polygon;
    if (p.length < 3 || polygonArea(p) < 1e-6) continue;
    for (let i = 0; i < p.length; i++) {
      segs.push({ a: p[i], b: p[(i + 1) % p.length] });
    }
  }
  return segs;
}

/**
 * Ray/segment intersection distance. Ray from `o` in unit direction `d`;
 * segment `A→B`. Solves `o + t·d = A + u·(B−A)` and returns `t` (metres along
 * the ray, since `d` is a unit vector) when the hit is ahead of the origin
 * (`t ≥ 0`) and lands on the segment (`u ∈ [0,1]`); otherwise null.
 */
export function raySegmentT(o: MetreXY, d: MetreXY, A: MetreXY, B: MetreXY): number | null {
  const ex = B[0] - A[0];
  const ey = B[1] - A[1];
  const denom = d[0] * ey - d[1] * ex;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = ((A[0] - o[0]) * ey - (A[1] - o[1]) * ex) / denom;
  const u = ((A[0] - o[0]) * d[1] - (A[1] - o[1]) * d[0]) / denom;
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}

/** Wrap an angle into (-π, π]. */
function wrapPi(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/**
 * Exact occlusion-clipped visibility polygon for one camera, in local metres.
 *
 * Endpoint casting (NOT fixed-step angular sampling): a ray is aimed at every
 * wall corner inside the sector — plus a hair (±EPS) to either side so the fan
 * snaps precisely onto occluding edges and peeks past corners — and every ray
 * is cast to the nearest wall hit, capped at `rangeM`. A sparse ~4° arc pass
 * rounds the unobstructed range boundary (where there's no occluder to snap to)
 * and the sector boundary rays (±half) pin the wedge edges.
 *
 *  - `dome` / fovDeg ≥ 360 → the hits form a closed star ring around `at`
 *    (no apex, full 2π, sector clip disabled).
 *  - `fixed` / `ptz` → `[at, ...hits]`: apex + fan, the wedge closing through
 *    the camera. Sector clip is implicit (only rays within ±half are cast).
 *
 * Heading convention: degrees from +x axis, CCW positive (atan2-native).
 * Returns an open ring (no repeated last point), matching Unit.polygon.
 */
export function computeVisibility(cam: Camera, walls: Segment[]): MetreXY[] {
  const at = cam.at;
  const full = cam.kind === "dome" || cam.fovDeg >= 360;
  const h = (cam.heading * Math.PI) / 180;
  const half = full ? Math.PI : (cam.fovDeg * Math.PI) / 180 / 2;
  const R = cam.rangeM;

  // --- gather candidate ray angles, as offsets `rel` from heading h ---
  const rels: number[] = [];
  if (!full) rels.push(-half, half); // exact sector boundary rays

  // sparse arc rays to smooth the free (unobstructed) range boundary
  const span = 2 * half;
  const steps = Math.max(1, Math.ceil(span / ARC_RAD));
  for (let i = 0; i <= steps; i++) {
    if (full && i === steps) continue; // +π duplicates -π for a full sweep
    rels.push(-half + (span * i) / steps);
  }

  // exact corner rays: every wall endpoint inside the sector, ± epsilon
  for (const seg of walls) {
    for (const p of [seg.a, seg.b]) {
      const rel = wrapPi(Math.atan2(p[1] - at[1], p[0] - at[0]) - h);
      if (full || Math.abs(rel) <= half + EPS_RAD) {
        rels.push(rel - EPS_RAD, rel, rel + EPS_RAD);
      }
    }
  }

  // --- for each ray (ascending, deduped), find the nearest hit within range ---
  rels.sort((x, y) => x - y);
  const hits: MetreXY[] = [];
  let last = NaN;
  for (const rel of rels) {
    if (rel === last) continue;
    last = rel;
    const a = h + rel;
    const dir: MetreXY = [Math.cos(a), Math.sin(a)];
    let best = R;
    for (const seg of walls) {
      const t = raySegmentT(at, dir, seg.a, seg.b);
      if (t != null && t < best) best = t;
    }
    hits.push([at[0] + dir[0] * best, at[1] + dir[1] * best]);
  }

  return full ? hits : [at, ...hits];
}

// ---------------------------------------------------------------------------
// P6 — Coverage + blind-spot computation (boolean geometry via polygon-clipping)
// ---------------------------------------------------------------------------
//
// Runs entirely in metre-space (not lng/lat) so union/difference/area are
// distortion-free; results are projected to lng/lat only for rendering.
// HARD CONSTRAINT: coverage consumes P5's occlusion-clipped VisibilityPolygon
// rings — NEVER radial cones. Cameras contribute exactly what they can see.

/** Close an open metre ring (repeat the first point) for polygon-clipping,
 *  which expects closed rings. */
function closedRing(ring: MetreXY[]): Ring {
  const r: Ring = ring.map((p) => [p[0], p[1]]);
  const f = r[0];
  const l = r[r.length - 1];
  if (r.length > 0 && (f[0] !== l[0] || f[1] !== l[1])) r.push([f[0], f[1]]);
  return r;
}

/** Drop near-duplicate and near-collinear vertices from an open ring. Occlusion
 *  visibility fans carry hundreds of such points (consecutive rays grazing one
 *  wall are collinear; the ±epsilon corner rays are near-coincident); collapsing
 *  them to the real corners is geometrically negligible but keeps the fragile
 *  boolean-geometry library fast and robust. */
function simplifyRing(ring: MetreXY[], tol = 0.03): MetreXY[] {
  if (ring.length < 3) return ring;
  const dedup = ring.filter((p, i) => {
    const q = ring[(i - 1 + ring.length) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > tol;
  });
  if (dedup.length < 3) return ring;
  const out: MetreXY[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = dedup[(i - 1 + dedup.length) % dedup.length];
    const b = dedup[i];
    const c = dedup[(i + 1) % dedup.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > tol) out.push(b);
  }
  return out.length >= 3 ? out : dedup;
}

/** Re-simplify every ring of a MultiPolygon (used between fold-union steps). */
function mpSimplify(mp: MultiPolygon): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => closedRing(simplifyRing(openRing(ring)))));
}

/**
 * Robust union of many rings. polygon-clipping is numerically fragile on large
 * batches of high-vertex, near-degenerate polygons (visibility fans): a single
 * `union([...all])` can throw ("Unable to pop SweepEvent") or overflow the stack.
 * So: simplify each ring, then FOLD the union pairwise, re-simplifying the
 * accumulator each step and skipping any polygon whose merge throws. This keeps
 * coverage correct-enough and — critically — never crashes the app.
 */
function unionRings(rings: MetreXY[][]): MultiPolygon {
  const mps = rings
    .map((r) => simplifyRing(r))
    .filter((r) => r.length >= 3)
    .map((r): MultiPolygon => [[closedRing(r)]]);
  let acc: MultiPolygon | null = null;
  for (const m of mps) {
    if (!acc) {
      acc = m;
      continue;
    }
    try {
      acc = mpSimplify(polygonClipping.union(acc, m));
    } catch {
      /* skip the polygon that breaks the sweep-line; coverage is ~unchanged */
    }
  }
  return acc ?? [];
}

/** A polygon-clipping Ring is closed (last == first); polygonArea (geo.ts)
 *  wants an open ring, so strip the closing duplicate before measuring. */
function openRing(ring: Ring): MetreXY[] {
  const n = ring.length;
  const closed =
    n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const src = closed ? ring.slice(0, -1) : ring;
  return src.map((p) => [p[0], p[1]] as MetreXY);
}

/** Signed multipolygon area: Σ outer-ring area − Σ hole-ring area, using the
 *  imported shoelace `polygonArea` per ring (ring 0 of each polygon = outer). */
function mpArea(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      const area = polygonArea(openRing(ring));
      a += i === 0 ? area : -area;
    });
  }
  return a;
}

/** Flatten a MultiPolygon's outer + hole rings to open MetreXY rings for
 *  rendering (each ring projected + drawn as its own fill polygon). In the rare
 *  case a result has holes, those hole rings render as solid fills — an accepted
 *  v1 cosmetic limit; the AREA math above stays exact (holes subtract). */
function mpRings(mp: MultiPolygon): MetreXY[][] {
  const out: MetreXY[][] = [];
  for (const poly of mp) for (const ring of poly) out.push(openRing(ring));
  return out;
}

/**
 * Per-floor coverage analysis from occlusion-clipped visibility polygons.
 *
 *  1. floor   = union of every unit polygon on `ordinal` (the space that SHOULD
 *     be seen — blind spots are meaningful floor a camera misses, not exterior).
 *  2. covered = union of every camera's P5 visibility ring on this floor.
 *  3. coveredInFloor = covered ∩ floor — clips the range arc that spills through
 *     an exterior wall so coverage-% counts only area inside the building.
 *  4. blind   = floor − covered.
 *
 * coveragePct = coveredAreaM2 / floorAreaM2, both measured after clipping.
 */
export function computeCoverage(
  building: Building,
  ordinal: number,
  visPolys: VisibilityPolygon[],
): CoverageResult {
  const unitRings: MetreXY[][] = [];
  for (const u of building.units) {
    if (u.ordinal !== ordinal) continue;
    if (u.polygon.length < 3 || polygonArea(u.polygon) < 1e-6) continue;
    unitRings.push(u.polygon);
  }
  const coverRings = visPolys
    .filter((v) => v.ordinal === ordinal && v.ring.length >= 3)
    .map((v) => v.ring);

  const floor = unionRings(unitRings);
  const covered = unionRings(coverRings);

  // intersection/difference can also throw on fragile inputs — guard both.
  let coveredInFloor: MultiPolygon = [];
  if (covered.length && floor.length) {
    try {
      coveredInFloor = polygonClipping.intersection(covered, floor);
    } catch {
      coveredInFloor = covered; // fall back to unclipped covered
    }
  }
  let blind: MultiPolygon = [];
  if (floor.length) {
    if (!covered.length) blind = floor;
    else {
      try {
        blind = polygonClipping.difference(floor, covered);
      } catch {
        blind = []; // degrade: show no blind fill rather than crash
      }
    }
  }

  const floorAreaM2 = mpArea(floor);
  const coveredAreaM2 = mpArea(coveredInFloor);

  return {
    ordinal,
    coveredRings: mpRings(coveredInFloor),
    blindRings: mpRings(blind),
    floorAreaM2,
    coveredAreaM2,
    coveragePct: floorAreaM2 > 0 ? coveredAreaM2 / floorAreaM2 : 0,
  };
}
