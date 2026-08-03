import { describe, expect, it } from "vitest";
import {
  EYE_M,
  SLAB_M,
  WALL_THICKNESS_M,
  build3dScene,
  defaultMountM,
  deriveVfovDeg,
} from "./scene-build";
import { MOUNT_H } from "../coverage";
import { DEFAULT_CEILING_M, UNIT_HEIGHT_M } from "../render";
import type { Building, Camera, Fixture, MetreXY, Structure, Unit } from "../types";

/** 10×10 square, open ring (Unit.polygon convention). */
const SQUARE: MetreXY[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function unit(over: Partial<Unit> = {}): Unit {
  return { id: "u1", ordinal: 0, name: "Room", category: "room", polygon: SQUARE, ...over };
}

function cam(over: Partial<Camera> = {}): Camera {
  return {
    id: "c1",
    ordinal: 0,
    at: [5, 5],
    heading: 0,
    fovDeg: 90,
    rangeM: 20,
    kind: "fixed",
    name: "Cam 1",
    ...over,
  };
}

function struct(over: Partial<Structure> = {}): Structure {
  return { id: "s1", ordinal: 0, kind: "column", polygon: SQUARE, ...over };
}

function fix(over: Partial<Fixture> = {}): Fixture {
  return { id: "f1", ordinal: 0, kind: "slot", polygon: SQUARE, ...over };
}

function bld(over: Partial<Building> = {}): Building {
  return {
    origin: [0, 0],
    levels: [{ ordinal: 0, name: "G" }],
    units: [],
    openings: [],
    verticals: [],
    cameras: [],
    ...over,
  };
}

describe("scene constants", () => {
  it("pins the spike's walk-mode values (eye height, synthesized wall depth)", () => {
    expect(EYE_M).toBe(1.7);
    expect(WALL_THICKNESS_M).toBe(0.15);
  });
});

describe("deriveVfovDeg", () => {
  it("derives the 16:9 vertical FOV: 2·atan(tan(hfov/2)·9/16) in degrees", () => {
    // Independent expectation: tan(45°) = 1 ⇒ vfov = 2·atan(9/16).
    const expected = (2 * Math.atan(9 / 16) * 180) / Math.PI;
    expect(deriveVfovDeg(90)).toBeCloseTo(expected, 12);
    expect(deriveVfovDeg(90)).toBeCloseTo(58.7, 1);
  });

  it("never derives a negative vfov for wide wedges (180 < hfov < 360): input clamps to [1, 179]", () => {
    // tan(hfov/2) flips sign past 180° — unguarded, deriveVfovDeg(270) ≈ −58.7°.
    expect(deriveVfovDeg(270)).toBeGreaterThan(0);
    expect(deriveVfovDeg(200)).toBeGreaterThan(0);
    expect(deriveVfovDeg(270)).toBeCloseTo(deriveVfovDeg(179), 12);
    // Degenerate/negative horizontal FOVs clamp at the low edge.
    expect(deriveVfovDeg(0)).toBeCloseTo(deriveVfovDeg(1), 12);
    expect(deriveVfovDeg(-90)).toBeCloseTo(deriveVfovDeg(1), 12);
    // Everything the clamp can emit stays inside (0°, 180°).
    expect(deriveVfovDeg(359)).toBeLessThan(180);
  });
});

describe("build3dScene walls + footprint", () => {
  it("a square room yields 4 wall segs rising to the authored Level.ceilingM", () => {
    const b = bld({ levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }], units: [unit()] });
    const s = build3dScene(b, 0);
    expect(s.ordinal).toBe(0);
    expect(s.ceilingM).toBe(4.5);
    expect(s.wallSegs).toHaveLength(4);
    for (const w of s.wallSegs) expect(w.topM).toBe(4.5);
    // Open-ring edge convention: i -> (i+1)%n, including the closing edge.
    expect(s.wallSegs[0]).toEqual({ a: [0, 0], b: [10, 0], topM: 4.5, finish: "room", holes: [] });
    expect(s.wallSegs[3]).toEqual({ a: [0, 10], b: [0, 0], topM: 4.5, finish: "room", holes: [] });
    // The room is also a floor patch.
    expect(s.floorPatches).toEqual([{ id: "u1", category: "room", ring: SQUARE }]);
  });

  it("the footprint ring is exposed and contributes exterior-envelope edges", () => {
    const fpRing: MetreXY[] = [
      [-1, -1],
      [12, -1],
      [12, 12],
      [-1, 12],
    ];
    const b = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }],
      units: [unit()],
      footprints: [{ ordinal: 0, polygon: fpRing }],
    });
    const s = build3dScene(b, 0);
    expect(s.footprintRing).toEqual(fpRing);
    expect(s.wallSegs).toHaveLength(8); // 4 room edges + 4 envelope edges
    expect(s.wallSegs[4]).toEqual({
      a: [-1, -1],
      b: [12, -1],
      topM: 4.5,
      finish: "envelope",
      holes: [],
    });
  });

  it("merges the shared partition between two abutting rooms into ONE wall", () => {
    // Two 10×10 rooms sharing the x=10 edge. Each pushes 4 edges; the shared one
    // is the SAME undirected edge, so the floor must end up with 7 walls, not 8.
    // Emitting it twice put two boxes in the same volume — doubled apparent
    // thickness and z-fighting down every shared face in the building.
    const east: MetreXY[] = [
      [10, 0],
      [20, 0],
      [20, 10],
      [10, 10],
    ];
    const b = bld({
      units: [unit(), unit({ id: "u2", polygon: east })],
    });
    const s = build3dScene(b, 0);
    expect(s.wallSegs).toHaveLength(7);
    const shared = s.wallSegs.filter(
      (w) =>
        (w.a[0] === 10 && w.b[0] === 10) &&
        Math.min(w.a[1], w.b[1]) === 0 &&
        Math.max(w.a[1], w.b[1]) === 10,
    );
    expect(shared).toHaveLength(1);
  });

  it("the more specific finish wins a shared wall, and envelope outranks all", () => {
    // A shop against a corridor must read as the shop's wall, not depend on which
    // unit the build loop happened to reach first.
    const east: MetreXY[] = [
      [10, 0],
      [20, 0],
      [20, 10],
      [10, 10],
    ];
    const b = bld({
      units: [
        unit({ id: "shop", category: "retail" }),
        unit({ id: "hall", category: "office", polygon: east }),
      ],
    });
    const shared = build3dScene(b, 0).wallSegs.find((w) => w.a[0] === 10 && w.b[0] === 10);
    expect(shared?.finish).toBe("retail");

    // The same edge also carried by the footprint ring becomes envelope.
    const b2 = bld({
      units: [unit({ category: "retail" })],
      footprints: [{ ordinal: 0, polygon: SQUARE }],
    });
    for (const w of build3dScene(b2, 0).wallSegs) expect(w.finish).toBe("envelope");
  });

  it("cuts an opening into the nearest wall of its host unit, positioned along it", () => {
    const b = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 4 }],
      units: [unit({ category: "office" })],
      openings: [{ id: "d1", unit: "u1", at: [3, 0] }],
    });
    const s = build3dScene(b, 0);
    const holed = s.wallSegs.filter((w) => w.holes.length > 0);
    expect(holed).toHaveLength(1);
    // The south edge (0,0)->(10,0) is nearest; the door sits 3 m along it.
    expect(holed[0].a).toEqual([0, 0]);
    expect(holed[0].b).toEqual([10, 0]);
    const h = holed[0].holes[0];
    expect(h.atM).toBeCloseTo(3, 6);
    // An office door derives the single-leaf style, not a shopfront.
    expect(h.style).toBe("door");
    expect(h.widthM).toBeCloseTo(0.95, 6);
    expect(h.label).toBeUndefined();
  });

  it("derives a storefront for a retail unit and letters the occupant onto it", () => {
    const b = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 4 }],
      units: [unit({ category: "retail" })],
      openings: [{ id: "d1", unit: "u1", at: [5, 0] }],
      occupants: [{ id: "o1", name: "Sunglass Hut", unitId: "u1", category: "retail" }],
    });
    const h = build3dScene(b, 0).wallSegs.flatMap((w) => w.holes)[0];
    expect(h.style).toBe("storefront");
    expect(h.label).toBe("Sunglass Hut");
    // A vacant retail unit still gets a shopfront, lettered with the unit name.
    const vacant = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 4 }],
      units: [unit({ category: "retail" })],
      openings: [{ id: "d1", unit: "u1", at: [5, 0] }],
    });
    expect(build3dScene(vacant, 0).wallSegs.flatMap((w) => w.holes)[0].label).toBe("Room");
  });

  it("clamps a hole so it always leaves a jamb, and never breaches the ceiling", () => {
    // A 6.5 m storefront default in a 10 m wall must still leave wall at each end,
    // and a 3 m head under a 2.5 m ceiling must duck below it rather than cutting
    // a hole through the slab above.
    const b = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 2.5 }],
      units: [unit({ category: "retail" })],
      openings: [{ id: "d1", unit: "u1", at: [0.1, 0] }],
    });
    const w = build3dScene(b, 0).wallSegs.find((x) => x.holes.length > 0)!;
    const h = w.holes[0];
    expect(h.atM - h.widthM / 2).toBeGreaterThanOrEqual(0.35 - 1e-9);
    expect(h.atM + h.widthM / 2).toBeLessThanOrEqual(10 - 0.35 + 1e-9);
    expect(h.headM).toBeLessThan(2.5);

    // An authored width wider than the wall can hold is clamped, not honoured.
    const tight = bld({
      units: [unit({ category: "office" })],
      openings: [{ id: "d1", unit: "u1", at: [5, 0], widthM: 40 }],
    });
    const th = build3dScene(tight, 0).wallSegs.flatMap((x) => x.holes)[0];
    expect(th.widthM).toBeCloseTo(10 - 0.7, 6);
  });

  it("an authored style overrides the derivation", () => {
    const b = bld({
      units: [unit({ category: "retail" })],
      openings: [{ id: "d1", unit: "u1", at: [5, 0], style: "door" }],
    });
    expect(build3dScene(b, 0).wallSegs.flatMap((w) => w.holes)[0].style).toBe("door");
  });

  it("drops a second opening that would overlap one already cut into the wall", () => {
    // Two doors 0.2 m apart would merge into a single hole that swallows the pier
    // between them; the later one is skipped instead.
    const b = bld({
      units: [unit({ category: "office" })],
      openings: [
        { id: "d1", unit: "u1", at: [5, 0] },
        { id: "d2", unit: "u1", at: [5.2, 0] },
        { id: "d3", unit: "u1", at: [8, 0] },
      ],
    });
    const holes = build3dScene(b, 0).wallSegs.flatMap((w) => w.holes);
    expect(holes.map((h) => h.id)).toEqual(["d1", "d3"]);
  });

  it("skips openings on low-slab units, other floors, and missing units", () => {
    const b = bld({
      units: [unit({ category: "corridor" }), unit({ id: "up", ordinal: 1 })],
      openings: [
        { id: "d1", unit: "u1", at: [5, 0] }, // corridor: no wall to cut
        { id: "d2", unit: "up", at: [5, 0] }, // another floor
        { id: "d3", unit: "ghost", at: [5, 0] }, // no such unit
      ],
    });
    expect(build3dScene(b, 0).wallSegs.flatMap((w) => w.holes)).toHaveLength(0);
  });

  it("resolves a void onto its own floor AND the ceiling of the floor below", () => {
    // A void is authored ONCE, on the plate it removes, but it opens two surfaces:
    // that plate, and the ceiling underneath it. Both must resolve or an atrium is
    // a hole in the floor with an intact ceiling stretched across it.
    const hole: MetreXY[] = [
      [2, 2],
      [6, 2],
      [6, 6],
      [2, 6],
    ];
    const b = bld({
      levels: [
        { ordinal: 0, name: "G", ceilingM: 4 },
        { ordinal: 1, name: "1", ceilingM: 5 },
      ],
      units: [unit(), unit({ id: "u2", ordinal: 1 })],
      voids: [{ id: "v1", ordinal: 1, polygon: hole }],
    });
    // The floor the void belongs to: cut its own plate, nothing above it.
    const upper = build3dScene(b, 1);
    expect(upper.voids).toEqual([hole]);
    expect(upper.ceilingVoids).toEqual([]);
    // The floor below: plate intact, ceiling opened.
    const lower = build3dScene(b, 0);
    expect(lower.voids).toEqual([]);
    expect(lower.ceilingVoids).toEqual([hole]);
  });

  it("exposes storey height as ceiling + slab, so a neighbour floor stacks right", () => {
    const b = bld({ levels: [{ ordinal: 0, name: "G", ceilingM: 4 }], units: [unit()] });
    expect(build3dScene(b, 0).storeyHeightM).toBeCloseTo(4 + SLAB_M, 9);
  });

  it("skips degenerate voids rather than emitting a collapsed hole", () => {
    const b = bld({
      units: [unit()],
      voids: [
        { id: "bad", ordinal: 0, polygon: [[1, 1], [2, 2]] }, // < 3 verts
        { id: "zero", ordinal: 0, polygon: [[1, 1], [2, 1], [3, 1]] }, // ~zero area
        { id: "ok", ordinal: 0, polygon: [[2, 2], [4, 2], [4, 4], [2, 4]] },
      ],
    });
    expect(build3dScene(b, 0).voids).toEqual([[[2, 2], [4, 2], [4, 4], [2, 4]]]);
  });

  it("a corridor yields a low slab prism, not wall segs (OQ-6 divergence from 2D)", () => {
    const b = bld({ units: [unit({ category: "corridor" })] });
    const s = build3dScene(b, 0);
    expect(s.wallSegs).toHaveLength(0);
    expect(s.slabPrisms).toEqual([
      { id: "u1", kind: "corridor", ring: SQUARE, baseM: 0, topM: UNIT_HEIGHT_M.corridor },
    ]);
    expect(s.floorPatches).toHaveLength(1); // still carpet
  });

  it("outside (height 0) is a floor patch only — no wall, no slab", () => {
    const b = bld({ units: [unit({ category: "outside" })] });
    const s = build3dScene(b, 0);
    expect(s.wallSegs).toHaveLength(0);
    expect(s.slabPrisms).toHaveLength(0);
    expect(s.floorPatches).toHaveLength(1);
  });
});

