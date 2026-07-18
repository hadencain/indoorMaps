import { describe, expect, it } from "vitest";
import { MOUNT_H, WALK_UNDER_M, collectWalls, computeVisibility, tiltBand } from "./coverage";
import { polygonArea } from "./geo";
import type { Building, Camera, MetreXY, Structure } from "./types";

function cam(over: Partial<Camera> = {}): Camera {
  return {
    id: "c1",
    ordinal: 0,
    at: [0, 0],
    heading: 0,
    fovDeg: 60,
    rangeM: 20,
    kind: "fixed",
    name: "Cam 1",
    ...over,
  };
}

/** Regular n-gon outline (open ring), the shape the column tool authors. */
function columnPoly(cx: number, cy: number, r: number, n = 12): MetreXY[] {
  const pts: MetreXY[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function struct(over: Partial<Structure> = {}): Structure {
  return { id: "s1", ordinal: 0, kind: "column", polygon: columnPoly(8, 0, 1), ...over };
}

/** One 4-edge room on ordinal 0, camera-at-origin friendly. */
function bld(structures: Structure[] = []): Building {
  return {
    origin: [0, 0],
    levels: [{ ordinal: 0, name: "G" }],
    units: [
      {
        id: "room",
        ordinal: 0,
        name: "Room",
        category: "room",
        polygon: [[-2, -12], [30, -12], [30, 12], [-2, 12]],
      },
    ],
    openings: [],
    verticals: [],
    cameras: [],
    structures,
  } as unknown as Building;
}

/** Mirror of the tilt projection in coverage.ts (vfovHalfRad + tiltBand trig),
 *  parameterised on mount height H so tests derive expectations independently. */
function expectedBand(H: number, tiltDeg: number, fovDeg: number): { nearM: number; farM: number } {
  const vfov = Math.min(60, Math.max(15, fovDeg * (9 / 16)));
  const vhalf = (vfov * Math.PI) / 360;
  const tilt = (tiltDeg * Math.PI) / 180;
  return { nearM: H / Math.tan(tilt + vhalf), farM: H / Math.tan(tilt - vhalf) };
}

describe("tiltBand mount height", () => {
  it("respects Camera.mountM (band scales with the lens height)", () => {
    const def = tiltBand(cam({ tiltDeg: 30 }))!;
    const high = tiltBand(cam({ tiltDeg: 30, mountM: 8 }))!;
    const want = expectedBand(8, 30, 60);
    expect(high.nearM).toBeCloseTo(want.nearM, 10);
    expect(high.farM).toBeCloseTo(want.farM, 10);
    // 8 m is 2× MOUNT_H, and both band edges are linear in H.
    expect(high.nearM).toBeCloseTo((8 / MOUNT_H) * def.nearM, 10);
    expect(high.farM).toBeCloseTo((8 / MOUNT_H) * def.farM, 10);
  });

  it("is unchanged for a camera without mountM (legacy default pinned)", () => {
    const band = tiltBand(cam({ tiltDeg: 30 }))!;
    expect(band.nearM).toBeCloseTo(3.7464088319682465, 12);
    expect(band.farM).toBeCloseTo(17.155064404594597, 12);
  });

  it("clamps a negative mountM to 0 — the band collapses onto the mount, never behind it", () => {
    // Hand-edited files reach tiltBand unvalidated (parse does not clamp mountM);
    // unclamped, H = -1 flips farM's sign and computeVisibility would emit a
    // wedge mirrored BEHIND the camera.
    const band = tiltBand(cam({ tiltDeg: 30, mountM: -1 }))!;
    expect(band.nearM).toBe(0);
    expect(band.farM).toBe(0);
    // Shallow tilt (upper FOV edge above the horizon guard) stays consistent
    // too: non-negative near, far ≥ near, no sign-flipped garbage.
    const horizon = tiltBand(cam({ tiltDeg: 10, mountM: -1 }))!;
    expect(horizon.nearM).toBeGreaterThanOrEqual(0);
    expect(horizon.farM).toBeGreaterThanOrEqual(horizon.nearM);
  });

  it("mountM 0 degrades gracefully (band {0,0} → coverage collapses to the mount)", () => {
    const band = tiltBand(cam({ tiltDeg: 30, mountM: 0 }))!;
    expect(band).toEqual({ nearM: 0, farM: 0 });
  });

  it("never emits NaN when the lower FOV edge sits exactly on the horizon (hand-edited tilt)", () => {
    // fovDeg 60 derives vhalf 16.875°; tiltDeg -16.875 cancels it bit-exactly,
    // so lower === 0 and tan(lower) === 0. With mountM 0 the old H/tan(lower)
    // was 0/0 = NaN, which both Math.max clamps passed straight through into
    // computeCoverage (NaN areas). Must degrade to the mount instead.
    const zeroH = tiltBand(cam({ tiltDeg: -16.875, mountM: 0 }))!;
    expect(zeroH.nearM).toBe(0);
    expect(zeroH.farM).toBe(Infinity); // upper below horizon guard → range-capped
    // With a real mount height the same tilt used to give nearM = H/0 = Infinity
    // ({∞,∞} = sees nothing) — discontinuous with tilts a hair lower. Now it
    // matches the lower<0 degradation: full wedge from the mount, range-capped.
    const def = tiltBand(cam({ tiltDeg: -16.875 }))!;
    expect(def.nearM).toBe(0);
    expect(def.farM).toBe(Infinity);
  });

  it("an authored vfovDeg overrides the 16:9 derivation (wider vertical FOV widens the band)", () => {
    // fovDeg 60 derives vfov 33.75°; an explicit 50° must widen both edges.
    const derived = tiltBand(cam({ tiltDeg: 30 }))!;
    const wide = tiltBand(cam({ tiltDeg: 30, vfovDeg: 50 }))!;
    expect(wide.nearM).toBeLessThan(derived.nearM);
    expect(wide.farM).toBeGreaterThan(derived.farM);
    // Exact: same tilt trig with vhalf = 50°/2 at the default mount height.
    const vhalf = (50 * Math.PI) / 360;
    const tilt = (30 * Math.PI) / 180;
    expect(wide.nearM).toBeCloseTo(MOUNT_H / Math.tan(tilt + vhalf), 10);
    expect(wide.farM).toBeCloseTo(MOUNT_H / Math.tan(tilt - vhalf), 10);
  });

  it("clamps a hand-edited non-positive vfovDeg to a sane window (band stays ordered)", () => {
    // parse does not validate camera fields; vfovDeg -10 must not invert the band.
    const band = tiltBand(cam({ tiltDeg: 30, vfovDeg: -10 }))!;
    expect(band.nearM).toBeGreaterThanOrEqual(0);
    expect(band.farM).toBeGreaterThanOrEqual(band.nearM);
  });
});

describe("collectWalls structures", () => {
  it("includes a column's 12 edges on the right ordinal only", () => {
    const b = bld([struct({ id: "s0", ordinal: 0 }), struct({ id: "s1", ordinal: 1, polygon: columnPoly(3, 3, 1) })]);
    // ordinal 0: the room's 4 edges + the ordinal-0 column's 12.
    expect(collectWalls(b, 0)).toHaveLength(16);
    // ordinal 1 has no units — only the ordinal-1 column's 12 edges.
    expect(collectWalls(b, 1)).toHaveLength(12);
  });

  it("gates on walk-under height: baseM 2.5 excluded, baseM 1.0 included", () => {
    // 2.5 m clears WALK_UNDER_M (see-under); 1.0 m does not (occludes).
    expect(2.5).toBeGreaterThanOrEqual(WALK_UNDER_M);
    expect(1.0).toBeLessThan(WALK_UNDER_M);
    expect(collectWalls(bld([struct({ baseM: 2.5 })]), 0)).toHaveLength(4);
    expect(collectWalls(bld([struct({ baseM: 1.0 })]), 0)).toHaveLength(16);
  });
});

describe("computeVisibility with structures", () => {
  it("a column inside the FOV clips the visibility ring", () => {
    const c = cam(); // untilted legacy wedge
    const clear = computeVisibility(c, collectWalls(bld(), 0));
    // Column dead ahead at (8, 0), well inside the ±30° wedge and 20 m range.
    const blocked = computeVisibility(c, collectWalls(bld([struct()]), 0));
    const clearArea = polygonArea(clear);
    const blockedArea = polygonArea(blocked);
    expect(clearArea).toBeGreaterThan(0);
    expect(blockedArea).toBeGreaterThan(0);
    expect(blockedArea).toBeLessThan(clearArea);
  });
});
