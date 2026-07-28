// The fixture SIZING CONTRACT. Canonical models are authored in real metres and
// fitted into their authored footprint preserving plan aspect — an emitted
// polygon is a real footprint, never a scale multiplier. (Pre-fix, canonical
// models filled unit space inconsistently — a card table 98% of X, a slot
// cabinet 56% — so identical polygons produced wildly different real sizes and
// every venue's fixtures were mis-proportioned.)
import { describe, expect, it } from "vitest";
import { getFixtureModel, planFitScale } from "./fixtures";

describe("canonical model plan spans", () => {
  it("a slot cabinet is a real slot cabinet (≈0.5-0.8 m wide, ≈1.4-1.9 m tall)", () => {
    const slot = getFixtureModel("slot");
    expect(slot.spanX).toBeGreaterThan(0.4);
    expect(slot.spanX).toBeLessThan(0.8);
    expect(slot.height).toBeGreaterThan(1.4);
    expect(slot.height).toBeLessThan(1.9);
  });

  it("a card table is longer than it is deep", () => {
    const bj = getFixtureModel("blackjack");
    expect(bj.spanX).toBeGreaterThan(bj.spanZ);
    expect(bj.height).toBeGreaterThan(0.8); // felt at ≈0.9 m
    expect(bj.height).toBeLessThan(1.2);
  });
});

describe("planFitScale", () => {
  it("bbox fit is uniform in plan and identity in Y (height is authored real)", () => {
    const s = planFitScale(getFixtureModel("slot"), 0.65, 0.6);
    expect(s.x).toBeCloseTo(s.z, 9);
    expect(s.y).toBe(1);
  });

  it("never overflows the authored footprint", () => {
    const slot = getFixtureModel("slot");
    const s = planFitScale(slot, 0.65, 0.6);
    expect(slot.spanX * s.x).toBeLessThanOrEqual(0.65 + 1e-9);
    expect(slot.spanZ * s.z).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("preserves the model's plan aspect at any footprint (no stretch)", () => {
    const bj = getFixtureModel("blackjack");
    const s = planFitScale(bj, 2.2, 1.2);
    const len = bj.spanX * s.x;
    const wid = bj.spanZ * s.z;
    expect(len / wid).toBeCloseTo(bj.spanX / bj.spanZ, 9);
    expect(len).toBeGreaterThan(1.4); // reads as a real table, not a toy
  });

  it("length fit stays uniform on all three axes (car height follows its footprint)", () => {
    const s = planFitScale(getFixtureModel("car"), 4.6, 1.9);
    expect(s.x).toBeCloseTo(s.y, 9);
    expect(s.y).toBeCloseTo(s.z, 9);
  });

  it("degenerate spans and footprints degrade to a safe positive scale", () => {
    const slot = getFixtureModel("slot");
    for (const s of [planFitScale(slot, 0, 0), planFitScale(slot, -3, 2)]) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(s.x).toBeGreaterThan(0);
    }
  });
});