describe("build3dScene structures", () => {
  it("clamps heightM above the ceiling to ceilingM (authored value stays stored)", () => {
    const b = bld({ structures: [struct({ heightM: 10 })] });
    const s = build3dScene(b, 0);
    expect(s.structurePrisms).toEqual([
      { id: "s1", kind: "column", ring: SQUARE, baseM: 0, topM: DEFAULT_CEILING_M },
    ]);
    expect(b.structures![0].heightM).toBe(10); // never written back
  });

  it("defaults absent heightM to full height and absent baseM to 0", () => {
    const b = bld({ levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }], structures: [struct()] });
    const p = build3dScene(b, 0).structurePrisms[0];
    expect(p.baseM).toBe(0);
    expect(p.topM).toBe(4.5);
  });

  it("clamps baseM above topM down to topM (degenerate-safe soffit)", () => {
    const b = bld({ structures: [struct({ kind: "obstacle", heightM: 2, baseM: 5 })] });
    const p = build3dScene(b, 0).structurePrisms[0];
    expect(p.kind).toBe("obstacle");
    expect(p.topM).toBe(2);
    expect(p.baseM).toBe(2);
  });

  it("floors hand-edited negative baseM/heightM at 0 (matching structuresToGeoJSON)", () => {
    // baseM = -2: 2D clamps the prism to the floor slab — 3D must agree.
    const sunk = build3dScene(bld({ structures: [struct({ baseM: -2 })] }), 0).structurePrisms[0];
    expect(sunk.baseM).toBe(0);
    expect(sunk.topM).toBe(DEFAULT_CEILING_M);
    // heightM = -1: collapses to a zero-height prism at the slab, never below it.
    const negH = build3dScene(bld({ structures: [struct({ heightM: -1 })] }), 0)
      .structurePrisms[0];
    expect(negH.topM).toBe(0);
    expect(negH.baseM).toBe(0);
  });
});

