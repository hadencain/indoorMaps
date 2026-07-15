import { describe, it, expect } from "vitest";
import { doorAdjacency, floorHealth } from "./health";
import type { Building, Unit, Opening } from "../types";

// Two rooms sharing the wall x=10, plus a corridor strip above both.
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

const sharedDoor: Opening = { id: "d1", unit: "a", at: [10, 5] }; // on the a|b party wall
const hallDoor: Opening = { id: "d2", unit: "b", at: [15, 10] }; // b → corridor
const lonelyDoor: Opening = { id: "d3", unit: "a", at: [5, 0] }; // outside wall, nothing beyond

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

describe("doorAdjacency", () => {
  it("finds the unit on the far side of a party wall", () => {
    const adj = doorAdjacency([roomA, roomB, corridor], sharedDoor);
    expect(adj.owner).toBe("a");
    expect(adj.other).toBe("b");
  });

  it("finds the corridor through a corridor-facing door", () => {
    const adj = doorAdjacency([roomA, roomB, corridor], hallDoor);
    expect(adj.owner).toBe("b");
    expect(adj.other).toBe("c");
  });

  it("returns null other for a door with nothing beyond it", () => {
    const adj = doorAdjacency([roomA, roomB, corridor], lonelyDoor);
    expect(adj.owner).toBe("a");
    expect(adj.other).toBeNull();
  });
});

describe("floorHealth", () => {
  it("flags doorless space units", () => {
    const b = makeBuilding([roomA, roomB, corridor], [hallDoor]);
    const h = floorHealth(b, 0);
    expect(h.doorlessRoomIds).toEqual(["a"]);
  });

  it("flags one-sided plain doors but not entrances", () => {
    const entrance: Opening = { ...lonelyDoor, id: "d4", kind: "entrance" };
    const b = makeBuilding([roomA, roomB, corridor], [lonelyDoor, entrance, hallDoor]);
    const h = floorHealth(b, 0);
    expect(h.oneSidedDoorIds).toEqual(["d3"]);
  });

  it("flags a floor with plain doors but no corridor", () => {
    const b = makeBuilding([roomA, roomB], [sharedDoor]);
    expect(floorHealth(b, 0).missingCorridor).toBe(true);
    const ok = makeBuilding([roomA, roomB, corridor], [sharedDoor]);
    expect(floorHealth(ok, 0).missingCorridor).toBe(false);
  });

  it("ignores other floors entirely", () => {
    const upstairs: Unit = { ...roomA, id: "u", ordinal: 1 };
    const b = makeBuilding([roomA, corridor, upstairs], [hallDoor]);
    const h = floorHealth(b, 0);
    expect(h.doorlessRoomIds).toEqual(["a"]);
    expect(floorHealth(b, 1).missingCorridor).toBe(false); // no doors upstairs → no corridor needed
  });

  it("excludes outside-owned plain doors from missingCorridor, matching graph.ts", () => {
    // Outside unit owning the floor's ONLY plain door, no corridor anywhere.
    // graph.ts skips outside-owned doors before its no-route check, so this
    // must NOT flag missingCorridor — with the old all-doors logic it would.
    const outside: Unit = {
      id: "outside",
      ordinal: 0,
      name: "Outside",
      category: "outside",
      polygon: [
        [20, 0],
        [30, 0],
        [30, 10],
        [20, 10],
      ],
    };
    const outsideDoor: Opening = {
      id: "outside_door",
      unit: "outside",
      at: [25, 0],
    };
    const b = makeBuilding([roomA, outside], [outsideDoor]);
    expect(floorHealth(b, 0).missingCorridor).toBe(false);
  });
});
