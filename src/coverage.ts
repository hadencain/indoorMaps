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

/** A structure occludes 2D sightlines iff (baseM ?? 0) < WALK_UNDER_M — a
 *  soffit/duct you can walk under is treated as see-under too. Approximation:
 *  a camera lens usually sits above head height, so a raised structure may in
 *  reality still clip its view; accepted (spec OQ-3). */
export const WALK_UNDER_M = 1.8;

/**
 * All wall segments a camera on `ordinal` can be occluded by: every edge of
 * every unit polygon on that floor. Degenerate rings (near-zero area) are
 * skipped so self-touching / zero-area polygons don't emit spurious rays.
 *
 * Doors are NOT punched out — a unit outline is a closed ring, so a camera does
 * not see through an open doorway. This makes coverage conservatively
 * *under*-reported (the safe direction for a security tool). Accepted v1 limit.
 *
 * Structures (columns, obstacles) are first-class occluders — the anti-Fixture:
 * fixtures never block sightlines, structures always do, EXCEPT when the
 * structure floats above walk-under height ((baseM ?? 0) >= WALK_UNDER_M), in
 * which case a camera sees under it and its edges are skipped.
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
  // The exterior wall is an occluder too: a perimeter camera must NOT see through
  // it into the parking lot, and a lot camera must not see into the building. This
  // makes click-to-camera physically honest — a click outside a room can't resolve
  // to an interior camera whose raw range arc spilled through the envelope.
  const fp = building.footprints?.find((f) => f.ordinal === ordinal && f.polygon.length >= 3);
  if (fp) {
    const p = fp.polygon;
    for (let i = 0; i < p.length; i++) segs.push({ a: p[i], b: p[(i + 1) % p.length] });
  }
  for (const s of building.structures ?? []) {
    if (s.ordinal !== ordinal) continue;
    if ((s.baseM ?? 0) >= WALK_UNDER_M) continue; // camera sees under it
    const p = s.polygon;
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
/** Default camera mount height for the tilt model (metres). Used when
 *  Camera.mountM is absent, so legacy coverage stays bit-identical. */
export const MOUNT_H = 4;

/** Vertical half-FOV in radians. An authored Camera.vfovDeg overrides the
 *  derivation (unusual sensor formats — spec OQ-2), clamped only to a sane
 *  (0°, 180°) window since hand-edited files reach here unvalidated; absent ⇒
 *  derived from the horizontal FOV via a 16:9 sensor aspect, clamped to a
 *  plausible optics window. */
function vfovHalfRad(fovDeg: number, vfovDeg?: number): number {
  const vfov =
    vfovDeg != null
      ? Math.min(179, Math.max(1, vfovDeg))
      : Math.min(60, Math.max(15, fovDeg * (9 / 16)));
  return (vfov * Math.PI) / 360;
}

/** The ground band a tilted camera sees: `nearM`..`farM` from the mount.
 *  Projection of a camera at MOUNT_H tilted `tiltDeg` below horizontal: the
 *  lower FOV edge (tilt + vhalf) sets where floor vision STARTS, the upper
 *  edge (tilt − vhalf) where it ENDS (∞ → range-capped once the upper edge
 *  reaches the horizon). Tilt up → the band reaches farther but a near-field
 *  blind hole opens under the mount; tilt down → the band pulls in close.
 *  Returns null for domes (overhead 360°) and legacy planar cameras
 *  (tiltDeg undefined) — those keep the full wedge from the camera. */
export function tiltBand(cam: Camera): { nearM: number; farM: number } | null {
  if (cam.tiltDeg == null || cam.kind === "dome" || cam.fovDeg >= 360) return null;
  const vhalf = vfovHalfRad(cam.fovDeg, cam.vfovDeg);
  const tilt = (cam.tiltDeg * Math.PI) / 180;
  const lower = tilt + vhalf;
  const upper = tilt - vhalf;
  // Clamp H at 0: the action boundary clamps mountM too, but a hand-edited
  // file reaches here unvalidated, and a negative H would flip farM's sign —
  // projecting the band BEHIND the camera. H = 0 degrades gracefully (band
  // collapses onto the mount), per the spec's failure-mode rule.
  const H = Math.max(cam.mountM ?? MOUNT_H, 0);
  // lower <= 0 (edge at/above the horizon): tan(lower) <= 0, so the raw
  // division is negative (clamped to 0 below) or, at lower === 0 with H = 0,
  // 0/0 = NaN — which Math.max passes through. Pin the near edge to the mount.
  const nearM = lower <= 0 || lower >= Math.PI / 2 ? 0 : H / Math.tan(lower);
  const farM = upper <= 0.035 ? Infinity : H / Math.tan(upper); // ~2° horizon guard
  return { nearM: Math.max(0, nearM), farM: Math.max(nearM, farM) };
}