describe("build3dScene fixtures", () => {
  it("extrudes fixtures to their synthesized display height", () => {
    const b = bld({ fixtures: [fix()] });
    expect(build3dScene(b, 0).fixturePrisms).toEqual([
      { id: "f1", kind: "slot", ring: SQUARE, baseM: 0, topM: 1.6 },
    ]);
  });

  it("skips zero-height kinds (parking is painted, never extruded)", () => {
    const b = bld({ fixtures: [fix({ kind: "parking" })] });
    expect(build3dScene(b, 0).fixturePrisms).toHaveLength(0);
  });
});

describe("build3dScene cameras", () => {
  it("clamps mountM into [0.1, ceilingM - 0.1]", () => {
    const b = bld({
      levels: [{ ordinal: 0, name: "G", ceilingM: 4.5 }],
      cameras: [cam({ id: "hi", mountM: 9 }), cam({ id: "lo", mountM: 0 })],
    });
    const poses = build3dScene(b, 0).cameras;
    expect(poses.find((p) => p.id === "hi")!.mountM).toBeCloseTo(4.4, 12);
    expect(poses.find((p) => p.id === "lo")!.mountM).toBe(0.1);
  });

  it("defaults absent mountM to a ceiling-hung height, itself ceiling-clamped", () => {
    // Default 3.2 m ceiling: unchanged from the flat-MOUNT_H era — 4 clamps to 3.1.
    const low = build3dScene(bld({ cameras: [cam()] }), 0).cameras[0];
    expect(low.mountM).toBeCloseTo(DEFAULT_CEILING_M - 0.1, 12);
    // Tall ceiling: cameras are ceiling-mounted hardware, so they RIDE UP with
    // the ceiling instead of floating at 4 m in the middle of a 6 m hall.
    const tall = build3dScene(
      bld({ levels: [{ ordinal: 0, name: "G", ceilingM: 6 }], cameras: [cam()] }),
      0,
    ).cameras[0];
    expect(tall.mountM).toBeCloseTo(defaultMountM(6), 12);
    expect(tall.mountM).toBeGreaterThan(MOUNT_H);
  });

  it("resolves every absent-able field and passes the rest through", () => {
    const p = build3dScene(bld({ cameras: [cam({ heading: 33, rangeM: 17, kind: "ptz" })] }), 0)
      .cameras[0];
    expect(p.id).toBe("c1");
    expect(p.name).toBe("Cam 1");
    expect(p.at).toEqual([5, 5]);
    expect(p.headingDeg).toBe(33);
    expect(p.tiltDeg).toBe(0);
    expect(p.rollDeg).toBe(0);
    expect(p.fovDeg).toBe(90);
    expect(p.vfovDeg).toBeCloseTo(deriveVfovDeg(90), 12);
    expect(p.rangeM).toBe(17);
    expect(p.kind).toBe("ptz");
    expect(p.mount).toBe("ceiling");
  });

  it("an authored vfovDeg/mount/tilt/roll override the defaults", () => {
    const p = build3dScene(
      bld({ cameras: [cam({ vfovDeg: 50, mount: "wall", tiltDeg: 25, rollDeg: -10 })] }),
      0,
    ).cameras[0];
    expect(p.vfovDeg).toBe(50);
    expect(p.mount).toBe("wall");
    expect(p.tiltDeg).toBe(25);
    expect(p.rollDeg).toBe(-10);
  });

  it("clamps a hand-edited vfovDeg into [1, 179] like the 2D twin (vfovHalfRad)", () => {
    const poses = build3dScene(
      bld({
        cameras: [
          cam({ id: "neg", vfovDeg: -5 }),
          cam({ id: "zero", vfovDeg: 0 }),
          cam({ id: "wide", vfovDeg: 400 }),
        ],
      }),
      0,
    ).cameras;
    expect(poses.find((p) => p.id === "neg")!.vfovDeg).toBe(1);
    expect(poses.find((p) => p.id === "zero")!.vfovDeg).toBe(1);
    expect(poses.find((p) => p.id === "wide")!.vfovDeg).toBe(179);
  });
});

