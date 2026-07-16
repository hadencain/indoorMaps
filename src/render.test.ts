import { describe, it, expect } from "vitest";
import { unitsToGeoJSON, fixturesToGeoJSON, UNIT_HEIGHT_M } from "./render";
import type { Building } from "./types";

const b = {
  origin: [0, 0],
  levels: [{ ordinal: 0, name: "G" }],
  units: [
    { id: "r", ordinal: 0, name: "Room", category: "room", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: "c", ordinal: 0, name: "Hall", category: "corridor", polygon: [[0, 10], [10, 10], [10, 14], [0, 14]] },
    { id: "o", ordinal: 0, name: "Yard", category: "outside", polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] },
  ],
  openings: [], verticals: [], cameras: [],
  fixtures: [
    { id: "f1", ordinal: 0, kind: "slot", polygon: [[1, 1], [2, 1], [2, 2], [1, 2]] },
    { id: "f2", ordinal: 0, kind: "mystery", polygon: [[3, 3], [4, 3], [4, 4], [3, 4]] },
  ],
} as unknown as Building;

describe("extrusion height synthesis", () => {
  it("stamps heightM per unit category", () => {
    const props = unitsToGeoJSON(b).features.map((f) => f.properties as { id: string; heightM: number });
    expect(props.find((p) => p.id === "r")!.heightM).toBe(3.2);
    expect(props.find((p) => p.id === "c")!.heightM).toBe(0.15);
    expect(props.find((p) => p.id === "o")!.heightM).toBe(0);
  });
  it("stamps fixture heights with a default for unknown kinds", () => {
    const props = fixturesToGeoJSON(b).features.map((f) => f.properties as { kind: string; heightM: number });
    expect(props.find((p) => p.kind === "slot")!.heightM).toBe(1.6);
    expect(props.find((p) => p.kind === "mystery")!.heightM).toBe(0.8);
  });
  it("every Category has a height (exhaustive map)", () => {
    // compile-time Record<Category, number> enforces this; runtime sanity:
    expect(Object.keys(UNIT_HEIGHT_M).length).toBeGreaterThanOrEqual(11);
  });
});
