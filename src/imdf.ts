import type {
  Building,
  Camera,
  CameraKind,
  Category,
  LngLat,
  MetreXY,
  Occupant,
  OccupantCategory,
  Opening,
  Unit,
} from "./types";
import { m2ll, ll2m, polygonRing, polygonCentroid } from "./geo";
import { occupantAnchor } from "./occupants";

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

  // App-extension: cameras as Point features marked `indoormaps:type=camera`.
  // IMDF has no camera feature type, so standard consumers ignore these; this
  // app rehydrates them on import for a lossless round-trip.
  for (const cam of b.cameras) {
    features.push({
      type: "Feature",
      id: cam.id,
      properties: {
        "indoormaps:type": "camera",
        ordinal: cam.ordinal,
        heading: cam.heading,
        fovDeg: cam.fovDeg,
        rangeM: cam.rangeM,
        kind: cam.kind,
        name: cam.name,
      },
      geometry: { type: "Point", coordinates: m2ll(b.origin, cam.at[0], cam.at[1]) },
    });
  }

  // Occupants (tenant businesses) — app extension, like cameras. Point at the
  // resolved anchor (explicit or unit centroid) so external viewers get a
  // usable POI; `unit` carries the unit linkage. Full fidelity incl. logo —
  // the interchange-grade archive export strips logos instead.
  for (const occ of b.occupants ?? []) {
    const at = occupantAnchor(b, occ);
    features.push({
      type: "Feature",
      id: occ.id,
      properties: {
        "indoormaps:type": "occupant",
        unit: occ.unitId,
        name: occ.name,
        category: occ.category,
        ...(occ.hours !== undefined && { hours: occ.hours }),
        ...(occ.phone !== undefined && { phone: occ.phone }),
        ...(occ.website !== undefined && { website: occ.website }),
        ...(occ.logo !== undefined && { logo: occ.logo }),
      },
      geometry: { type: "Point", coordinates: m2ll(b.origin, at[0], at[1]) },
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
  const cameras: Camera[] = [];
  const occupants: Occupant[] = [];
  for (const f of obj.features ?? []) {
    const ft = f.properties?.feature_type;
    if (f.properties?.["indoormaps:type"] === "occupant") {
      const p = f.properties as Record<string, unknown>;
      const coords = (f.geometry as { type?: string; coordinates?: [number, number] } | null)?.coordinates;
      occupants.push({
        id: String(f.id ?? `occ-${occupants.length}`),
        name: String(p.name ?? "Occupant"),
        unitId: String(p.unit ?? ""),
        category: (p.category as OccupantCategory) ?? "other",
        ...(typeof p.hours === "string" && { hours: p.hours }),
        ...(typeof p.phone === "string" && { phone: p.phone }),
        ...(typeof p.website === "string" && { website: p.website }),
        ...(typeof p.logo === "string" && { logo: p.logo }),
        ...(coords && { anchor: ll2m(origin, coords[0], coords[1]) }),
      });
      continue;
    }
    if (f.properties?.["indoormaps:type"] === "camera" && f.geometry?.type === "Point") {
      const [lng, lat] = f.geometry.coordinates as [number, number];
      cameras.push({
        id: String(f.id ?? `cam-${cameras.length}`),
        ordinal: Number(f.properties?.ordinal ?? 0),
        at: ll2m(origin, lng, lat),
        heading: Number(f.properties?.heading ?? 0),
        fovDeg: Number(f.properties?.fovDeg ?? 90),
        rangeM: Number(f.properties?.rangeM ?? 8),
        kind: (f.properties?.kind as CameraKind) ?? "fixed",
        name: String(f.properties?.name ?? `Camera ${cameras.length + 1}`),
      });
      continue;
    }
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
  // An imported file can reference units it doesn't contain (hand-edited or
  // foreign GeoJSON). Dangling occupants would persist and surface as
  // nowhere-pointing directory rows — drop them at the door.
  const unitIds = new Set(units.map((u) => u.id));
  return {
    origin,
    levels: meta.levels ?? [],
    units,
    openings,
    verticals: meta.verticals ?? [],
    cameras,
    occupants: occupants.filter((o) => unitIds.has(o.unitId)),
  };
}

function closesRing(ring: [number, number][]): boolean {
  if (ring.length < 2) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}
