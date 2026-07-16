import { describe, it, expect } from "vitest";
import { doorAdjacency, floorHealth, reviewFloor } from "./health";
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

  it("missingCorridor ignores doors owned by restricted units, matching graph.ts", () => {
    const vault: Unit = { ...roomA, id: "vault", security: "restricted" };
    const vaultDoor: Opening = { id: "dv", unit: "vault", at: [5, 0] };
    const b = makeBuilding([vault, roomB], [vaultDoor]); // no corridor
    expect(floorHealth(b, 0).missingCorridor).toBe(false); // graph never throws here
  });
});

describe("reviewFloor", () => {
  it("orders errors before warns before infos", () => {
    // roomA + unnamed roomB-shaped unit with sharedDoor but NO corridor ->
    // missing-corridor error; unnamed unit is also doorless/unnamed/vacant.
    const unnamed: Unit = { ...roomB, id: "un", name: "  " };
    const b = makeBuilding([roomA, unnamed], [sharedDoor]);
    (b as { occupants?: unknown[] }).occupants = [
      { id: "o1", name: "T", unitId: "a", category: "retail" },
    ];
    const issues = reviewFloor(b, 0);
    const order: Record<string, number> = { error: 0, warn: 1, info: 2 };
    const sevs = issues.map((i) => i.severity);
    expect(sevs).toEqual([...sevs].sort((x, y) => order[x] - order[y]));
    expect(issues.some((i) => i.id === "missing-corridor")).toBe(true);
    expect(issues.some((i) => i.id.startsWith("unnamed:"))).toBe(true);
    expect(issues.some((i) => i.id === "vacant:un")).toBe(true); // unnamed unit is also vacant
  });

  it("flags dangling and flat verticals", () => {
    const up: Unit = { ...roomA, id: "up", ordinal: 1 };
    const b = makeBuilding([roomA, roomB, corridor, up], [sharedDoor, hallDoor]);
    b.verticals = [
      { a: "a", b: "ghost", name: "Elevator A" }, // dangling
      { a: "a", b: "b", name: "Flat Link" }, // same ordinal
      { a: "a", b: "up", name: "Stair OK" }, // fine
    ];
    const issues = reviewFloor(b, 0);
    expect(issues.find((i) => i.id === "dangling-vertical:a:ghost")?.severity).toBe("error");
    expect(issues.find((i) => i.id === "flat-vertical:a:b")?.severity).toBe("warn");
    expect(issues.some((i) => i.message.includes("Stair OK"))).toBe(false);
  });

  it("emits no vacant issues for an occupant-free building", () => {
    const b = makeBuilding([roomA, roomB, corridor], [sharedDoor, hallDoor]);
    expect(reviewFloor(b, 0).some((i) => i.id.startsWith("vacant:"))).toBe(false);
  });

  it("flags one-sided plain doors as info severity", () => {
    const b = makeBuilding([roomA, roomB, corridor], [lonelyDoor, hallDoor]);
    const issues = reviewFloor(b, 0);
    const oneSidedIssue = issues.find((i) => i.id === "one-sided-door:d3");
    expect(oneSidedIssue?.severity).toBe("info");
    expect(oneSidedIssue?.message).toMatch(/opens onto unmapped space/);
  });

  it("a healthy floor reviews clean", () => {
    const b = makeBuilding([roomA, roomB, corridor], [sharedDoor, hallDoor]);
    // roomA has sharedDoor; roomB has hallDoor; corridor present; no verticals/occupants.
    expect(reviewFloor(b, 0)).toEqual([]);
  });
});
