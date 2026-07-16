import { describe, it, expect } from "vitest";
import { routeSteps } from "./directions";
import { buildGraph } from "./graph";
import type { Building, Graph, NodeMeta, Opening, Unit, Vertical } from "./types";

// --- Fixture A: rooms A / B flanking a corridor, doors on the north wall of
// each room into the shared corridor above. Every plain door in graph.ts
// connects unit <-> door <-> corridor (not room-to-room directly), so A->B
// necessarily routes through the corridor hub.
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
    [20, 0],
    [30, 0],
    [30, 10],
    [20, 10],
  ],
};
const corridor: Unit = {
  id: "c",
  ordinal: 0,
  name: "Hall",
  category: "corridor",
  polygon: [
    [0, 10],
    [30, 10],
    [30, 14],
    [0, 14],
  ],
};
const doorA: Opening = { id: "dA", unit: "a", at: [5, 10] };
const doorB: Opening = { id: "dB", unit: "b", at: [25, 10] };

function makeBuilding(units: Unit[], openings: Opening[], verticals: Vertical[] = []): Building {
  return {
    origin: [0, 0],
    levels: [
      { ordinal: 0, name: "Ground" },
      { ordinal: 1, name: "Floor 2" },
    ],
    units,
    openings,
    verticals,
    cameras: [],
  };
}

describe("routeSteps", () => {
  it("returns [] for empty or single-node paths", () => {
    const b = makeBuilding([roomA, roomB, corridor], [doorA, doorB]);
    const graph = buildGraph(b);
    expect(routeSteps(graph, [], b)).toEqual([]);
    expect(routeSteps(graph, ["a"], b)).toEqual([]);
  });

  it("A -> B direct: start, exit-door, corridor leg, arrival door, arrive", () => {
    const b = makeBuilding([roomA, roomB, corridor], [doorA, doorB]);
    const graph = buildGraph(b);
    const path = ["a", "door:dA", "c", "door:dB", "b"];
    const texts = routeSteps(graph, path, b).map((s) => s.text);

    expect(texts[0]).toBe("Start at A");
    expect(texts.some((t) => t.startsWith("Exit A through the door"))).toBe(true);
    expect(texts.some((t) => /^Follow Hall for ~\d+ m$/.test(t))).toBe(true);
    expect(texts).toContain("Go through the door into B");
    expect(texts[texts.length - 1]).toBe("Arrive at B");
  });

  it("crosses a floor via a vertical: Take <name> to <level>", () => {
    const start: Unit = {
      id: "st",
      ordinal: 0,
      name: "Start Room",
      category: "room",
      polygon: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    };
    const c0: Unit = {
      id: "c0",
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
    const s0: Unit = {
      id: "s0",
      ordinal: 0,
      name: "Stairwell",
      category: "stairs",
      polygon: [
        [15, 0],
        [20, 0],
        [20, 5],
        [15, 5],
      ],
    };
    const s1: Unit = {
      id: "s1",
      ordinal: 1,
      name: "Landing",
      category: "stairs",
      polygon: [
        [15, 0],
        [20, 0],
        [20, 5],
        [15, 5],
      ],
    };
    const doorSt: Opening = { id: "dSt", unit: "st", at: [5, 10] };
    const doorS0: Opening = { id: "dS0", unit: "s0", at: [17, 5] };
    const vertical: Vertical = { a: "s0", b: "s1", name: "Stair OK" };
    const b = makeBuilding([start, c0, s0, s1], [doorSt, doorS0], [vertical]);
    const graph = buildGraph(b);
    const path = ["st", "door:dSt", "c0", "door:dS0", "s0", "s1"];
    const texts = routeSteps(graph, path, b).map((s) => s.text);

    expect(texts).toContain("Take Stair OK to Floor 2");
    expect(texts[texts.length - 1]).toBe("Arrive at Landing");
  });

  it("computes a left turn at a door (hand-computed geometry)", () => {
    // prev=(5,5) -> door=(5,10): incoming vector (0,5), i.e. heading north.
    // door=(5,10) -> mid=(0,10): outgoing vector (-5,0), i.e. heading west.
    // Rotating north 90 deg CCW (left) gives west, so this is a clean left turn:
    // cross = 0*0 - 5*(-5) = 25 > 0, dot = 0*-5 + 5*0 = 0, angle = atan2(25,0) = 90.
    // `mid` is NOT the goal (goal is a 4th node further on) so the door step
    // still gets a turn suffix instead of the "into <goal>" short-circuit.
    const nodes = new Map<string, NodeMeta>([
      ["start", { id: "start", ordinal: 0, xy: [5, 5], lnglat: [0, 0], kind: "unit", name: "Start" }],
      ["door", { id: "door:x", ordinal: 0, xy: [5, 10], lnglat: [0, 0], kind: "door" }],
      ["mid", { id: "mid", ordinal: 0, xy: [0, 10], lnglat: [0, 0], kind: "unit", name: "Mid" }],
      ["goal", { id: "goal", ordinal: 0, xy: [0, 20], lnglat: [0, 0], kind: "unit", name: "Goal" }],
    ]);
    const graph: Graph = { nodes, adj: new Map() };
    const b = makeBuilding([], []);
    const texts = routeSteps(graph, ["start", "door", "mid", "goal"], b).map((s) => s.text);
    expect(texts.some((t) => t.includes("turn left"))).toBe(true);
  });

  it("computes a right turn at a door (mirrored geometry)", () => {
    // Mirror of the left-turn fixture across x: outgoing now heads east (5,0)
    // instead of west. cross = 0*0 - 5*5 = -25 < 0 -> right turn.
    const nodes = new Map<string, NodeMeta>([
      ["start", { id: "start", ordinal: 0, xy: [5, 5], lnglat: [0, 0], kind: "unit", name: "Start" }],
      ["door", { id: "door:x", ordinal: 0, xy: [5, 10], lnglat: [0, 0], kind: "door" }],
      ["mid", { id: "mid", ordinal: 0, xy: [10, 10], lnglat: [0, 0], kind: "unit", name: "Mid" }],
      ["goal", { id: "goal", ordinal: 0, xy: [10, 20], lnglat: [0, 0], kind: "unit", name: "Goal" }],
    ]);
    const graph: Graph = { nodes, adj: new Map() };
    const b = makeBuilding([], []);
    const texts = routeSteps(graph, ["start", "door", "mid", "goal"], b).map((s) => s.text);
    expect(texts.some((t) => t.includes("turn right"))).toBe(true);
  });
});
