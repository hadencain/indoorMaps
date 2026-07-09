import { describe, expect, it } from "vitest";
import { BUILDING_KEY_BASE, buildingKey, migrateLegacyBuilding, type StorageLike } from "./persistence";

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
