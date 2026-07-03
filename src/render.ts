import type { Building, Graph, LngLat } from "./types";
import { polygonRing, distM } from "./geo";

export type FC = GeoJSON.FeatureCollection;

/** Unit polygons (one Feature per unit, tagged with ordinal + category). */
export function unitsToGeoJSON(b: Building): FC {
  return {
    type: "FeatureCollection",
    features: b.units.map((u) => ({
      type: "Feature",
      properties: { id: u.id, ordinal: u.ordinal, category: u.category, name: u.name },
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
