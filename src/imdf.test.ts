import { describe, it, expect } from "vitest";
import { buildingToGeoJSON, geoJSONToBuilding } from "./imdf";
import { buildingToIMDFArchive } from "./imdfArchive";
import type { Building } from "./types";

const base: Building = {
  origin: [-73.99, 40.75],
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
  occupants: [
    {
      id: "o1",
      name: "Ampersand Coffee",
      unitId: "u1",
      category: "dining",
      hours: "Mon–Sat 10–9",
      phone: "555-0100",
      website: "https://example.test",
      logo: "data:image/png;base64,AAAA",
      anchor: [4, 6],
    },
    { id: "o2", name: "Kiosk Nine", unitId: "u1", category: "retail" }, // minimal: no anchor/meta
  ],
};

describe("geoJSONToBuilding category validation", () => {
  it("falls back an unrecognized category to room, keeps a valid one unchanged", () => {
    const fcObj = JSON.parse(JSON.stringify(buildingToGeoJSON(base)));
    fcObj.features.push({
      type: "Feature",
      id: "u-bad",
      properties: { feature_type: "unit", name: "Bad", category: "not-a-real-category", ordinal: 0 },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 20], [10, 20], [10, 30], [0, 30], [0, 20]]],
      },
    });
    const back = geoJSONToBuilding(JSON.stringify(fcObj));
    expect(back).not.toBeNull();
    expect(back!.units.find((u) => u.id === "u1")!.category).toBe("retail");
    expect(back!.units.find((u) => u.id === "u-bad")!.category).toBe("room");
  });
});

describe("occupant single-file round-trip", () => {
  it("exports one indoormaps:type=occupant Point feature per occupant", () => {
    const fcObj = JSON.parse(JSON.stringify(buildingToGeoJSON(base)));
    const occs = fcObj.features.filter(
      (f: { properties?: Record<string, unknown> }) => f.properties?.["indoormaps:type"] === "occupant",
    );
    expect(occs).toHaveLength(2);
    expect(occs[0].properties.name).toBe("Ampersand Coffee");
    expect(occs[0].properties.unit).toBe("u1");
    expect(occs[0].properties.logo).toBe("data:image/png;base64,AAAA");
    expect(occs[0].geometry.type).toBe("Point");
  });

  it("round-trips occupants through geoJSONToBuilding", () => {
    const back = geoJSONToBuilding(JSON.stringify(buildingToGeoJSON(base)));
    expect(back).not.toBeNull();
    expect(back!.occupants).toHaveLength(2);
    const o1 = back!.occupants!.find((o) => o.id === "o1")!;
    expect(o1.name).toBe("Ampersand Coffee");
    expect(o1.unitId).toBe("u1");
    expect(o1.category).toBe("dining");
    expect(o1.hours).toBe("Mon–Sat 10–9");
    expect(o1.phone).toBe("555-0100");
    expect(o1.website).toBe("https://example.test");
    expect(o1.logo).toBe("data:image/png;base64,AAAA");
    expect(o1.anchor![0]).toBeCloseTo(4, 3);
    expect(o1.anchor![1]).toBeCloseTo(6, 3);
    const o2 = back!.occupants!.find((o) => o.id === "o2")!;
    expect(o2.hours).toBeUndefined();
    // o2 had no explicit anchor: export wrote the centroid, so the re-import
    // carries anchor=[~5,~5] — explicit-anchor semantics, same visual point.
    expect(o2.anchor![0]).toBeCloseTo(5, 3);
  });

  it("a building with no occupants exports none and imports as []", () => {
    const b = { ...base, occupants: [] };
    const back = geoJSONToBuilding(JSON.stringify(buildingToGeoJSON(b)));
    expect(back!.occupants).toEqual([]);
  });

  it("drops imported occupants whose unit does not exist", () => {
    const fcObj = JSON.parse(JSON.stringify(buildingToGeoJSON(base)));
    const ghost = {
      type: "Feature",
      id: "o-ghost",
      properties: { "indoormaps:type": "occupant", unit: "no-such-unit", name: "Ghost", category: "retail" },
      geometry: { type: "Point", coordinates: [-73.99, 40.75] },
    };
    fcObj.features.push(ghost);
    const back = geoJSONToBuilding(JSON.stringify(fcObj));
    expect(back!.occupants!.map((o) => o.id)).toEqual(["o1", "o2"]);
  });
});

describe("IMDF archive occupant + anchor files", () => {
  const dec = new TextDecoder();
  const fileObj = (name: string) => {
    const files = buildingToIMDFArchive(base);
    const f = files.find((x) => x.name === name);
    return f ? JSON.parse(dec.decode(f.data)) : null;
  };

  it("emits anchor.geojson with one Point per occupant, unit_id linked", () => {
    const anchors = fileObj("anchor.geojson");
    expect(anchors.features).toHaveLength(2);
    const a1 = anchors.features.find((f: { id: string }) => f.id === "anchor-o1");
    expect(a1.properties.unit_id).toBe("u1");
    expect(a1.geometry.type).toBe("Point");
  });

  it("emits occupant.geojson with null geometry, anchor_id, and NO logo", () => {
    const occs = fileObj("occupant.geojson");
    expect(occs.features).toHaveLength(2);
    const o1 = occs.features.find((f: { id: string }) => f.id === "o1");
    expect(o1.geometry).toBeNull();
    expect(o1.properties.anchor_id).toBe("anchor-o1");
    expect(o1.properties.name).toBe("Ampersand Coffee");
    expect(o1.properties.category).toBe("dining");
    expect(o1.properties.hours).toBe("Mon–Sat 10–9");
    expect(o1.properties.logo).toBeUndefined();
  });

  it("feature_type is stamped in properties on both files, matching unit.geojson's convention", () => {
    const anchors = fileObj("anchor.geojson");
    const occs = fileObj("occupant.geojson");
    expect(anchors.features[0].properties.feature_type).toBe("anchor");
    expect(anchors.features[0].feature_type).toBeUndefined();
    expect(occs.features[0].properties.feature_type).toBe("occupant");
    expect(occs.features[0].feature_type).toBeUndefined();
  });
});
