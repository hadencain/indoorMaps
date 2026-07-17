import { describe, it, expect } from "vitest";
import { columnPolygon, MIN_COLUMN_RADIUS_M, MAX_COLUMN_RADIUS_M } from "./structures";

describe("columnPolygon", () => {
  it("returns 12 distinct vertices by default (open ring, no closing repeat)", () => {
    const ring = columnPolygon([5, 5], 0.4);
    expect(ring).toHaveLength(12);
    const uniq = new Set(ring.map((p) => p.join(",")));
    expect(uniq.size).toBe(12);
  });

  it("places every vertex exactly at the radius, first vertex at angle 0", () => {
    const ring = columnPolygon([3, -2], 0.5);
    for (const [x, y] of ring) {
      expect(Math.hypot(x - 3, y + 2)).toBeCloseTo(0.5, 10);
    }
    expect(ring[0][0]).toBeCloseTo(3.5, 10);
    expect(ring[0][1]).toBeCloseTo(-2, 10);
  });

  it("winds CCW (positive shoelace signed area)", () => {
    const ring = columnPolygon([0, 0], 1);
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      area2 += x1 * y2 - x2 * y1;
    }
    expect(area2).toBeGreaterThan(0);
  });

  it("is deterministic — regenerating with the same params yields the identical ring", () => {
    expect(columnPolygon([1.25, 7.5], 0.75)).toEqual(columnPolygon([1.25, 7.5], 0.75));
  });

  it("honors the sides parameter", () => {
    expect(columnPolygon([0, 0], 1, 6)).toHaveLength(6);
    expect(columnPolygon([0, 0], 1, 24)).toHaveLength(24);
  });

  it("radius clamp bounds are sane (positive, ordered)", () => {
    expect(MIN_COLUMN_RADIUS_M).toBeGreaterThan(0);
    expect(MAX_COLUMN_RADIUS_M).toBeGreaterThan(MIN_COLUMN_RADIUS_M);
  });
});
