import { describe, expect, it } from "vitest";
import {
  BUILDING_FILE_FORMAT,
  BUILDING_KEY_BASE,
  buildingFileText,
  buildingKey,
  isValidBuildingShape,
  migrateLegacyBuilding,
  parseBuildingFileText,
  withBuildingDefaults,
  type StorageLike,
} from "./persistence";

function fakeStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("buildingKey", () => {
  it("suffixes the property id", () => {
    expect(buildingKey("casino")).toBe(`${BUILDING_KEY_BASE}:casino`);
    expect(buildingKey("mall")).toBe(`${BUILDING_KEY_BASE}:mall`);
  });
});

describe("migrateLegacyBuilding", () => {
  it("copies the legacy key to the casino key when casino key is empty", () => {
    const s = fakeStorage({ [BUILDING_KEY_BASE]: '{"legacy":true}' });
    migrateLegacyBuilding(s);
    expect(s.getItem(buildingKey("casino"))).toBe('{"legacy":true}');
    expect(s.getItem(BUILDING_KEY_BASE)).toBe('{"legacy":true}'); // never deletes
  });
  it("does not clobber an existing casino save", () => {
    const s = fakeStorage({
      [BUILDING_KEY_BASE]: '{"legacy":true}',
      [buildingKey("casino")]: '{"current":true}',
    });
    migrateLegacyBuilding(s);
    expect(s.getItem(buildingKey("casino"))).toBe('{"current":true}');
  });
  it("no-ops with no legacy key", () => {
    const s = fakeStorage();
    migrateLegacyBuilding(s);
    expect(s.getItem(buildingKey("casino"))).toBeNull();
  });
});

describe("isValidBuildingShape", () => {
  const valid = () => ({
    units: [{ id: "u1", polygon: [[0, 0]] }],
    levels: [{ ordinal: 0 }],
    openings: [{ id: "d1", unit: "u1", at: [0, 0] }],
    verticals: [],
    origin: [-122.4, 37.7],
  });

  it("accepts a well-formed building blob", () => {
    expect(isValidBuildingShape(valid())).toBe(true);
  });

  it("rejects a blob missing verticals (truncated save)", () => {
    const b = valid() as Record<string, unknown>;
    delete b.verticals;
    expect(isValidBuildingShape(b)).toBe(false);
  });

  it("rejects a blob missing origin (truncated save)", () => {
    const b = valid() as Record<string, unknown>;
    delete b.origin;
    expect(isValidBuildingShape(b)).toBe(false);
  });

  it("rejects a malformed origin (wrong length / non-numeric)", () => {
    expect(isValidBuildingShape({ ...valid(), origin: [-122.4] })).toBe(false);
    expect(isValidBuildingShape({ ...valid(), origin: ["-122.4", 37.7] })).toBe(false);
  });

  it("rejects non-array units/levels/openings", () => {
    expect(isValidBuildingShape({ ...valid(), units: {} })).toBe(false);
    expect(isValidBuildingShape({ ...valid(), levels: null })).toBe(false);
    expect(isValidBuildingShape({ ...valid(), openings: "nope" })).toBe(false);
  });

  it("rejects a unit without a polygon array", () => {
    expect(isValidBuildingShape({ ...valid(), units: [{ id: "u1" }] })).toBe(false);
  });

  it("rejects an opening without a string id", () => {
    expect(isValidBuildingShape({ ...valid(), openings: [{ unit: "u1", at: [0, 0] }] })).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(isValidBuildingShape(null)).toBe(false);
    expect(isValidBuildingShape(undefined)).toBe(false);
    expect(isValidBuildingShape("string")).toBe(false);
    expect(isValidBuildingShape(42)).toBe(false);
  });
});

const validBuilding = () => ({
  units: [{ id: "u1", polygon: [[0, 0]] }],
  levels: [{ ordinal: 0 }],
  openings: [{ id: "d1", unit: "u1", at: [0, 0] }],
  verticals: [],
  origin: [-122.4, 37.7],
});

