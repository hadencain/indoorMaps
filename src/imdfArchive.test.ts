import { describe, it, expect } from "vitest";
import { buildingToIMDFArchive } from "./imdfArchive";
import type { Building } from "./types";

// Real Building fields, origin at [0,0] so the metre→lng/lat projection is
// exercised (polygonRing) without pinning the test to exact float coordinates:
// assertions below check ring closure/length and property values, never the
// projected lng/lat numbers themselves.
const base: Building = {
  origin: [0, 0],
  levels: [{ ordinal: 0, name: "G" }],
  units: [
    {
      id: "u1",
      ordinal: 0,
      name: "Unit 101",
      category: "retail",
      polygon: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    },
  ],
  openings: [],
  verticals: [],
  cameras: [],
  structures: [
    {
      // heightM + baseM both set: passthrough, no clamping in the archive.
      id: "s1",
      ordinal: 0,
      kind: "column",
      polygon: [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 3],
      ],
      heightM: 4,
      baseM: 1,
    },
    {
      // heightM + baseM both unset: heightM ⇒ null (full ceiling), baseM ⇒ 0.
      id: "s2",
      ordinal: 0,
      kind: "obstacle",
      polygon: [
        [5, 5],
        [7, 5],
        [7, 7],
        [5, 7],
      ],
    },
  ],
};

const dec = new TextDecoder();
function fileObj(files: ReturnType<typeof buildingToIMDFArchive>, name: string): any {
  const f = files.find((x) => x.name === name);
  return f ? JSON.parse(dec.decode(f.data)) : null;
}

describe("IMDF archive structure.geojson", () => {
  it("emits one indoormaps:type=structure Polygon feature per structure", () => {
    const fc = fileObj(buildingToIMDFArchive(base), "structure.geojson");
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);

    const s1 = fc.features.find((f: { id: string }) => f.id === "s1");
    expect(s1.properties["indoormaps:type"]).toBe("structure");
    // app-extension convention: the marker lives in properties, never as a
    // top-level or `feature_type` member (mirrors camera.geojson).
    expect(s1.feature_type).toBeUndefined();
    expect(s1.properties.feature_type).toBeUndefined();
    expect(s1.properties.ordinal).toBe(0);
    expect(s1.properties.kind).toBe("column");
    expect(s1.geometry.type).toBe("Polygon");
  });

  it("passes heightM through when set and emits null when unset; baseM defaults to 0", () => {
    const fc = fileObj(buildingToIMDFArchive(base), "structure.geojson");
    const s1 = fc.features.find((f: { id: string }) => f.id === "s1");
    const s2 = fc.features.find((f: { id: string }) => f.id === "s2");

    expect(s1.properties.heightM).toBe(4);
    expect(s1.properties.baseM).toBe(1);

    expect(s2.properties.heightM).toBeNull();
    expect(s2.properties.baseM).toBe(0);
  });

  it("closes the polygon ring (first point repeated, length = verts + 1)", () => {
    const fc = fileObj(buildingToIMDFArchive(base), "structure.geojson");
    const s1 = fc.features.find((f: { id: string }) => f.id === "s1");
    const ring = s1.geometry.coordinates[0];
    // s1.polygon has 4 open vertices → closed ring has 5 points.
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("emits an empty FeatureCollection when structures is [], matching camera.geojson", () => {
    const files = buildingToIMDFArchive({ ...base, structures: [], cameras: [] });
    const structures = fileObj(files, "structure.geojson");
    const cameras = fileObj(files, "camera.geojson");
    expect(structures).not.toBeNull();
    expect(cameras).not.toBeNull();
    expect(structures.type).toBe("FeatureCollection");
    expect(structures.features).toEqual([]);
    // same empty shape as the sibling security-extension file.
    expect(structures).toEqual(cameras);
  });

  it("emits structure.geojson even when the structures collection is absent", () => {
    // A building with no `structures` field at all exercises the `?? []` guard.
    const noStructures: Building = {
      origin: [0, 0],
      levels: base.levels,
      units: base.units,
      openings: [],
      verticals: [],
      cameras: [],
    };
    const fc = fileObj(buildingToIMDFArchive(noStructures), "structure.geojson");
    expect(fc).not.toBeNull();
    expect(fc.features).toEqual([]);
  });
});

describe("IMDF archive file ordering", () => {
  it("keeps the existing files present with structure.geojson before manifest.json", () => {
    const names = buildingToIMDFArchive(base).map((f) => f.name);

    // Every previously-emitted file is still present.
    for (const n of [
      "venue.geojson",
      "building.geojson",
      "level.geojson",
      "unit.geojson",
      "opening.geojson",
      "structure.geojson",
      "manifest.json",
    ]) {
      expect(names).toContain(n);
    }

    // The core IMDF files keep their relative order, and the new file slots in
    // ahead of the manifest (which must stay last so the foreign member closes
    // the archive).
    const order = [
      "venue.geojson",
      "building.geojson",
      "level.geojson",
      "unit.geojson",
      "opening.geojson",
    ].map((n) => names.indexOf(n));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);

    expect(names.indexOf("structure.geojson")).toBeGreaterThan(names.indexOf("opening.geojson"));
    expect(names.indexOf("structure.geojson")).toBeLessThan(names.indexOf("manifest.json"));
    expect(names.indexOf("manifest.json")).toBe(names.length - 1);
  });
});
