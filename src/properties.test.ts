import { describe, expect, it } from "vitest";
import {
  loadUserProperties,
  newPropertyId,
  pristineBuildingKey,
  propertyNameFor,
  saveUserProperties,
  starterBuilding,
  USER_PROPERTIES_KEY,
} from "./properties";
import { buildingKey, isValidBuildingShape, type StorageLike } from "./persistence";

function fakeStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("newPropertyId", () => {
  it("slugs a display name", () => {
    expect(newPropertyId("Westside Distribution Center", [])).toBe("westside-distribution-center");
    expect(newPropertyId("  Héllo!! World  ", [])).toBe("h-llo-world");
  });
  it("falls back for names with no usable characters", () => {
    expect(newPropertyId("!!!", [])).toBe("property");
    expect(newPropertyId("", [])).toBe("property");
  });
  it("dedupes against existing ids, including demo ids", () => {
    expect(newPropertyId("Casino", ["casino"])).toBe("casino-2");
    expect(newPropertyId("Casino", ["casino", "casino-2"])).toBe("casino-3");
  });
});

describe("user-property registry", () => {
  it("round-trips through storage", () => {
    const s = fakeStorage();
    saveUserProperties(s, [{ id: "warehouse", name: "Warehouse" }]);
    expect(loadUserProperties(s)).toEqual([{ id: "warehouse", name: "Warehouse" }]);
  });
  it("returns [] for missing, corrupt, or wrong-shape data", () => {
    expect(loadUserProperties(fakeStorage())).toEqual([]);
    expect(loadUserProperties(fakeStorage({ [USER_PROPERTIES_KEY]: "not json {" }))).toEqual([]);
    expect(loadUserProperties(fakeStorage({ [USER_PROPERTIES_KEY]: '{"a":1}' }))).toEqual([]);
  });
  it("filters malformed rows but keeps valid ones", () => {
    const s = fakeStorage({
      [USER_PROPERTIES_KEY]: JSON.stringify([{ id: "ok", name: "OK" }, { id: 5 }, null, "x"]),
    });
    expect(loadUserProperties(s)).toEqual([{ id: "ok", name: "OK" }]);
  });
});

describe("propertyNameFor", () => {
  it("resolves demo names, user names, and echoes unknown ids", () => {
    expect(propertyNameFor("casino", [])).toBe("Grand Casino");
    expect(propertyNameFor("warehouse", [{ id: "warehouse", name: "Warehouse 9" }])).toBe("Warehouse 9");
    expect(propertyNameFor("ghost", [])).toBe("ghost");
  });
});

describe("starterBuilding", () => {
  it("passes the same validation gate as a localStorage load", () => {
    expect(isValidBuildingShape(starterBuilding(null))).toBe(true);
  });
  it("bakes the calibrated underlay in", () => {
    const u = {
      ordinal: 0, dataUrl: "data:x", naturalW: 100, naturalH: 50,
      widthM: 82.5, offset: [0, 0] as [number, number], rotation: 0, opacity: 0.6,
    };
    expect(starterBuilding(u).underlays).toEqual([u]);
    expect(starterBuilding(null).underlays).toEqual([]);
  });
});

describe("pristineBuildingKey", () => {
  it("derives from the normal building key", () => {
    expect(pristineBuildingKey("warehouse")).toBe(`${buildingKey("warehouse")}:pristine`);
  });
});
