import { describe, expect, it } from "vitest";
import { CAMERA_MODELS, findModel, modelLabel, modelRangeM } from "./camera-models";
import { doriBand, pxPerMetreAt } from "./coverage";
import type { Camera } from "./types";

describe("camera model catalogue", () => {
  it("labels are unique (they are the stored Camera.model value)", () => {
    const labels = CAMERA_MODELS.map(modelLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("specs are sane", () => {
    for (const m of CAMERA_MODELS) {
      expect(m.resolutionMP).toBeGreaterThan(0);
      expect(m.resolutionMP).toBeLessThanOrEqual(16);
      if (m.kind === "dome") expect(m.fovDeg).toBe(360);
      else {
        expect(m.fovDeg).toBeGreaterThanOrEqual(40);
        expect(m.fovDeg).toBeLessThanOrEqual(130);
      }
    }
  });

  it("findModel round-trips every label and rejects free text", () => {
    for (const m of CAMERA_MODELS) expect(findModel(modelLabel(m))).toBe(m);
    expect(findModel("Some Custom Cam 9000")).toBeUndefined();
  });

  it("derived range still rates DORI observe under the app's own density math", () => {
    // The whole point of deriving range: at the far end of the drawn cone the
    // camera must still meet the band the range was derived FROM. Verify with
    // coverage.ts, not with the catalogue's own inlined copy of the formula.
    for (const m of CAMERA_MODELS) {
      const rangeM = modelRangeM(m);
      expect(rangeM).toBeGreaterThan(0);
      expect(rangeM).toBeLessThanOrEqual(60);
      const cam: Camera = {
        id: "t",
        ordinal: 0,
        at: [0, 0],
        name: "t",
        heading: 0,
        kind: m.kind,
        fovDeg: m.fovDeg,
        rangeM,
        resolutionMP: m.resolutionMP,
      };
      // At 99% of the derived range the band must be at least "observe"
      // (rounding to 0.1 m can put the exact endpoint a hair past the line;
      // the 60 m cap makes capped entries strictly inside their band).
      const band = doriBand(pxPerMetreAt(cam, rangeM * 0.99));
      expect(["observe", "recognise", "identify"]).toContain(band);
    }
  });
});