describe("build3dScene exclusions + degenerates", () => {
  it("excludes wrong-ordinal objects everywhere (and their ceiling)", () => {
    const b = bld({
      levels: [{ ordinal: 1, name: "L1", ceilingM: 9 }],
      units: [unit({ ordinal: 1 })],
      cameras: [cam({ ordinal: 1 })],
      structures: [struct({ ordinal: 1 })],
      fixtures: [fix({ ordinal: 1 })],
      footprints: [{ ordinal: 1, polygon: SQUARE }],
    });
    const s = build3dScene(b, 0);
    expect(s.ceilingM).toBe(DEFAULT_CEILING_M); // ordinal 0 has no level row
    expect(s.footprintRing).toBeNull();
    expect(s.floorPatches).toHaveLength(0);
    expect(s.wallSegs).toHaveLength(0);
    expect(s.slabPrisms).toHaveLength(0);
    expect(s.structurePrisms).toHaveLength(0);
    expect(s.fixturePrisms).toHaveLength(0);
    expect(s.cameras).toHaveLength(0);
  });

  it("an empty building yields empty arrays and a null footprint ring", () => {
    const s = build3dScene(bld({ levels: [] }), 0);
    expect(s.ceilingM).toBe(DEFAULT_CEILING_M);
    expect(s.footprintRing).toBeNull();
    expect(s.floorPatches).toHaveLength(0);
    expect(s.wallSegs).toHaveLength(0);
    expect(s.slabPrisms).toHaveLength(0);
    expect(s.structurePrisms).toHaveLength(0);
    expect(s.fixturePrisms).toHaveLength(0);
    expect(s.cameras).toHaveLength(0);
  });

  it("skips degenerate polygons: 2 vertices or ~zero area", () => {
    const twoVerts: MetreXY[] = [
      [0, 0],
      [10, 0],
    ];
    const collinear: MetreXY[] = [
      [0, 0],
      [5, 0],
      [10, 0],
    ];
    const b = bld({
      units: [unit({ id: "u2", polygon: twoVerts }), unit({ id: "u3", polygon: collinear })],
      structures: [struct({ polygon: twoVerts })],
      fixtures: [fix({ polygon: twoVerts })],
    });
    const s = build3dScene(b, 0);
    expect(s.wallSegs).toHaveLength(0); // neither unit contributes walls
    expect(s.structurePrisms).toHaveLength(0);
    expect(s.fixturePrisms).toHaveLength(0);
    // Floor patches only need >= 3 verts (a flat patch has no occlusion role):
    // the 2-vertex unit is dropped, the zero-area one still paints.
    expect(s.floorPatches.map((p) => p.id)).toEqual(["u3"]);
  });
});

describe("defaultMountM (unauthored camera mount height)", () => {
  it("is unchanged at the legacy 3.2 m default ceiling", () => {
    // 4 m, which build3dScene then clamps to ceilingM − 0.1 exactly as before.
    expect(defaultMountM(3.2)).toBe(MOUNT_H);
  });

  it("hangs cameras near the ceiling in a tall hall", () => {
    expect(defaultMountM(7)).toBeCloseTo(6.4, 6);
  });

  it("caps at a practical installer height in an atrium", () => {
    expect(defaultMountM(12)).toBe(7);
    expect(defaultMountM(30)).toBe(7);
  });

  it("never returns below the legacy mount for low ceilings", () => {
    expect(defaultMountM(2.4)).toBe(MOUNT_H);
  });
});
