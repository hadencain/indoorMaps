import { describe, it, expect } from "vitest";
import { losShortcut, roundCorners, WALK_MPS } from "./route-smooth";
import type { MetreXY } from "./types";

const wall = (a: MetreXY, b: MetreXY) => ({ a, b });

describe("losShortcut", () => {
  it("drops an intermediate detour point when the direct segment is clear", () => {
    // door(0,5) -> hub(10,9) -> door(20,5): no walls in between
    expect(losShortcut([[0, 5], [10, 9], [20, 5]], [])).toEqual([[0, 5], [20, 5]]);
  });
  it("keeps the detour when a wall blocks the direct segment", () => {
    const blocking = [wall([10, 0], [10, 4])]; // pillar wall crossing y in [0,4]
    const pts: MetreXY[] = [[0, 2], [10, 8], [20, 2]];
    expect(losShortcut(pts, blocking)).toEqual(pts);
  });
  it("does not treat the endpoint's own wall as blocking (doors sit on walls)", () => {
    // start point ON a wall; direct segment leaves it immediately
    const walls = [wall([0, 0], [0, 10])];
    expect(losShortcut([[0, 5], [5, 7], [10, 5]], walls)).toEqual([[0, 5], [10, 5]]);
  });
  it("keeps endpoints for degenerate inputs", () => {
    expect(losShortcut([[0, 0]], [])).toEqual([[0, 0]]);
    expect(losShortcut([[0, 0], [1, 1]], [])).toEqual([[0, 0], [1, 1]]);
  });
});

describe("roundCorners", () => {
  it("preserves endpoints and replaces interior corners with two points", () => {
    const out = roundCorners([[0, 0], [10, 0], [10, 10]]);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([10, 10]);
    expect(out.length).toBe(4); // corner -> 2 cut points
    // both cut points sit within 0.75m of the corner along the segments
    expect(Math.hypot(out[1][0] - 10, out[1][1] - 0)).toBeLessThanOrEqual(0.76);
  });
  it("clamps the cut on short segments", () => {
    const out = roundCorners([[0, 0], [1, 0], [1, 1]]);
    // 45% of a 1m segment = 0.45 < 0.75 radius
    expect(Math.hypot(out[1][0] - 1, out[1][1] - 0)).toBeLessThanOrEqual(0.46);
  });
});

describe("WALK_MPS", () => {
  it("is the canonical 1.4 m/s", () => expect(WALK_MPS).toBe(1.4));
});
