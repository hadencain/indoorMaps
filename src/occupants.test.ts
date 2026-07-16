import { describe, it, expect } from "vitest";
import { occupantAnchor, occupantsForUnit, occupantNamesByUnit } from "./occupants";
import type { Building, Occupant, Unit } from "./types";
import { mallBuilding } from "./demos/mall";
import { airportBuilding } from "./demos/airport";

const unit: Unit = {
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
};

const withOcc = (occupants: Occupant[]): Building =>
  ({
    origin: [0, 0],
    levels: [{ ordinal: 0, name: "G" }],
    units: [unit],
    openings: [],
    verticals: [],
    cameras: [],
    occupants,
  }) as Building;

const occ = (over: Partial<Occupant>): Occupant => ({
  id: "o1",
  name: "Ampersand Coffee",
  unitId: "u1",
  category: "dining",
  ...over,
});

describe("occupantAnchor", () => {
  it("returns the explicit anchor when set", () => {
    const b = withOcc([occ({ anchor: [2, 3] })]);
    expect(occupantAnchor(b, b.occupants![0])).toEqual([2, 3]);
  });
  it("falls back to the unit centroid when anchor is unset", () => {
    const b = withOcc([occ({})]);
    expect(occupantAnchor(b, b.occupants![0])).toEqual([5, 5]);
  });
  it("falls back to [0,0]-safe centroid when the unit is missing", () => {
    const b = withOcc([occ({ unitId: "ghost" })]);
    expect(occupantAnchor(b, b.occupants![0])).toEqual([0, 0]);
  });
});

describe("occupantsForUnit", () => {
  it("returns only that unit's occupants, in order", () => {
    const b = withOcc([occ({ id: "a" }), occ({ id: "b", unitId: "other" }), occ({ id: "c" })]);
    expect(occupantsForUnit(b, "u1").map((o) => o.id)).toEqual(["a", "c"]);
  });
  it("returns [] when occupants is undefined (pre-default building)", () => {
    const b = { ...withOcc([]), occupants: undefined } as Building;
    expect(occupantsForUnit(b, "u1")).toEqual([]);
  });
});

describe("occupantNamesByUnit", () => {
  it("joins multiple occupant names per unit with a separator", () => {
    const b = withOcc([occ({ id: "a", name: "Ampersand Coffee" }), occ({ id: "c", name: "Kiosk Nine" })]);
    expect(occupantNamesByUnit(b).get("u1")).toBe("Ampersand Coffee Kiosk Nine");
  });
  it("omits units with no occupants", () => {
    expect(occupantNamesByUnit(withOcc([])).has("u1")).toBe(false);
  });
});

describe("demo occupant seeding", () => {
  for (const [label, b] of [["mall", mallBuilding], ["airport", airportBuilding]] as const) {
    it(`${label}: every occupant resolves to a real unit, ids unique`, () => {
      const unitIds = new Set(b.units.map((u) => u.id));
      const occs = b.occupants ?? [];
      expect(occs.length).toBeGreaterThan(0);
      for (const o of occs) expect(unitIds.has(o.unitId)).toBe(true);
      expect(new Set(occs.map((o) => o.id)).size).toBe(occs.length);
    });

    it(`${label}: tenanted units carry space labels, occupants keep business names`, () => {
      const occs = b.occupants ?? [];
      const tenanted = new Set(occs.map((o) => o.unitId));
      for (const u of b.units.filter((x) => tenanted.has(x.id))) {
        expect(u.name).toMatch(/^Unit \d{3,}$/);
      }
      for (const o of occs) expect(o.name).not.toMatch(/^Unit \d{3,}$/);
    });
  }
});
