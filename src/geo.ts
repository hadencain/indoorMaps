import type { LngLat, MetreXY } from "./types";

const M_PER_DEG_LAT = 111320;

/** Project a local-metre point to [lng, lat] relative to a lng/lat origin. */
export function m2ll(origin: LngLat, x: number, y: number): LngLat {
  const [lng0, lat0] = origin;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [lng0 + x / mPerDegLng, lat0 + y / M_PER_DEG_LAT];
}

/** Inverse of m2ll: project a [lng, lat] back to local metres. */
export function ll2m(origin: LngLat, lng: number, lat: number): MetreXY {
  const [lng0, lat0] = origin;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [(lng - lng0) * mPerDegLng, (lat - lat0) * M_PER_DEG_LAT];
}

/** Snap a metre point to the nearest multiple of `size`. */
export function snapPoint(p: MetreXY, size: number): MetreXY {
  if (size <= 0) return p;
  return [Math.round(p[0] / size) * size, Math.round(p[1] / size) * size];
}

/** Euclidean distance between two local-metre points, in metres. */
export function distM(a: MetreXY, b: MetreXY): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/** Area-weighted centroid of a polygon (open ring). Falls back to the vertex
 *  mean for degenerate/near-zero-area rings. */
export function polygonCentroid(pts: MetreXY[]): MetreXY {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6 || pts.length < 3) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
    }
    return [sx / pts.length, sy / pts.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Axis-aligned bounds [x0,y0,x1,y1] of a set of metre points. */
export function bbox(pts: MetreXY[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Absolute polygon area in m² (shoelace), for an open ring. */
export function polygonArea(pts: MetreXY[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** Closed-ring perimeter in metres. */
export function polygonPerimeter(pts: MetreXY[]): number {
  if (pts.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    p += distM(pts[i], pts[(i + 1) % pts.length]);
  }
  return p;
}

/** Metre points -> lng/lat points (open, not closed). */
export function pointsToLL(origin: LngLat, pts: MetreXY[]): LngLat[] {
  return pts.map((p) => m2ll(origin, p[0], p[1]));
}

/** Closed ring (lng/lat) for a polygon, ready for a GeoJSON Polygon. */
export function polygonRing(origin: LngLat, pts: MetreXY[]): LngLat[] {
  const ring = pointsToLL(origin, pts);
  if (ring.length > 0) ring.push(ring[0]);
  return ring;
}
