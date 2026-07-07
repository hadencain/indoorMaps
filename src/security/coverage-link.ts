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
import { collectWalls, computeVisibility } from "../coverage";
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
