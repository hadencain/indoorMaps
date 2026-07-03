import type { Building, Category, LngLat, MetreXY, Opening, Unit } from "./types";
import { m2ll, ll2m, polygonRing, polygonCentroid } from "./geo";

// IMDF-flavored GeoJSON export. Real IMDF is a zip of one FeatureCollection per
// feature type; for portability we emit a single FeatureCollection whose features
// carry an IMDF-style `feature_type`, plus an `indoorMaps` foreign member holding
// the origin/levels/verticals so the file round-trips back into this app.

export function buildingToGeoJSON(b: Building): unknown {
  const features: unknown[] = [];

  for (const u of b.units) {
    features.push({
      type: "Feature",
      id: u.id,
      properties: { feature_type: "unit", name: u.name, category: u.category, ordinal: u.ordinal },
      geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, u.polygon)] },
    });
  }

  for (const op of b.openings) {
    features.push({
      type: "Feature",
      id: op.id,
      properties: { feature_type: "opening", unit: op.unit },
      geometry: { type: "Point", coordinates: m2ll(b.origin, op.at[0], op.at[1]) },
    });
  }

  for (const v of b.verticals) {
    const a = b.units.find((u) => u.id === v.a);
    const c = b.units.find((u) => u.id === v.b);
    const geometry =
      a && c
        ? {
            type: "LineString",
            coordinates: [
              m2ll(b.origin, ...(polygonCentroid(a.polygon) as [number, number])),
              m2ll(b.origin, ...(polygonCentroid(c.polygon) as [number, number])),
            ],
          }
        : null;
    features.push({
      type: "Feature",
      properties: { feature_type: "relationship", category: "vertical_connection", ...v },
      geometry,
    });
  }

  return {
    type: "FeatureCollection",
    indoorMaps: { version: 1, origin: b.origin, levels: b.levels, verticals: b.verticals },
    features,
  };
}

type Feat = {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown } | null;
};

/** Reconstruct a Building from a file this app exported. Returns null if it isn't one. */
export function geoJSONToBuilding(text: string): Building | null {
  let obj: {
    indoorMaps?: { origin?: LngLat; levels?: Building["levels"]; verticals?: Building["verticals"] };
    features?: Feat[];
  };
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const meta = obj.indoorMaps;
  if (!meta || !Array.isArray(meta.origin) || meta.origin.length !== 2) return null;
  const origin = meta.origin as LngLat;

  const units: Unit[] = [];
  const openings: Opening[] = [];
  for (const f of obj.features ?? []) {
    const ft = f.properties?.feature_type;
    if (ft === "unit" && f.geometry?.type === "Polygon") {
      const ring = (f.geometry.coordinates as [number, number][][])[0] ?? [];
      const open = closesRing(ring) ? ring.slice(0, -1) : ring;
      units.push({
        id: String(f.id ?? `u-${units.length}`),
        ordinal: Number(f.properties?.ordinal ?? 0),
        name: String(f.properties?.name ?? "Unit"),
        category: (f.properties?.category as Category) ?? "room",
        polygon: open.map(([lng, lat]) => ll2m(origin, lng, lat) as MetreXY),
      });
    } else if (ft === "opening" && f.geometry?.type === "Point") {
      const [lng, lat] = f.geometry.coordinates as [number, number];
      openings.push({
        id: String(f.id ?? `d-${openings.length}`),
        unit: String(f.properties?.unit ?? ""),
        at: ll2m(origin, lng, lat),
      });
    }
  }
  if (units.length === 0) return null;
  return { origin, levels: meta.levels ?? [], units, openings, verticals: meta.verticals ?? [] };
}

function closesRing(ring: [number, number][]): boolean {
  if (ring.length < 2) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}
