import { describe, it, expect } from "vitest";
import { translateEdge } from "./edit";
import type { MetreXY } from "../types";

const square: MetreXY[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("translateEdge", () => {
  it("moves a horizontal edge only vertically (stays axis-aligned)", () => {
    // Bottom edge (index 0: [0,0]→[10,0]), midpoint [5,0]; drag target [6, -2].
    const out = translateEdge(square, 0, [6, -2]);
    expect(out[0]).toEqual([0, -2]);
    expect(out[1]).toEqual([10, -2]);
    expect(out[2]).toEqual([10, 10]); // untouched
    expect(out[3]).toEqual([0, 10]); // untouched
  });

  it("moves a vertical edge only horizontally", () => {
    // Right edge (index 1: [10,0]→[10,10]), midpoint [10,5]; drag target [13, 7].
    const out = translateEdge(square, 1, [13, 7]);
    expect(out[1]).toEqual([13, 0]);
    expect(out[2]).toEqual([13, 10]);
    expect(out[0]).toEqual([0, 0]);
  });

  it("moves a diagonal edge along its normal only", () => {
    const tri: MetreXY[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    // Hypotenuse (index 1: [10,0]→[0,10]); its unit normal is (−√2/2, −√2/2)
    // or the opposite sign. Drag the midpoint [5,5] to [6,6]: normal component
    // of delta (1,1) is √2 outward → both endpoints shift by (1,1).
    const out = translateEdge(tri, 1, [6, 6]);
    expect(out[1][0]).toBeCloseTo(11);
    expect(out[1][1]).toBeCloseTo(1);
    expect(out[2][0]).toBeCloseTo(1);
    expect(out[2][1]).toBeCloseTo(11);
    expect(out[0]).toEqual([0, 0]);
  });

  it("returns the polygon unchanged for a zero-length edge", () => {
    const bad: MetreXY[] = [
      [0, 0],
      [0, 0],
      [10, 10],
    ];
    expect(translateEdge(bad, 0, [5, 5])).toEqual(bad);
  });
});
