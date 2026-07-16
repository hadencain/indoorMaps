import { describe, it, expect } from "vitest";
import { buildGraph, isStepFreeVertical } from "./graph";
import { findRoute } from "./astar";
import type { Building, Unit, Vertical } from "./types";

const unit = (id: string, ordinal: number, category: Unit["category"]): Unit => ({
  id, ordinal, name: id, category,
  polygon: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => [x, y + 12 * ordinal]) as Unit["polygon"],
});
const uMap = (us: Unit[]) => new Map(us.map((u) => [u.id, u]));

describe("isStepFreeVertical", () => {
  const us = uMap([
    unit("elevA-0", 0, "elevator"), unit("elevA-1", 1, "elevator"),
    unit("stair-0", 0, "stairs"), unit("stair-1", 1, "stairs"),
    unit("esc-0", 0, "elevator"), unit("esc-1", 1, "elevator"), // UI-authored escalator mis-categorized as elevator
  ]);
  it("elevator vertical is step-free", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Elevator" }, us)).toBe(true));
  it("stairs-category vertical is not step-free", () =>
    expect(isStepFreeVertical({ a: "stair-0", b: "stair-1", name: "Grand Stair" }, us)).toBe(false));
  it("escalator by NAME is not step-free even if endpoints are elevator-category", () =>
    expect(isStepFreeVertical({ a: "esc-0", b: "esc-1", name: "Escalator Bank A" }, us)).toBe(false));
  it("ramp by name is step-free", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Accessible Ramp" }, us)).toBe(true));
  it("'Upstairs Elevator' with elevator endpoints IS step-free (no false match on substring)", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Upstairs Elevator" }, us)).toBe(true));
  it("'Grand Stair' with elevator endpoints is NOT step-free (word boundary still catches legitimate stair)", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Grand Stair" }, us)).toBe(false));
  it("'Stairwell' is NOT step-free (stair-family name)", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Stairwell" }, us)).toBe(false));
  it("'Staircase' is NOT step-free (stair-family name)", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Staircase" }, us)).toBe(false));
  it("'Stairway' is NOT step-free (stair-family name)", () =>
    expect(isStepFreeVertical({ a: "elevA-0", b: "elevA-1", name: "Stairway" }, us)).toBe(false));
  it("'Escalators' (plural) is NOT step-free", () =>
    expect(isStepFreeVertical({ a: "esc-0", b: "esc-1", name: "Escalators" }, us)).toBe(false));
});

describe("buildGraph stepFree option", () => {
  // two floors: rooms + a stair vertical AND an elevator vertical between them.
  const units = [
    unit("r0", 0, "room"), unit("c0", 0, "corridor"),
    unit("r1", 1, "room"), unit("c1", 1, "corridor"),
    unit("stair-0", 0, "stairs"), unit("stair-1", 1, "stairs"),
    unit("elev-0", 0, "elevator"), unit("elev-1", 1, "elevator"),
  ];
  const mk = (verticals: Vertical[]): Building =>
    ({ origin: [0, 0], levels: [{ ordinal: 0, name: "L1" }, { ordinal: 1, name: "L2" }],
       units,
       openings: [
         { id: "d1", unit: "r0", at: [5, 0] }, { id: "d2", unit: "stair-0", at: [5, 0] },
         { id: "d3", unit: "elev-0", at: [5, 0] }, { id: "d4", unit: "r1", at: [5, 12] },
         { id: "d5", unit: "stair-1", at: [5, 12] }, { id: "d6", unit: "elev-1", at: [5, 12] },
       ],
       verticals, cameras: [] }) as unknown as Building;

  it("default graph uses either vertical (route r0->r1 exists)", () => {
    const g = mk([{ a: "stair-0", b: "stair-1", name: "Stairs" }, { a: "elev-0", b: "elev-1", name: "Elevator" }]);
    expect(findRoute(buildGraph(g), "r0", "r1")).not.toBeNull();
  });
  it("stepFree drops the stair vertical but the elevator still connects the floors", () => {
    const g = mk([{ a: "stair-0", b: "stair-1", name: "Stairs" }, { a: "elev-0", b: "elev-1", name: "Elevator" }]);
    expect(findRoute(buildGraph(g, { stepFree: true }), "r0", "r1")).not.toBeNull();
  });
  it("stepFree yields NO cross-floor route when only stairs connect the floors", () => {
    const g = mk([{ a: "stair-0", b: "stair-1", name: "Stairs" }]);
    expect(findRoute(buildGraph(g), "r0", "r1")).not.toBeNull(); // stairs ok normally
    expect(findRoute(buildGraph(g, { stepFree: true }), "r0", "r1")).toBeNull(); // no step-free path
  });
});
