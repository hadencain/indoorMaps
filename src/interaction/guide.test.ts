import { describe, it, expect } from "vitest";
import { guideStages, guideComplete, activeStage } from "./guide";
import type { Building, Unit } from "../types";

const room = (id: string, ordinal = 0): Unit => ({
  id, ordinal, name: id, category: "room",
  polygon: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => [x + 12 * ordinal, y]) as Unit["polygon"],
});
const corridor = (id: string, ordinal = 0): Unit => ({
  ...room(id, ordinal), category: "corridor",
  polygon: [[0, 10], [10, 10], [10, 14], [0, 14]] as Unit["polygon"],
});
const base = (over: Partial<Building>): Building =>
  ({ origin: [0, 0], levels: [{ ordinal: 0, name: "Floor 1" }], units: [], openings: [],
     verticals: [], cameras: [], ...over }) as Building;

describe("guideStages", () => {
  it("empty starter building: only optional stages can be done", () => {
    const st = guideStages(base({}));
    expect(st.map((s) => s.id)).toEqual(["underlay", "floors", "rooms", "doors", "occupants", "review"]);
    expect(st.find((s) => s.id === "rooms")!.done).toBe(false);
    expect(guideComplete(st)).toBe(false);
    expect(activeStage(st)!.id).toBe("underlay"); // first incomplete, optional included
  });

  it("rooms done once a space unit exists; doors not until corridor+door", () => {
    const b = base({ units: [room("a")] });
    let st = guideStages(b);
    expect(st.find((s) => s.id === "rooms")!.done).toBe(true);
    expect(st.find((s) => s.id === "doors")!.done).toBe(false); // no corridor, doorless
    const b2 = base({
      units: [room("a"), corridor("c")],
      openings: [{ id: "d1", unit: "a", at: [5, 10] }],
    });
    st = guideStages(b2);
    expect(st.find((s) => s.id === "doors")!.done).toBe(true);
    expect(st.find((s) => s.id === "review")!.done).toBe(true); // no errors
  });

  it("review stays incomplete while an error issue exists", () => {
    const b = base({
      units: [room("a"), corridor("c")],
      openings: [{ id: "d1", unit: "a", at: [5, 10] }],
      verticals: [{ a: "a", b: "ghost", name: "Broken Lift" }], // dangling -> error
    });
    const st = guideStages(b);
    expect(st.find((s) => s.id === "doors")!.done).toBe(true);
    expect(st.find((s) => s.id === "review")!.done).toBe(false);
    expect(activeStage(st)!.id).toBe("review");
  });

  it("guideComplete ignores optional stages", () => {
    const b = base({
      units: [room("a"), corridor("c")],
      openings: [{ id: "d1", unit: "a", at: [5, 10] }],
    });
    const st = guideStages(b); // no underlay, 1 floor, no occupants — all optional undone
    expect(guideComplete(st)).toBe(true);
    expect(activeStage(st)).toBeNull();
  });
});
