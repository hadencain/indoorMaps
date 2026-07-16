// Route smoothing (pure, metre-space) — line-of-sight shortcutting + cosmetic
// corner rounding, applied to a raw per-floor node-path polyline before it's
// projected to lng/lat for rendering. No React / no MapLibre.

import { raySegmentT } from "./coverage";
import type { Segment } from "./coverage";
import type { MetreXY } from "./types";

/** Shared walking speed (patrol playback + route ETA), in m/s. */
export const WALK_MPS = 1.4;

/** Endpoint slop: a point sitting exactly on a wall (a door) must not count as
 *  blocking the segment that starts there. */
const EPS = 0.05;

/** True if segment P->Q is blocked by any wall (a hit strictly between the
 *  endpoints, i.e. not the endpoint's own wall). */
function segmentBlocked(P: MetreXY, Q: MetreXY, walls: Segment[]): boolean {
  const dx = Q[0] - P[0];
  const dy = Q[1] - P[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const d: MetreXY = [dx / len, dy / len];
  for (const wall of walls) {
    const t = raySegmentT(P, d, wall.a, wall.b);
    if (t !== null && t > EPS && t < len - EPS) return true;
  }
  return false;
}

/**
 * Line-of-sight shortcut: drop intermediate points when the straight segment
 * crosses no wall. Greedy farthest-visible: anchor at i, scan j from the end
 * backward to i+2, take the first clear segment (else advance one). Endpoints
 * are always kept.
 */
export function losShortcut(pts: MetreXY[], walls: Segment[]): MetreXY[] {
  if (pts.length <= 2) return pts.slice();
  const out: MetreXY[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && segmentBlocked(pts[i], pts[j], walls)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/**
 * Cosmetic corner cut (one Chaikin-style pass, max 0.75 m per side, clamped to
 * 45% of each adjacent segment). Endpoints unchanged. Display-only.
 */
export function roundCorners(pts: MetreXY[], radius = 0.75): MetreXY[] {
  if (pts.length < 3) return pts.slice();
  const out: MetreXY[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1];
    const V = pts[i];
    const B = pts[i + 1];
    const av = Math.hypot(V[0] - A[0], V[1] - A[1]);
    const vb = Math.hypot(B[0] - V[0], B[1] - V[1]);
    const cut = Math.min(radius, 0.45 * av, 0.45 * vb);
    if (av < 1e-9 || vb < 1e-9) {
      out.push(V);
      continue;
    }
    out.push([V[0] + ((A[0] - V[0]) * cut) / av, V[1] + ((A[1] - V[1]) * cut) / av]);
    out.push([V[0] + ((B[0] - V[0]) * cut) / vb, V[1] + ((B[1] - V[1]) * cut) / vb]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
