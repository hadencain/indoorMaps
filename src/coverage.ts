// Camera coverage geometry — pure, metre-space, no React / no MapLibre.
// Same discipline as geo.ts / astar.ts: testable in isolation.
//
// P4 (this phase) implements ONLY the naive radial FOV fallback: `sectorRing`.
// It draws each camera's field of view as a flat wedge that PASSES THROUGH
// WALLS — it does NOT model line-of-sight / occlusion. That is deliberately
// deferred to P5 (`computeVisibility`, wall casting) and P6 (coverage/blind
// union). The rendering source is shared, so P5 later swaps only the geometry
// function with zero UI churn. See the spec's "Deviations / occlusion fallback".

import type { Camera, MetreXY } from "./types";

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
