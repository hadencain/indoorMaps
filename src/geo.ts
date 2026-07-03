import type { LngLat, MetreXY } from "./types";

const M_PER_DEG_LAT = 111320;

/** Project a local-metre point to [lng, lat] relative to a lng/lat origin. */
export function m2ll(origin: LngLat, x: number, y: number): LngLat {
  const [lng0, lat0] = origin;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [lng0 + x / mPerDegLng, lat0 + y / M_PER_DEG_LAT];
}

/** Euclidean distance between two local-metre points, in metres. */
export function distM(a: MetreXY, b: MetreXY): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/** Centre of an axis-aligned rectangle [x0,y0,x1,y1]. */
export function rectCentre(rect: [number, number, number, number]): MetreXY {
  return [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
}

/** Closed ring (lng/lat) for a rectangle, ready for a GeoJSON Polygon. */
export function rectRing(
  origin: LngLat,
  rect: [number, number, number, number],
): LngLat[] {
  const [x0, y0, x1, y1] = rect;
  return [
    m2ll(origin, x0, y0),
    m2ll(origin, x1, y0),
    m2ll(origin, x1, y1),
    m2ll(origin, x0, y1),
    m2ll(origin, x0, y0),
  ];
}
