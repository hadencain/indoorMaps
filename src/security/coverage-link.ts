// Derived camera <-> space linkage (P7). Pure functions over `building`.
//
// No stored `Camera.covers` list — a manual link would drift the instant a
// camera is moved/re-aimed or a wall is edited. Instead the linkage is derived
// from the SAME occlusion-clipped visibility geometry the FOV/coverage overlays
// use (`collectWalls` + `computeVisibility` from coverage.ts). A unit is "seen"
// by a camera when the camera's visibility ring overlaps the unit polygon on the
// SAME ordinal. Overlap is tested with `polygon-clipping` intersection (the same
// boolean-geometry lib coverage.ts uses) — NO turf. A centroid point-in-polygon
// pass is used as a cheap fallback for degenerate rings.

import type { Building, Unit, Camera, MetreXY } from "../types";
import { collectWalls, computeVisibility, rankCamerasForPoint, scoreCameraForPoint } from "../coverage";
import { bbox, polygonCentroid } from "../geo";
import polygonClipping from "polygon-clipping";
import type { Ring } from "polygon-clipping";

/** Close an open metre ring (repeat the first point) for polygon-clipping. */
function closedRing(ring: MetreXY[]): Ring {
  const r: Ring = ring.map((p) => [p[0], p[1]]);
  const f = r[0];
  const l = r[r.length - 1];
  if (r.length > 0 && (f[0] !== l[0] || f[1] !== l[1])) r.push([f[0], f[1]]);
  return r;
}

