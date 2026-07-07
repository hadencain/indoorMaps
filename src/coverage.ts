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
