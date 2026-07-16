import type { Building, Category, Graph, LngLat, MetreXY } from "./types";
import { polygonRing, distM, m2ll, bbox, pointsToLL } from "./geo";
import { functionBucket } from "./categories";
import { occupantNamesByUnit } from "./occupants";
import { collectWalls } from "./coverage";
import { losShortcut, roundCorners } from "./route-smooth";

export type FC = GeoJSON.FeatureCollection;

// Extrusion heights (display-only synthesis for the 3D view — no data field;
// per-unit custom heights are a future additive field). Structural/enclosed
// categories stand full height; corridor/lobby are low circulation slabs;
// outside is flat (never extruded).
export const UNIT_HEIGHT_M: Record<Category, number> = {
  room: 3.2,
  office: 3.2,
  retail: 3.2,
  restroom: 3.2,
  storage: 3.2,
  mechanical: 3.2,
  stairs: 3.2,
  elevator: 3.2,
  corridor: 0.15,
  lobby: 0.15,
  outside: 0,
};

// Fixture extrusion heights by kind (display-only synthesis, same rationale
// as UNIT_HEIGHT_M). Kinds not listed here fall back to DEFAULT_FIXTURE_HEIGHT_M.
export const FIXTURE_HEIGHT_M: Record<string, number> = {
  slot: 1.6,
  bar: 1.1,
  counter: 1.1,
  blackjack: 0.9,
  baccarat: 0.9,
  poker: 0.9,
  roulette: 0.9,
  craps: 0.9,
  wheel: 0.9,
  stage: 0.6,
  planter: 0.5,
  seating: 0.45,
  car: 1.4,
  parking: 0,
};

export const DEFAULT_FIXTURE_HEIGHT_M = 0.8;

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
      properties: {
        id: f.id,
        ordinal: f.ordinal,
        kind: f.kind,
        heightM: FIXTURE_HEIGHT_M[f.kind] ?? DEFAULT_FIXTURE_HEIGHT_M,
      },
      geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, f.polygon)] },
    })),
  };
}

/** CAD linework (DXF vector underlays), one LineString feature per polyline,
 *  tagged with ordinal for the floor filter. Pure — mirrors patrolsToGeoJSON. */
export function vectorUnderlaysToGeoJSON(b: Building): FC {
  const features: GeoJSON.Feature[] = [];
  for (const v of b.vectorUnderlays ?? []) {
    for (const poly of v.polylines) {
      features.push({
        type: "Feature",
        properties: { ordinal: v.ordinal },
        geometry: { type: "LineString", coordinates: pointsToLL(b.origin, poly) },
      });
    }
  }
  return { type: "FeatureCollection", features };
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
  const occNames = occupantNamesByUnit(b);
  return {
    type: "FeatureCollection",
    features: b.units.map((u) => ({
      type: "Feature",
      properties: {
        id: u.id,
        ordinal: u.ordinal,
        category: u.category,
        // Functional bucket for the space-plan fill (drives functionFillExpression).
        func: functionBucket(u),
        name: u.name,
        // Space-joined tenant names for canvas search-dim (P2) and the
        // occupant-anchored labels (P3). "" = vacant (property must exist so
        // the MapLibre downcase/index-of expression never sees null).
        occupant: occNames.get(u.id) ?? "",
        // Access-control level for the secure-perimeter `match` filter (P8).
        // Default "public" so the filter has a value on every feature.
        security: u.security ?? "public",
        // Extrusion height for the 3D view's fill-extrusion layer (Phase A).
        heightM: UNIT_HEIGHT_M[u.category],
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

/** Turn an ordered node path into per-floor line segments + marker points.
 *  Consecutive same-ordinal node runs are line-of-sight shortcut + corner
 *  rounded before being projected, so the rendered path cuts corners instead
 *  of hugging every nav-graph hub point. */
export function routeToGeometry(graph: Graph, path: string[], building: Building): RouteGeometry {
  const { nodes } = graph;
  const lines: FC = { type: "FeatureCollection", features: [] };
  const points: RoutePoint[] = [];
  const floors: number[] = [];
  let metres = 0;

  const noteFloor = (o: number) => {
    if (!floors.includes(o)) floors.push(o);
  };

  const wallsByOrdinal = new Map<number, ReturnType<typeof collectWalls>>();
  const wallsFor = (ordinal: number) => {
    let w = wallsByOrdinal.get(ordinal);
    if (!w) {
      w = collectWalls(building, ordinal);
      wallsByOrdinal.set(ordinal, w);
    }
    return w;
  };

  // Split the path into maximal same-ordinal runs; runs are separated wherever
  // consecutive nodes sit on different floors (a vertical transition edge).
  let i = 0;
  while (i < path.length) {
    let j = i;
    const ordinal = nodes.get(path[i])!.ordinal;
    while (j + 1 < path.length && nodes.get(path[j + 1])!.ordinal === ordinal) j++;
    noteFloor(ordinal);

    if (j > i) {
      const runPts: MetreXY[] = [];
      for (let k = i; k <= j; k++) runPts.push(nodes.get(path[k])!.xy);
      const shortcut = losShortcut(runPts, wallsFor(ordinal));
      for (let k = 1; k < shortcut.length; k++) metres += distM(shortcut[k - 1], shortcut[k]);
      const smoothed = roundCorners(shortcut);
      lines.features.push({
        type: "Feature",
        properties: { ordinal },
        geometry: { type: "LineString", coordinates: pointsToLL(building.origin, smoothed) },
      });
    }

    if (j + 1 < path.length) {
      // Vertical transition (elevator/stairs): mark it on both floors.
      const a = nodes.get(path[j])!;
      const b = nodes.get(path[j + 1])!;
      points.push({ ordinal: a.ordinal, lnglat: a.lnglat, kind: "transition", label: "↕" });
      points.push({ ordinal: b.ordinal, lnglat: b.lnglat, kind: "transition", label: "↕" });
    }

    i = j + 1;
  }

  if (path.length > 0) {
    const s = nodes.get(path[0])!;
    const e = nodes.get(path[path.length - 1])!;
    points.push({ ordinal: s.ordinal, lnglat: s.lnglat, kind: "start", label: "A" });
    points.push({ ordinal: e.ordinal, lnglat: e.lnglat, kind: "end", label: "B" });
  }

  return { lines, points, metres, floors };
}