/** Ray-cast point-in-polygon on an open metre ring (fallback overlap test). */
function pointInRing(pt: MetreXY, ring: MetreXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Centroid of an open metre ring (average of vertices). */
function centroid(ring: MetreXY[]): MetreXY {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

/** True iff two open metre rings overlap (area intersection, centroid fallback). */
function ringsOverlap(a: MetreXY[], b: MetreXY[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  try {
    const inter = polygonClipping.intersection([[closedRing(a)]], [[closedRing(b)]]);
    if (inter.length > 0) return true;
  } catch {
    /* fall through to centroid test */
  }
  // Fallback: either centroid inside the other ring (catches full containment /
  // degenerate wedges the boolean op may drop).
  return pointInRing(centroid(b), a) || pointInRing(centroid(a), b);
}

/** The camera's occlusion-clipped visibility ring, in local metres. */
function visibilityRing(b: Building, cam: Camera): MetreXY[] {
  return computeVisibility(cam, collectWalls(b, cam.ordinal));
}

/** Units on the SAME ordinal whose polygon overlaps the camera's coverage. */
export function unitsCoveredByCamera(b: Building, cameraId: string): Unit[] {
  const cam = b.cameras.find((c) => c.id === cameraId);
  if (!cam) return [];
  const ring = visibilityRing(b, cam);
  return b.units.filter((u) => u.ordinal === cam.ordinal && ringsOverlap(ring, u.polygon));
}

/** Cameras on the SAME ordinal whose coverage overlaps this unit. */
export function camerasSeeingUnit(b: Building, unitId: string): Camera[] {
  const unit = b.units.find((u) => u.id === unitId);
  if (!unit) return [];
  return b.cameras.filter(
    (c) => c.ordinal === unit.ordinal && ringsOverlap(visibilityRing(b, c), unit.polygon),
  );
}

// ---------------------------------------------------------------------------
// RANKED index — the VMS handoff. Same derived-not-stored discipline, now scored
// by view quality (aim + proximity + depth-in-view; see coverage.ts) so a click /
// a "seen by" list leads with the camera that actually sees the space best, and
// the exported index encodes that ranking for a downstream live console.
// ---------------------------------------------------------------------------

export interface RankedCamera {
  cameraId: string;
  name: string;
  kind: Camera["kind"];
  score: number; // 0..1, best view first
  streamRef?: string;
}
export interface UnitCoverage {
  unitId: string;
  ordinal: number;
  name: string;
  category: string;
  security: string;
  cameras: RankedCamera[]; // [] = a coverage gap
}

const indexable = (u: Unit) => u.category !== "corridor" && u.category !== "outside";

/** A point GUARANTEED inside `poly` (the area-weighted centroid escapes reentrant
 *  L/U/T rooms into the notch, so fall back to a scanline interior point). */
export function interiorPoint(poly: MetreXY[]): MetreXY {
  const c = polygonCentroid(poly);
  if (pointInRing(c, poly)) return c;
  const [x0, , x1] = bbox(poly);
  const y = c[1];
  const step = Math.max((x1 - x0) / 128, 0.25);
  let spanStart: number | null = null;
  for (let x = x0; x <= x1; x += step) {
    const inside = pointInRing([x, y], poly);
    if (inside && spanStart === null) spanStart = x;
    else if (!inside && spanStart !== null) return [(spanStart + x - step) / 2, y];
  }
  return spanStart !== null ? [(spanStart + x1) / 2, y] : c;
}

/** Interior sample points for a unit: a guaranteed-interior anchor + a coarse
 *  interior grid (budget-capped so no polygon — e.g. a huge lot — can explode).
 *  Every returned point is inside the polygon. */
export function samplePoints(poly: MetreXY[], step = 8): MetreXY[] {
  const [x0, y0, x1, y1] = bbox(poly);
  // Cap the grid: for a very large polygon, widen the step so the point count
  // stays ~bounded (protects the interactive path from a giant selection).
  const budget = 80;
  const cells = ((x1 - x0) / step) * ((y1 - y0) / step);
  const s = cells > budget ? step * Math.sqrt(cells / budget) : step;
  const pts: MetreXY[] = [];
  for (let x = x0 + s / 2; x < x1; x += s)
    for (let y = y0 + s / 2; y < y1; y += s) {
      const p: MetreXY = [x, y];
      if (pointInRing(p, poly)) pts.push(p);
    }
  if (!pts.length) pts.push(interiorPoint(poly));
  return pts;
}

/** Rank cameras seeing `unit`, given this floor's cameras + precomputed rings. */
export function rankCamerasForUnitWithRings(
  unit: Unit,
  cams: Camera[],
  ringById: Map<string, MetreXY[]>,
): RankedCamera[] {
  const camById = new Map(cams.map((c) => [c.id, c]));
  const best = new Map<string, number>();
  for (const pt of samplePoints(unit.polygon))
    for (const cs of rankCamerasForPoint(pt, cams, ringById))
      best.set(cs.cameraId, Math.max(best.get(cs.cameraId) ?? 0, cs.score));
  return [...best.entries()]
    .map(([cameraId, score]) => {
      const c = camById.get(cameraId)!;
      return { cameraId, name: c.name, kind: c.kind, score, streamRef: c.streamRef };
    })
    .sort((a, b) => b.score - a.score);
}

/** Ranked "seen by" for one unit (recomputes this floor's rings once). */
export function rankCamerasForUnit(b: Building, unitId: string): RankedCamera[] {
  const unit = b.units.find((u) => u.id === unitId);
  if (!unit || !indexable(unit)) return []; // no per-camera index for corridors / exterior
  const cams = b.cameras.filter((c) => c.ordinal === unit.ordinal);
  const walls = collectWalls(b, unit.ordinal); // hoisted out of the per-camera loop
  const ringById = new Map(cams.map((c) => [c.id, computeVisibility(c, walls)]));
  return rankCamerasForUnitWithRings(unit, cams, ringById);
}

/** The spaces one camera covers, best-view first — given its precomputed ring.
 *  Scored MAX over the unit's in-ring sample points (same metric as the index /
 *  "Seen by"), so a camera→room pair reads identically everywhere. */
export function unitsSeenByCameraRing(
  cam: Camera,
  ring: MetreXY[],
  units: Unit[],
): { unitId: string; name: string; score: number }[] {
  const out: { unitId: string; name: string; score: number }[] = [];
  for (const u of units) {
    if (u.ordinal !== cam.ordinal || !indexable(u)) continue;
    let best = -1;
    for (const p of samplePoints(u.polygon))
      if (pointInRing(p, ring)) best = Math.max(best, scoreCameraForPoint(cam, ring, p).score);
    if (best >= 0) out.push({ unitId: u.id, name: u.name, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Full multi-floor space→camera index. Pure; recompute on any building change so
 *  it always matches current coverage. Call on demand (export), not per keystroke. */
export function buildCameraIndex(b: Building): UnitCoverage[] {
  const out: UnitCoverage[] = [];
  const ordinals = [...new Set(b.units.map((u) => u.ordinal))].sort((x, y) => x - y);
  for (const o of ordinals) {
    const walls = collectWalls(b, o);
    const cams = b.cameras.filter((c) => c.ordinal === o);
    const ringById = new Map(cams.map((c) => [c.id, computeVisibility(c, walls)]));
    for (const u of b.units) {
      if (u.ordinal !== o || !indexable(u)) continue;
      out.push({
        unitId: u.id,
        ordinal: o,
        name: u.name,
        category: u.category,
        security: u.security ?? "public",
        cameras: rankCamerasForUnitWithRings(u, cams, ringById),
      });
    }
  }
  return out;
}

/** Summary stats for the export header + coverage-gap flags. */
export function indexStats(idx: UnitCoverage[]) {
  const gaps = idx.filter((u) => u.cameras.length === 0);
  const secureUnderCovered = idx.filter(
    (u) => (u.security === "secure" || u.security === "restricted") && u.cameras.length < 2,
  );
  return {
    spaces: idx.length,
    gaps: gaps.map((u) => u.name),
    redundantCount: idx.filter((u) => u.cameras.length >= 2).length,
    secureUnderCovered: secureUnderCovered.map((u) => u.name),
  };
}