export function computeVisibility(cam: Camera, walls: Segment[]): MetreXY[] {
  const at = cam.at;
  const full = cam.kind === "dome" || cam.fovDeg >= 360;
  const h = (cam.heading * Math.PI) / 180;
  const half = full ? Math.PI : (cam.fovDeg * Math.PI) / 180 / 2;
  // Tilted cameras see an annular ground band, not the full wedge: the far
  // edge caps every ray; the near edge is carved back out of the ring below.
  const band = tiltBand(cam);
  const R = band ? Math.min(cam.rangeM, band.farM) : cam.rangeM;

  // Range-disc cull: a wall farther from the camera than R can never occlude
  // (any blocking point lies within R of `at` and on the segment), and its
  // endpoint rays only add redundant vertices on the free arc. Densely
  // partitioned floors put thousands of segments outside a 50 m disc — culling
  // keeps per-camera cost O(local walls²) instead of O(floor walls²). The
  // small-scene guard skips the filter where it can't pay for itself.
  if (walls.length > 64) {
    walls = walls.filter((s) => segDistPt(at, s.a, s.b) <= R + 0.01);
  }

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
  const dists: number[] = [];
  const angles: number[] = [];
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
    dists.push(best);
    angles.push(a);
  }

  if (full) return hits;

  // Annular sector for a tilted camera: outer boundary forward, then the near
  // edge walked BACK. Where a wall sits closer than the near edge the two
  // boundaries pinch to a hair (0.999 nudge keeps the ring simple for the
  // boolean-union engine instead of exactly self-touching).
  const nearR = band ? Math.min(band.nearM, R) : 0;
  if (nearR > 0.3) {
    const inner: MetreXY[] = [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const r = Math.min(nearR, dists[i] * 0.999);
      inner.push([at[0] + Math.cos(angles[i]) * r, at[1] + Math.sin(angles[i]) * r]);
    }
    return [...hits, ...inner];
  }

  return [at, ...hits];
}

// ---------------------------------------------------------------------------
// Best-camera view-quality scoring (the VMS resolver: "which camera actually
// sees this point best"). A raw nearest-camera sort is wrong — it can pick a
// ceiling dome grazing a point edge-on over a fixed camera aimed straight at it.
// A camera sees a point WELL when it is aimed at it, close (within range), and
// the point sits deep inside its view (not grazing an occluder/FOV edge).
// ---------------------------------------------------------------------------

/** View-quality weights — CONFIGURABLE. Tune the relative importance of aim vs
 *  proximity vs how deep inside the field of view the point sits. */
export const VIEW_WEIGHTS = { heading: 0.45, distance: 0.35, depth: 0.2 };
/** A dome sees every direction but is never "aimed" — a neutral heading score so
 *  a fixed camera pointed at the point outranks a dome, but a close, deep dome
 *  still beats a far, edge-on fixed camera. */
const DOME_HEADING_SCORE = 0.62;
/** Metres-inside-the-view at which the depth score saturates to 1. */
const DEPTH_NORM_M = 6;

/** Distance from `p` to segment `a→b`. */
function segDistPt(p: MetreXY, a: MetreXY, b: MetreXY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/** Shortest distance from a point to a ring's edges (how deep inside it sits). */
function ringMinEdgeDist(pt: MetreXY, ring: MetreXY[]): number {
  let m = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) m = Math.min(m, segDistPt(pt, ring[j], ring[i]));
  return m;
}

/** A camera's view quality on a specific point (which it already SEES). */
export interface CameraScore {
  cameraId: string;
  score: number; // 0..1, higher = better view
  distanceM: number;
  headingAlign: number; // 1 = dead-centre of FOV, 0 = at the FOV edge
  depthM: number; // metres from the nearest edge of the visibility polygon
}

/** Score how well `cam` (with occlusion ring `ring`) sees `point`. Assumes the
 *  point is inside the ring (verify with pointInRing before calling). */
export function scoreCameraForPoint(cam: Camera, ring: MetreXY[], point: MetreXY): CameraScore {
  const dx = point[0] - cam.at[0], dy = point[1] - cam.at[1];
  const distanceM = Math.hypot(dx, dy);
  const distScore = 1 - Math.min(distanceM / Math.max(cam.rangeM, 1e-6), 1);
  const full = cam.kind === "dome" || cam.fovDeg >= 360;
  let headingAlign: number;
  if (full) headingAlign = DOME_HEADING_SCORE;
  else {
    const off = Math.abs(wrapPi(Math.atan2(dy, dx) - (cam.heading * Math.PI) / 180));
    const half = Math.max((cam.fovDeg * Math.PI) / 180 / 2, 1e-6);
    headingAlign = 1 - Math.min(off / half, 1);
  }
  const depthM = ringMinEdgeDist(point, ring);
  const depthScore = Math.min(depthM / DEPTH_NORM_M, 1);
  const score =
    VIEW_WEIGHTS.heading * headingAlign + VIEW_WEIGHTS.distance * distScore + VIEW_WEIGHTS.depth * depthScore;
  return { cameraId: cam.id, score, distanceM, headingAlign, depthM };
}

/** Rank every camera whose occlusion ring CONTAINS `point`, best view first. */
export function rankCamerasForPoint(
  point: MetreXY,
  cams: Camera[],
  ringById: Map<string, MetreXY[]>,
): CameraScore[] {
  const out: CameraScore[] = [];
  for (const c of cams) {
    const ring = ringById.get(c.id);
    if (ring && ring.length >= 3 && pointInRing(point, ring)) out.push(scoreCameraForPoint(c, ring, point));
  }
  out.sort((a, b) => b.score - a.score);
  return out;
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

  // The floor extent = the building footprint for this ordinal if one exists (so
  // "coverage %" measures the whole floor — open areas included, as in a casino);
  // otherwise fall back to the union of the units.
  const fp = building.footprints?.find((f) => f.ordinal === ordinal && f.polygon.length >= 3);
  const floor = unionRings(fp ? [fp.polygon] : unitRings);
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
