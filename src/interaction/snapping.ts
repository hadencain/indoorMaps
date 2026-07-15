import type { MetreXY } from "../types";
import { distM, projectOnSegment, snapPoint } from "../geo";

/** What a point snapped to, in priority order (vertex strongest). */
export type SnapKind = "vertex" | "edge" | "axis" | "grid" | "none";

export interface SnapResult {
  point: MetreXY;
  kind: SnapKind;
}

export interface SnapOptions {
  /** Same-floor polygons to snap against (exclude the polygon being edited). */
  polygons: MetreXY[][];
  /** Previous placed point (polygon draw / vertex drag) for H/V axis alignment. */
  prev?: MetreXY | null;
  /** Grid size in metres when the grid is on; null/undefined disables grid snap. */
  gridSize?: number | null;
  /** Snap tolerance in metres (caller converts SNAP_PX via metresPerPixel). */
  tolM: number;
}

/** Ground metres per screen pixel at a zoom/latitude (web-mercator, 512px tiles).
 *  Inverse of the ppm formula the zoom declutterer uses. */
export function metresPerPixel(zoom: number, lat: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
}

/** Snap a raw metre point against neighbors, priority: vertex → edge → axis →
 *  grid. Grid keeps legacy semantics: when on, it always applies as the final
 *  fallback (not tolerance-gated). Pure — never throws, never mutates. */
export function snapDrawPoint(raw: MetreXY, opts: SnapOptions): SnapResult {
  // 1. Nearest vertex within tolerance.
  let bestV: MetreXY | null = null;
  let bestVD = Infinity;
  for (const poly of opts.polygons) {
    for (const v of poly) {
      const d = distM(raw, v);
      if (d < bestVD) {
        bestVD = d;
        bestV = v;
      }
    }
  }
  if (bestV && bestVD <= opts.tolM) return { point: [bestV[0], bestV[1]], kind: "vertex" };

  // 2. Nearest edge projection within tolerance.
  let bestE: MetreXY | null = null;
  let bestED = Infinity;
  for (const poly of opts.polygons) {
    for (let i = 0; i < poly.length; i++) {
      const q = projectOnSegment(raw, poly[i], poly[(i + 1) % poly.length]);
      const d = distM(raw, q);
      if (d < bestED) {
        bestED = d;
        bestE = q;
      }
    }
  }
  if (bestE && bestED <= opts.tolM) return { point: bestE, kind: "edge" };

  // 3. Axis-align with the previous point (each coordinate independently).
  if (opts.prev) {
    const alignX = Math.abs(raw[0] - opts.prev[0]) <= opts.tolM;
    const alignY = Math.abs(raw[1] - opts.prev[1]) <= opts.tolM;
    if (alignX || alignY) {
      return {
        point: [alignX ? opts.prev[0] : raw[0], alignY ? opts.prev[1] : raw[1]],
        kind: "axis",
      };
    }
  }

  // 4. Grid (legacy: always snaps when the grid is on).
  if (opts.gridSize && opts.gridSize > 0) {
    return { point: snapPoint(raw, opts.gridSize), kind: "grid" };
  }

  return { point: raw, kind: "none" };
}
