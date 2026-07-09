import { describe, expect, it } from "vitest";
import { panStep, zoomStep, tiltStep, FOV_MIN, FOV_MAX, TILT_MIN, TILT_MAX, TILT_DEFAULT } from "./ptz";

describe("tiltStep", () => {
  it("steps 5 degrees down (dir 1) and up (dir -1)", () => {
    expect(tiltStep(35, 1)).toBe(40);
    expect(tiltStep(35, -1)).toBe(30);
  });
  it("initializes a never-tilted camera from the default", () => {
    expect(tiltStep(undefined, 1)).toBe(TILT_DEFAULT + 5);
    expect(tiltStep(undefined, -1)).toBe(TILT_DEFAULT - 5);
  });
  it("clamps at both ends", () => {
    expect(tiltStep(TILT_MAX, 1)).toBe(TILT_MAX);
    expect(tiltStep(TILT_MIN, -1)).toBe(TILT_MIN);
    expect(tiltStep(TILT_MAX - 2, 1)).toBe(TILT_MAX);
  });
});

describe("panStep", () => {
  it("steps 5 degrees", () => {
    expect(panStep(90, 1)).toBe(95);
    expect(panStep(90, -1)).toBe(85);
  });
  it("wraps past 360 and below 0", () => {
    expect(panStep(358, 1)).toBe(3);
    expect(panStep(2, -1)).toBe(357);
  });
});

describe("zoomStep", () => {
  it("zoom-in narrows FOV and extends range by sqrt of the ratio", () => {
    const z = zoomStep(90, 20, 1);
    expect(z.fovDeg).toBeCloseTo(72); // 90 / 1.25
    expect(z.rangeM).toBeCloseTo(20 * Math.sqrt(90 / 72));
  });
  it("zoom-out widens FOV and shortens range", () => {
    const z = zoomStep(72, 22, -1);
    expect(z.fovDeg).toBeCloseTo(90);
    expect(z.rangeM).toBeCloseTo(22 * Math.sqrt(72 / 90));
  });
  it("clamps FOV at the floor, scaling range by the ACTUAL ratio", () => {
    const z = zoomStep(22, 20, 1); // 22/1.25 = 17.6 → clamps to 20
    expect(z.fovDeg).toBe(FOV_MIN);
    expect(z.rangeM).toBeCloseTo(20 * Math.sqrt(22 / 20));
  });
  it("is a no-op at the clamp bounds", () => {
    expect(zoomStep(FOV_MIN, 30, 1)).toEqual({ fovDeg: FOV_MIN, rangeM: 30 });
    expect(zoomStep(FOV_MAX, 30, -1)).toEqual({ fovDeg: FOV_MAX, rangeM: 30 });
  });
  it("round-trips: in then out restores the original (no clamping)", () => {
    const inZ = zoomStep(90, 20, 1);
    const back = zoomStep(inZ.fovDeg, inZ.rangeM, -1);
    expect(back.fovDeg).toBeCloseTo(90);
    expect(back.rangeM).toBeCloseTo(20);
  });
});
