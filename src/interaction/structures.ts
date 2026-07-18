import type { MetreXY } from "../types";

/** Clamp bounds for the column tool's radius edits (metres). The panel clamps
 *  into [MIN, MAX] before committing — the store never sees an out-of-range
 *  radius from the UI. */
export const MIN_COLUMN_RADIUS_M = 0.15;
export const MAX_COLUMN_RADIUS_M = 2;

/** Tessellate a round column into its canonical footprint polygon: an OPEN
 *  ring (no repeated closing vertex — Unit.polygon convention), wound CCW,
 *  first vertex at angle 0 (due +x from `center`). Deterministic: the same
 *  center/radius/sides always regenerate the identical ring, so re-editing a
 *  column's radius via its `round` hint rebuilds a stable shape rather than
 *  drifting. Default 12 sides — the spec's 12-gon column. */
export function columnPolygon(center: MetreXY, radiusM: number, sides = 12): MetreXY[] {
  const ring: MetreXY[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    ring.push([center[0] + radiusM * Math.cos(a), center[1] + radiusM * Math.sin(a)]);
  }
  return ring;
}
