import { describe, it, expect } from "vitest";
import { autoDoorsForRooms } from "./building";
import type { Building, Unit, Opening } from "./types";

// Two doorless rooms sitting under a corridor strip.
const roomA: Unit = {
  id: "a",
  ordinal: 0,
  name: "A",
  category: "room",
  polygon: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
};
const roomB: Unit = {
  id: "b",
  ordinal: 0,
  name: "B",
  category: "room",
  polygon: [
    [10, 0],
    [20, 0],
    [20, 10],
    [10, 10],
  ],
};
const corridor: Unit = {
  id: "c",
  ordinal: 0,
  name: "Hall",
  category: "corridor",
  polygon: [
    [0, 10],
    [20, 10],
    [20, 14],
    [0, 14],
  ],
};

function makeBuilding(units: Unit[], openings: Opening[]): Building {
  return {
    name: "t",
    origin: [0, 0],
    levels: [{ ordinal: 0, name: "G" }],
    units,
    openings,
    verticals: [],
    cameras: [],
  } as unknown as Building;
}

describe("autoDoorsForRooms", () => {
  it("returns nothing when the floor has no corridor", () => {
    const b = makeBuilding([roomA, roomB], []);
    expect(autoDoorsForRooms(b, 0)).toEqual([]);
  });

  it("places one door per doorless room once a corridor exists", () => {
    const b = makeBuilding([roomA, roomB, corridor], []);
    const placements = autoDoorsForRooms(b, 0);
    expect(placements.map((p) => p.unit).sort()).toEqual(["a", "b"]);
  });

  it("skips rooms that already have a door", () => {
    const existing: Opening = { id: "d-a", unit: "a", at: [5, 0] };
    const b = makeBuilding([roomA, roomB, corridor], [existing]);
    const placements = autoDoorsForRooms(b, 0);
    expect(placements.map((p) => p.unit)).toEqual(["b"]);
  });

  it("ignores rooms on other floors", () => {
    const upstairs: Unit = { ...roomA, id: "up", ordinal: 1 };
    const b = makeBuilding([roomA, corridor, upstairs], []);
    const placements = autoDoorsForRooms(b, 0);
    expect(placements.map((p) => p.unit)).toEqual(["a"]);
  });
});
