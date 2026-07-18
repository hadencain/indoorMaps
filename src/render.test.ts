import { describe, it, expect } from "vitest";
import {
  unitsToGeoJSON,
  fixturesToGeoJSON,
  structuresToGeoJSON,
  vectorUnderlaysToGeoJSON,
  levelCeilingM,
  UNIT_HEIGHT_M,
  DEFAULT_CEILING_M,
} from "./render";
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

describe("Level.ceilingM + structures", () => {
  it("DEFAULT_CEILING_M pins the legacy synthesized ceiling", () => {
    expect(DEFAULT_CEILING_M).toBe(3.2);
  });

  it("unitsToGeoJSON heightM honors Level.ceilingM for full-height categories only", () => {
    const cb = {
      origin: [0, 0],
      levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }],
      units: [
        { id: "r", ordinal: 0, name: "Room", category: "room", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
        { id: "c", ordinal: 0, name: "Hall", category: "corridor", polygon: [[0, 10], [10, 10], [10, 14], [0, 14]] },
      ],
      openings: [], verticals: [], cameras: [],
    } as unknown as Building;
    const props = unitsToGeoJSON(cb).features.map((f) => f.properties as { id: string; heightM: number });
    expect(props.find((p) => p.id === "r")!.heightM).toBe(4.5);
    expect(props.find((p) => p.id === "c")!.heightM).toBe(0.15); // low slab: fixed
  });

  it("structuresToGeoJSON stamps non-null heightM/baseM defaults", () => {
    const sb = {
      origin: [0, 0],
      levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }, { ordinal: 1, name: "1" }],
      units: [], openings: [], verticals: [], cameras: [],
      structures: [
        { id: "s0", ordinal: 0, kind: "column", polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { id: "s1", ordinal: 1, kind: "obstacle", polygon: [[2, 2], [3, 2], [3, 3], [2, 3]] },
        { id: "s2", ordinal: 0, kind: "obstacle", polygon: [[4, 4], [5, 4], [5, 5], [4, 5]], heightM: 2.2, baseM: 2.0 },
      ],
    } as unknown as Building;
    const props = structuresToGeoJSON(sb).features.map(
      (f) => f.properties as { id: string; kind: string; heightM: number; baseM: number },
    );
    // heightM absent → the level's ceilingM; baseM absent → 0.
    expect(props.find((p) => p.id === "s0")).toMatchObject({ kind: "column", heightM: 4.5, baseM: 0 });
    // level without ceilingM → DEFAULT_CEILING_M.
    expect(props.find((p) => p.id === "s1")).toMatchObject({ heightM: DEFAULT_CEILING_M, baseM: 0 });
    // authored values pass through.
    expect(props.find((p) => p.id === "s2")).toMatchObject({ heightM: 2.2, baseM: 2.0 });
  });

  it("clamps an authored heightM above the level ceiling at render time (spec failure-mode rule)", () => {
    const sb = {
      origin: [0, 0],
      levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }, { ordinal: 1, name: "1" }],
      units: [], openings: [], verticals: [], cameras: [],
      structures: [
        { id: "tall", ordinal: 0, kind: "column", polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], heightM: 10 },
        { id: "tall-default", ordinal: 1, kind: "obstacle", polygon: [[2, 2], [3, 2], [3, 3], [2, 3]], heightM: 10 },
        { id: "under", ordinal: 0, kind: "obstacle", polygon: [[4, 4], [5, 4], [5, 5], [4, 5]], heightM: 2.2 },
      ],
    } as unknown as Building;
    const props = structuresToGeoJSON(sb).features.map(
      (f) => f.properties as { id: string; heightM: number },
    );
    // Above the authored ceiling → clamped to it; the stored value stays 10.
    expect(props.find((p) => p.id === "tall")!.heightM).toBe(4.5);
    // Above the default ceiling → clamped to DEFAULT_CEILING_M.
    expect(props.find((p) => p.id === "tall-default")!.heightM).toBe(DEFAULT_CEILING_M);
    // Under the ceiling → authored value passes through untouched.
    expect(props.find((p) => p.id === "under")!.heightM).toBe(2.2);
    // Render never mutates the data: the authored value survives in sb.
    expect(sb.structures![0].heightM).toBe(10);
  });

  it("clamps baseM into [0, emitted heightM] (MapLibre base <= height contract)", () => {
    const sb = {
      origin: [0, 0],
      levels: [{ ordinal: 0, name: "G", ceilingM: 3.2 }],
      units: [], openings: [], verticals: [], cameras: [],
      structures: [
        // Valid authored soffit the ceiling clamp would otherwise invert:
        // heightM 5 clamps to 3.2, so baseM 4 must follow it down.
        { id: "inverted-by-clamp", ordinal: 0, kind: "obstacle", polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], heightM: 5, baseM: 4 },
        // Hand-edited inversion: baseM directly above heightM.
        { id: "authored-inverted", ordinal: 0, kind: "obstacle", polygon: [[2, 2], [3, 2], [3, 3], [2, 3]], heightM: 1.0, baseM: 2.0 },
        // Hand-edited negatives floor at 0.
        { id: "negatives", ordinal: 0, kind: "obstacle", polygon: [[4, 4], [5, 4], [5, 5], [4, 5]], heightM: -2, baseM: -1 },
        // Valid soffit under the ceiling passes through untouched.
        { id: "valid-soffit", ordinal: 0, kind: "obstacle", polygon: [[6, 6], [7, 6], [7, 7], [6, 7]], heightM: 2.2, baseM: 2.0 },
      ],
    } as unknown as Building;
    const props = structuresToGeoJSON(sb).features.map(
      (f) => f.properties as { id: string; heightM: number; baseM: number },
    );
    expect(props.find((p) => p.id === "inverted-by-clamp")).toMatchObject({ heightM: 3.2, baseM: 3.2 });
    expect(props.find((p) => p.id === "authored-inverted")).toMatchObject({ heightM: 1.0, baseM: 1.0 });
    expect(props.find((p) => p.id === "negatives")).toMatchObject({ heightM: 0, baseM: 0 });
    expect(props.find((p) => p.id === "valid-soffit")).toMatchObject({ heightM: 2.2, baseM: 2.0 });
    // The MapLibre contract holds on every emitted feature.
    for (const p of props) {
      expect(p.heightM).toBeGreaterThanOrEqual(0);
      expect(p.baseM).toBeGreaterThanOrEqual(0);
      expect(p.baseM).toBeLessThanOrEqual(p.heightM);
    }
    // Render never mutates the data: authored values survive in sb.
    expect(sb.structures![0]).toMatchObject({ heightM: 5, baseM: 4 });
  });

  it("levelCeilingM floors a hand-edited non-positive ceilingM at 0 (live fill-extrusion contract)", () => {
    const cb = {
      origin: [0, 0],
      levels: [{ ordinal: 0, name: "G", ceilingM: -1 }, { ordinal: 1, name: "1", ceilingM: 0 }],
      units: [
        { id: "r", ordinal: 0, name: "Room", category: "room", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      ],
      openings: [], verticals: [], cameras: [],
    } as unknown as Building;
    expect(levelCeilingM(cb, 0)).toBe(0); // negative → floored
    expect(levelCeilingM(cb, 1)).toBe(0); // 0 is legal (flat), passes
    expect(levelCeilingM(cb, 9)).toBe(DEFAULT_CEILING_M); // unknown ordinal → default
    // The floored value is what the live unit-extrude layer sees.
    const props = unitsToGeoJSON(cb).features.map((f) => f.properties as { id: string; heightM: number });
    expect(props.find((p) => p.id === "r")!.heightM).toBe(0);
  });

  it("a building with no structures yields an empty collection", () => {
    expect(structuresToGeoJSON({ origin: [0, 0], levels: [] } as unknown as Building).features).toEqual([]);
  });
});

describe("vectorUnderlaysToGeoJSON", () => {
  it("emits one LineString feature per polyline, tagged with ordinal", () => {
    const vb = {
      origin: [0, 0],
      vectorUnderlays: [
        {
          ordinal: 0,
          name: "DXF import",
          polylines: [
            [[0, 0], [10, 0]],
            [[0, 10], [10, 10], [10, 0]],
          ],
          opacity: 0.5,
        },
        { ordinal: 1, name: "DXF import", polylines: [[[0, 0], [5, 5]]], opacity: 0.5 },
      ],
    } as unknown as Building;
    const fc = vectorUnderlaysToGeoJSON(vb);
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].geometry).toEqual({
      type: "LineString",
      coordinates: expect.any(Array),
    });
    expect(fc.features.map((f) => f.properties!.ordinal)).toEqual([0, 0, 1]);
  });

  it("a building with no vectorUnderlays yields an empty collection", () => {
    const vb = { origin: [0, 0] } as unknown as Building;
    expect(vectorUnderlaysToGeoJSON(vb).features).toEqual([]);
  });
});