describe("withBuildingDefaults", () => {
  it("defaults every additive collection missing from a legacy blob", () => {
    const b = withBuildingDefaults(validBuilding() as Record<string, unknown>);
    for (const k of ["cameras", "incidents", "patrols", "amenities", "fixtures", "footprints", "underlays", "occupants", "vectorUnderlays", "structures"])
      expect(b[k]).toEqual([]);
  });
  it("leaves present collections untouched", () => {
    const b = withBuildingDefaults({ ...validBuilding(), cameras: [{ id: "c1" }] } as Record<string, unknown>);
    expect(b.cameras).toEqual([{ id: "c1" }]);
  });
});

describe("building file round-trip", () => {
  it("round-trips a building through the file envelope", () => {
    const text = buildingFileText(validBuilding(), "casino");
    const parsed = parseBuildingFileText(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.propertyId).toBe("casino");
    expect(parsed!.building.units).toEqual(validBuilding().units);
    expect(parsed!.building.cameras).toEqual([]); // defaults applied on parse
    expect(parsed!.building.occupants).toEqual([]);
    expect(parsed!.building.vectorUnderlays).toEqual([]);
  });

  it("stamps the format marker", () => {
    const obj = JSON.parse(buildingFileText(validBuilding(), "mall"));
    expect(obj.format).toBe(BUILDING_FILE_FORMAT);
    expect(obj.version).toBe(3);
  });

  it("accepts a bare building blob (hand-copied localStorage value)", () => {
    const parsed = parseBuildingFileText(JSON.stringify(validBuilding()));
    expect(parsed).not.toBeNull();
    expect(parsed!.propertyId).toBeUndefined();
    expect(parsed!.building.cameras).toEqual([]);
  });

  it("rejects an envelope with an unknown format", () => {
    const text = JSON.stringify({ format: "something-else", building: validBuilding() });
    expect(parseBuildingFileText(text)).toBeNull();
  });

  it("rejects an envelope wrapping an invalid building (truncated save)", () => {
    const bad = validBuilding() as Record<string, unknown>;
    delete bad.verticals;
    expect(parseBuildingFileText(JSON.stringify({ format: BUILDING_FILE_FORMAT, building: bad }))).toBeNull();
  });

  it("rejects non-JSON and non-building JSON", () => {
    expect(parseBuildingFileText("not json {")).toBeNull();
    expect(parseBuildingFileText('{"hello":"world"}')).toBeNull();
    expect(parseBuildingFileText('"just a string"')).toBeNull();
  });
});

describe("3D-walk additive fields (forward-compat retention)", () => {
  const building3d = () => ({
    ...validBuilding(),
    levels: [{ ordinal: 0, name: "G", ceilingM: 4.2 }],
    cameras: [
      {
        id: "c1", ordinal: 0, at: [1, 1], heading: 0, fovDeg: 70, rangeM: 12,
        kind: "fixed", name: "Cam 1",
        mountM: 2.6, rollDeg: 12, mount: "wall", vfovDeg: 40,
      },
    ],
    structures: [
      {
        id: "s1", ordinal: 0, kind: "column",
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        heightM: 2.8, baseM: 0.2,
        round: { center: [0.5, 0.5], radiusM: 0.5 },
      },
    ],
  });

  it("parseBuildingFileText keeps camera mountM/rollDeg/mount/vfovDeg, Level.ceilingM, and structures intact", () => {
    const parsed = parseBuildingFileText(buildingFileText(building3d(), "casino"));
    expect(parsed).not.toBeNull();
    expect(parsed!.building.cameras).toEqual(building3d().cameras);
    expect(parsed!.building.levels).toEqual(building3d().levels);
    expect(parsed!.building.structures).toEqual(building3d().structures);
  });

  it("survives a full file round-trip unchanged", () => {
    const first = parseBuildingFileText(buildingFileText(building3d(), "casino"))!;
    const again = parseBuildingFileText(buildingFileText(first.building, "casino"))!;
    expect(again.building.cameras).toEqual(building3d().cameras);
    expect(again.building.levels).toEqual(building3d().levels);
    expect(again.building.structures).toEqual(building3d().structures);
  });
});
