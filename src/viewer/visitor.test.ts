import { describe, it, expect } from "vitest";
import { toVisitorBuilding } from "./visitor";
import { isValidBuildingShape } from "../persistence";
import type { Building } from "../types";

function fixture(): Building {
  return {
    origin: [-122.4194, 37.7749],
    levels: [{ ordinal: 0, name: "G" }],
    units: [
      {
        id: "vault",
        ordinal: 0,
        name: "Vault",
        category: "storage",
        security: "restricted",
        polygon: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
      },
      {
        id: "room1",
        ordinal: 0,
        name: "Room 1",
        category: "room",
        polygon: [
          [10, 0],
          [14, 0],
          [14, 4],
          [10, 4],
        ],
      },
      {
        id: "office1",
        ordinal: 0,
        name: "Office 1",
        category: "office",
        security: "secure",
        polygon: [
          [20, 0],
          [24, 0],
          [24, 4],
          [20, 4],
        ],
      },
    ],
    openings: [
      { id: "d-vault", unit: "vault", at: [4, 2] },
      { id: "d-room1", unit: "room1", at: [10, 2] },
    ],
    verticals: [
      { a: "vault", b: "room1", name: "Vault Stairs" },
      { a: "room1", b: "office1", name: "Main Stairs" },
    ],
    cameras: [
      {
        id: "cam1",
        ordinal: 0,
        at: [1, 1],
        heading: 0,
        fovDeg: 90,
        rangeM: 10,
        kind: "fixed",
        name: "Cam 1",
        streamRef: "rtsp://example.test/cam1",
      },
    ],
    incidents: [{ id: "inc1", ordinal: 0, at: [1, 1], kind: "alarm", note: "test" }],
    patrols: [
      {
        id: "pat1",
        ordinal: 0,
        name: "Patrol 1",
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
    cameraViews: [{ id: "cv1", name: "Feed Wall", cameraIds: ["cam1"] }],
    underlays: [
      {
        ordinal: 0,
        dataUrl: "data:image/png;base64,aaaa",
        naturalW: 100,
        naturalH: 100,
        widthM: 10,
        offset: [0, 0],
        rotation: 0,
        opacity: 0.5,
      },
    ],
    vectorUnderlays: [
      {
        ordinal: 0,
        name: "CAD Layer",
        polylines: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        opacity: 0.5,
      },
    ],
    fixtures: [
      {
        id: "fix1",
        ordinal: 0,
        kind: "seating",
        polygon: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ],
    footprints: [
      {
        ordinal: 0,
        polygon: [
          [0, 0],
          [30, 0],
          [30, 10],
          [0, 10],
        ],
      },
    ],
    amenities: [{ id: "am1", ordinal: 0, at: [2, 2], kind: "restroom", name: "Restroom" }],
    occupants: [
      { id: "occ-vault", name: "Vault Contents Co", unitId: "vault", category: "services" },
      { id: "occ-room", name: "Room Tenant", unitId: "room1", category: "retail" },
    ],
    siteInfo: { photos: ["data:image/png;base64,bbbb"], hours: "Mon-Fri 9-5" },
  } as Building;
}

describe("toVisitorBuilding", () => {
  it("never mutates the input building", () => {
    const b = fixture();
    const pre = JSON.parse(JSON.stringify(b));
    toVisitorBuilding(b);
    expect(b).toEqual(pre);
  });

  it("strips every operator array to empty/absent", () => {
    const result = toVisitorBuilding(fixture());
    expect(result.cameras).toEqual([]);
    expect(result.incidents ?? []).toEqual([]);
    expect(result.patrols ?? []).toEqual([]);
    expect(result.cameraViews ?? []).toEqual([]);
    expect(result.underlays ?? []).toEqual([]);
    expect(result.vectorUnderlays ?? []).toEqual([]);
  });

  it("drops the restricted unit and cascades to its opening, its verticals, and its occupant", () => {
    const result = toVisitorBuilding(fixture());
    expect(result.units.find((u) => u.id === "vault")).toBeUndefined();
    expect(result.openings.find((o) => o.unit === "vault")).toBeUndefined();
    expect(result.verticals.find((v) => v.a === "vault" || v.b === "vault")).toBeUndefined();
    expect(result.occupants?.find((o) => o.unitId === "vault")).toBeUndefined();
  });

  it("keeps a vertical that does not touch a dropped unit", () => {
    const result = toVisitorBuilding(fixture());
    expect(result.verticals.find((v) => v.a === "room1" && v.b === "office1")).toBeDefined();
  });

  it("keeps the public room, with security cleared", () => {
    const result = toVisitorBuilding(fixture());
    const room = result.units.find((u) => u.id === "room1");
    expect(room).toBeDefined();
    expect(room!.security === undefined || room!.security === "public").toBe(true);
  });

  it("keeps the secure office (only restricted is dropped), with security cleared", () => {
    const result = toVisitorBuilding(fixture());
    const office = result.units.find((u) => u.id === "office1");
    expect(office).toBeDefined();
    expect(office!.security === undefined || office!.security === "public").toBe(true);
  });

  it("keeps occupants of surviving units", () => {
    const result = toVisitorBuilding(fixture());
    expect(result.occupants?.find((o) => o.id === "occ-room")).toBeDefined();
    expect(result.occupants?.length).toBe(1);
  });

  it("keeps amenities, fixtures, footprints, siteInfo, levels, origin", () => {
    const f = fixture();
    const result = toVisitorBuilding(f);
    expect(result.amenities).toEqual(f.amenities);
    expect(result.fixtures).toEqual(f.fixtures);
    expect(result.footprints).toEqual(f.footprints);
    expect(result.siteInfo).toEqual(f.siteInfo);
    expect(result.levels).toEqual(f.levels);
    expect(result.origin).toEqual(f.origin);
  });

  it("carries no streamRef / camera data anywhere in the result", () => {
    const result = toVisitorBuilding(fixture());
    const text = JSON.stringify(result);
    expect(text).not.toContain("streamRef");
    expect(text).not.toContain("rtsp://");
  });

  it("satisfies isValidBuildingShape", () => {
    const result = toVisitorBuilding(fixture());
    expect(isValidBuildingShape(result)).toBe(true);
  });
});
