import type { MetreXY } from "../types";

/** Move polygon edge `edgeIndex` (v[i]→v[i+1]) so its midpoint chases `target`,
 *  constrained to the edge's normal — "drag this wall". Only the perpendicular
 *  component of the drag applies, so axis-aligned edges stay axis-aligned and
 *  the edge never slides along itself. Pure; zero-length edges are a no-op. */
export function translateEdge(
  polygon: MetreXY[],
  edgeIndex: number,
  target: MetreXY,
): MetreXY[] {
  const n = polygon.length;
  const i = edgeIndex;
  const j = (edgeIndex + 1) % n;
  const a = polygon[i];
  const b = polygon[j];
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len = Math.hypot(ex, ey);
  if (len === 0) return polygon;
  const nx = -ey / len;
  const ny = ex / len;
  const mid: MetreXY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const d = (target[0] - mid[0]) * nx + (target[1] - mid[1]) * ny;
  return polygon.map((p, k) =>
    k === i || k === j ? ([p[0] + nx * d, p[1] + ny * d] as MetreXY) : p,
  );
}
