import { describe, it, expect } from "vitest";
import { snapDrawPoint, metresPerPixel } from "./snapping";
import type { MetreXY } from "../types";

// One 10×10 square at origin to snap against.
const square: MetreXY[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("snapDrawPoint", () => {
  it("snaps to a nearby vertex first", () => {
    const r = snapDrawPoint([10.3, 9.8], { polygons: [square], tolM: 0.5 });
    expect(r.kind).toBe("vertex");
    expect(r.point).toEqual([10, 10]);
  });

  it("snaps to the nearest edge when no vertex is in tolerance", () => {
    const r = snapDrawPoint([5, 10.3], { polygons: [square], tolM: 0.5 });
    expect(r.kind).toBe("edge");
    expect(r.point[0]).toBeCloseTo(5);
    expect(r.point[1]).toBeCloseTo(10);
  });

  it("vertex beats edge when both are in tolerance", () => {
    const r = snapDrawPoint([9.9, 10.2], { polygons: [square], tolM: 0.6 });
    expect(r.kind).toBe("vertex");
    expect(r.point).toEqual([10, 10]);
  });

  it("axis-aligns with the previous point when near its x or y", () => {
    const r = snapDrawPoint([20.2, 30], { polygons: [], prev: [20, 5], tolM: 0.5 });
    expect(r.kind).toBe("axis");
    expect(r.point).toEqual([20, 30]);
  });

  it("axis-aligns both coordinates independently", () => {
    const r = snapDrawPoint([20.2, 5.3], { polygons: [], prev: [20, 5], tolM: 0.5 });
    expect(r.kind).toBe("axis");
    expect(r.point).toEqual([20, 5]);
  });

  it("falls back to grid snap when the grid is on (always applies)", () => {
    const r = snapDrawPoint([20.4, 30.6], { polygons: [], gridSize: 1, tolM: 0.2 });
    expect(r.kind).toBe("grid");
    expect(r.point).toEqual([20, 31]);
  });

  it("returns the raw point untouched with nothing to snap to", () => {
    const r = snapDrawPoint([20.4, 30.6], { polygons: [], tolM: 0.5 });
    expect(r.kind).toBe("none");
    expect(r.point).toEqual([20.4, 30.6]);
  });

  it("vertex snap beats grid snap", () => {
    const r = snapDrawPoint([10.3, 9.8], { polygons: [square], gridSize: 1, tolM: 0.5 });
    expect(r.kind).toBe("vertex");
    expect(r.point).toEqual([10, 10]);
  });
});

describe("metresPerPixel", () => {
  it("halves when zoom increases by 1", () => {
    const a = metresPerPixel(18, 0);
    const b = metresPerPixel(19, 0);
    expect(b).toBeCloseTo(a / 2);
  });
  it("matches the web-mercator constant at zoom 0, equator", () => {
    // 40075016.686 m circumference / 512 px world
    expect(metresPerPixel(0, 0)).toBeCloseTo(40075016.686 / 512, 0);
  });
});
