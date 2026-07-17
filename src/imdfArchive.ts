// True IMDF-style archive export: one GeoJSON FeatureCollection per feature
// type, plus security extensions (camera.geojson, zone.geojson) and a
// manifest.json foreign member carrying the app's origin/levels/verticals so
// the archive round-trips. Pure module — zips via zip.ts in the store action.
//
// The existing single-file `imdf.ts` export stays untouched; this is additive.

import type { Building, LngLat, MetreXY, SecurityLevel } from "./types";
import { m2ll, polygonRing, bbox } from "./geo";
import { occupantAnchor } from "./occupants";
import type { ZipFile } from "./zip";

const enc = new TextEncoder();

interface Feature {
  type: "Feature";
  id?: string;
  properties: Record<string, unknown>;
  geometry: unknown;
}

function fc(features: Feature[], foreign?: Record<string, unknown>): unknown {
  return { type: "FeatureCollection", ...foreign, features };
}

function file(name: string, obj: unknown): ZipFile {
  return { name, data: enc.encode(JSON.stringify(obj, null, 2)) };
}

/** Closed lng/lat ring (a GeoJSON Polygon outer ring) for a metre bbox. */
function bboxRing(origin: LngLat, pts: MetreXY[]): LngLat[] | null {
  if (pts.length === 0) return null;
  const [x0, y0, x1, y1] = bbox(pts);
  const ring: MetreXY[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return polygonRing(origin, ring);
}

/**
 * One IMDF-shaped FeatureCollection file per feature type. Returns the file
 * list; the caller zips it. `manifest.json` carries the `indoorMaps` foreign
 * member (origin/levels/verticals) needed to rebuild the app's Building.
 */
export function buildingToIMDFArchive(b: Building): ZipFile[] {
  const files: ZipFile[] = [];
  const allPts = b.units.flatMap((u) => u.polygon);
  const footprint = bboxRing(b.origin, allPts);

  // venue.geojson — one venue feature covering the building footprint.
  files.push(
    file(
      "venue.geojson",
      fc([
        {
          type: "Feature",
          id: "venue",
          properties: { feature_type: "venue", name: "Venue" },
          geometry: footprint ? { type: "Polygon", coordinates: [footprint] } : null,
        },
      ]),
    ),
  );

  // building.geojson — single building feature, same footprint.
  files.push(
    file(
      "building.geojson",
      fc([
        {
          type: "Feature",
          id: "building",
          properties: { feature_type: "building", name: "Building" },
          geometry: footprint ? { type: "Polygon", coordinates: [footprint] } : null,
        },
      ]),
    ),
  );

  // level.geojson — one feature per level, geometry = that floor's extent.
  files.push(
    file(
      "level.geojson",
      fc(
        b.levels.map((lv) => {
          const floorPts = b.units
            .filter((u) => u.ordinal === lv.ordinal)
            .flatMap((u) => u.polygon);
          const ring = bboxRing(b.origin, floorPts) ?? footprint;
          return {
            type: "Feature",
            id: `level-${lv.ordinal}`,
            properties: { feature_type: "level", ordinal: lv.ordinal, name: lv.name },
            geometry: ring ? { type: "Polygon", coordinates: [ring] } : null,
          };
        }),
      ),
    ),
  );

  // unit.geojson — one feature per unit, security carried into properties.
  files.push(
    file(
      "unit.geojson",
      fc(
        b.units.map((u) => ({
          type: "Feature",
          id: u.id,
          properties: {
            feature_type: "unit",
            name: u.name,
            category: u.category,
            ordinal: u.ordinal,
            security: u.security ?? "public",
          },
          geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, u.polygon)] },
        })),
      ),
    ),
  );

  // opening.geojson — one point per opening, kind carried into properties.
  files.push(
    file(
      "opening.geojson",
      fc(
        b.openings.map((op) => ({
          type: "Feature",
          id: op.id,
          properties: { feature_type: "opening", unit: op.unit, kind: op.kind ?? "door" },
          geometry: { type: "Point", coordinates: m2ll(b.origin, op.at[0], op.at[1]) },
        })),
      ),
    ),
  );

  // IMDF occupant model: occupant (featureless business record) → anchor
  // (Point inside the unit, carries unit_id) → unit. Logos are deliberately
  // NOT exported here — interchange format, no data-URI payloads (the
  // single-file export keeps full fidelity instead).
  const occupants = b.occupants ?? [];
  files.push(
    file(
      "anchor.geojson",
      fc(
        occupants.map((occ) => {
          const at = occupantAnchor(b, occ);
          return {
            type: "Feature",
            id: `anchor-${occ.id}`,
            properties: { feature_type: "anchor", unit_id: occ.unitId },
            geometry: { type: "Point", coordinates: m2ll(b.origin, at[0], at[1]) },
          };
        }),
      ),
    ),
  );
  files.push(
    file(
      "occupant.geojson",
      fc(
        occupants.map((occ) => ({
          type: "Feature",
          id: occ.id,
          properties: {
            feature_type: "occupant",
            name: occ.name,
            category: occ.category,
            ...(occ.hours !== undefined && { hours: occ.hours }),
            ...(occ.phone !== undefined && { phone: occ.phone }),
            ...(occ.website !== undefined && { website: occ.website }),
            anchor_id: `anchor-${occ.id}`,
          },
          geometry: null,
        })),
      ),
    ),
  );

  // camera.geojson — security extension. Same marker/property shape as the
  // single-file export's camera app-extension (imdf.ts).
  files.push(
    file(
      "camera.geojson",
      fc(
        b.cameras.map((cam) => ({
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
        })),
      ),
    ),
  );

  // zone.geojson — security extension. Units grouped by their `security` string;
  // one MultiPolygon feature per present security level.
  const levels: SecurityLevel[] = ["public", "secure", "restricted"];
  const zoneFeatures: Feature[] = [];
  for (const sec of levels) {
    const members = b.units.filter((u) => (u.security ?? "public") === sec);
    if (members.length === 0) continue;
    zoneFeatures.push({
      type: "Feature",
      id: `zone-${sec}`,
      properties: { feature_type: "zone", security: sec, count: members.length },
      geometry: {
        type: "MultiPolygon",
        coordinates: members.map((u) => [polygonRing(b.origin, u.polygon)]),
      },
    });
  }
  files.push(file("zone.geojson", fc(zoneFeatures)));

  // structure.geojson — app extension (columns / obstacles). IMDF has no
  // occlusion concept, so like camera.geojson this rides the "indoormaps:type"
  // marker convention rather than a native `feature_type`. heightM is passed
  // through UNCLAMPED and null when unset: this is an interchange file, not a
  // MapLibre expression consumer, so null legitimately means "full ceiling
  // height" and preserves the authored "unset" (render-time clamping lives in
  // structuresToGeoJSON, not here). Emitted even with zero structures, matching
  // camera.geojson — always a FeatureCollection, possibly with an empty list.
  files.push(
    file(
      "structure.geojson",
      fc(
        (b.structures ?? []).map((s) => ({
          type: "Feature",
          id: s.id,
          properties: {
            "indoormaps:type": "structure",
            ordinal: s.ordinal,
            kind: s.kind,
            heightM: s.heightM ?? null,
            baseM: s.baseM ?? 0,
          },
          geometry: { type: "Polygon", coordinates: [polygonRing(b.origin, s.polygon)] },
        })),
      ),
    ),
  );

  // manifest.json — foreign member carrying origin/levels/verticals so the
  // archive can be reassembled into a Building (re-import is a fast-follow).
  files.push(
    file("manifest.json", {
      indoorMaps: {
        version: 1,
        origin: b.origin,
        levels: b.levels,
        verticals: b.verticals,
      },
    }),
  );

  return files;
}
