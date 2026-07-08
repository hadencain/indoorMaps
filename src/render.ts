import type { Building, Graph, LngLat } from "./types";
import { polygonRing, distM, m2ll, bbox, pointsToLL } from "./geo";

export type FC = GeoJSON.FeatureCollection;

/** Grid lines (lng/lat) spanning the building footprint + margin, every `size` m. */
export function gridToGeoJSON(b: Building, size: number): FC {
  const features: GeoJSON.Feature[] = [];
  if (size <= 0 || b.units.length === 0) return { type: "FeatureCollection", features };

  const all = b.units.flatMap((u) => u.polygon);
  const [minX, minY, maxX, maxY] = bbox(all);
  const margin = Math.max(size * 4, 8);
  const x0 = Math.floor((minX - margin) / size) * size;
  const y0 = Math.floor((minY - margin) / size) * size;
  const x1 = Math.ceil((maxX + margin) / size) * size;
  const y1 = Math.ceil((maxY + margin) / size) * size;

  // Cap line count so a tiny grid over a big span can't explode.
  if ((x1 - x0) / size + (y1 - y0) / size > 1000) return { type: "FeatureCollection", features };

  for (let x = x0; x <= x1 + 1e-6; x += size) {
    features.push(line([m2ll(b.origin, x, y0), m2ll(b.origin, x, y1)]));
  }
  for (let y = y0; y <= y1 + 1e-6; y += size) {
    features.push(line([m2ll(b.origin, x0, y), m2ll(b.origin, x1, y)]));
  }
  return { type: "FeatureCollection", features };
}

function line(coordinates: LngLat[]): GeoJSON.Feature {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } };
}

/** Patrol paths as open LineStrings (one Feature per path, tagged with ordinal
 *  for the floor filter). Rendered as the dashed violet `patrol-line` layer. */
export function patrolsToGeoJSON(b: Building): FC {
  const features: GeoJSON.Feature[] = [];
  for (const p of b.patrols ?? []) {
    if (p.points.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { id: p.id, ordinal: p.ordinal, name: p.name },
      geometry: { type: "LineString", coordinates: pointsToLL(b.origin, p.points) },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Fixture polygons (furniture/equipment), tagged with ordinal + kind for the
 *  kind-driven fill. Purely visual — not units, not coverage, not occlusion. */
export function fixturesToGeoJSON(b: Building): FC {
  return {
    type: "FeatureCollection",
    features: (b.fixtures ?? []).map((f) => ({
      type: "Feature",
      properties: { id: f.id, ordinal: f.ordinal, kind: f.kind },
      geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, f.polygon)] },
    })),
  };
}

/** Per-floor building footprint (floor slab + exterior wall), tagged with ordinal. */
export function footprintsToGeoJSON(b: Building): FC {
  return {
    type: "FeatureCollection",
    features: (b.footprints ?? []).map((fp) => ({
      type: "Feature",
      properties: { ordinal: fp.ordinal },
      geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, fp.polygon)] },
    })),
  };
}

/** Unit polygons (one Feature per unit, tagged with ordinal + category). */
export function unitsToGeoJSON(b: Building): FC {
  return {
    type: "FeatureCollection",
    features: b.units.map((u) => ({
      type: "Feature",
      properties: {
        id: u.id,
        ordinal: u.ordinal,
        category: u.category,
        name: u.name,
        // Access-control level for the secure-perimeter `match` filter (P8).
        // Default "public" so the filter has a value on every feature.
        security: u.security ?? "public",
      },
      geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, u.polygon)] },
    })),
  };
}

export interface RoutePoint {
  ordinal: number;
  lnglat: LngLat;
  kind: "start" | "end" | "transition";
  label: string;
}

export interface RouteGeometry {
  /** LineString features, one per same-ordinal hop, tagged with ordinal. */
  lines: FC;
  /** Start / end / floor-transition markers. */
  points: RoutePoint[];
  /** Horizontal distance walked, in metres (excludes vertical hops). */
  metres: number;
  /** Ordinals the route passes through, in order of first appearance. */
  floors: number[];
}

/** Turn an ordered node path into per-floor line segments + marker points. */
export function routeToGeometry(graph: Graph, path: string[]): RouteGeometry {
  const { nodes } = graph;
  const lines: FC = { type: "FeatureCollection", features: [] };
  const points: RoutePoint[] = [];
  const floors: number[] = [];
  let metres = 0;

  const noteFloor = (o: number) => {
    if (!floors.includes(o)) floors.push(o);
  };

  for (let i = 0; i < path.length - 1; i++) {
    const a = nodes.get(path[i])!;
    const b = nodes.get(path[i + 1])!;
    noteFloor(a.ordinal);
    noteFloor(b.ordinal);

    if (a.ordinal === b.ordinal) {
      metres += distM(a.xy, b.xy);
      lines.features.push({
        type: "Feature",
        properties: { ordinal: a.ordinal },
        geometry: { type: "LineString", coordinates: [a.lnglat, b.lnglat] },
      });
    } else {
      // Vertical transition (elevator/stairs): mark it on both floors.
      points.push({ ordinal: a.ordinal, lnglat: a.lnglat, kind: "transition", label: "↕" });
      points.push({ ordinal: b.ordinal, lnglat: b.lnglat, kind: "transition", label: "↕" });
    }
  }

  if (path.length > 0) {
    const s = nodes.get(path[0])!;
    const e = nodes.get(path[path.length - 1])!;
    points.push({ ordinal: s.ordinal, lnglat: s.lnglat, kind: "start", label: "A" });
    points.push({ ordinal: e.ordinal, lnglat: e.lnglat, kind: "end", label: "B" });
  }

  return { lines, points, metres, floors };
}
