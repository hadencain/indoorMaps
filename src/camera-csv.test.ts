import { describe, expect, it } from "vitest";
import { parseCameraCsv, resolveModel, splitCsvLine } from "./camera-csv";

describe("splitCsvLine", () => {
  it("splits plain and quoted cells, with escaped quotes", () => {
    expect(splitCsvLine("a,b,c", ",")).toEqual(["a", "b", "c"]);
    expect(splitCsvLine('a,"b, with comma",c', ",")).toEqual(["a", "b, with comma", "c"]);
    expect(splitCsvLine('a,"say ""hi""",c', ",")).toEqual(["a", 'say "hi"', "c"]);
    expect(splitCsvLine("a;;c", ";")).toEqual(["a", "", "c"]);
  });
});

describe("resolveModel", () => {
  it("matches exact, case-insensitive, and embedded model tokens", () => {
    expect(resolveModel("Axis P3265-LVE")?.model).toBe("P3265-LVE");
    expect(resolveModel("axis p3265-lve")?.model).toBe("P3265-LVE");
    expect(resolveModel("AXIS P3265-LVE outdoor bullet")?.model).toBe("P3265-LVE");
    expect(resolveModel("Some NoName 9000")).toBeUndefined();
    expect(resolveModel("")).toBeUndefined();
  });
});

describe("parseCameraCsv", () => {
  it("sniffs an ordinary integrator export", () => {
    const r = parseCameraCsv(
      [
        "Camera Name,Model,Ch,Mount Height (m),IP Address,Serial,Location",
        "Dock North,Axis P3265-LVE,12,3.5,10.0.0.12,S123,Loading dock",
        "Sales PTZ,Hanwha XNP-C9310R,13,4,10.0.0.13,S124,Sales floor",
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.rows).toHaveLength(2);
    const [a, b] = r.result.rows;
    expect(a).toMatchObject({ name: "Dock North", opNumber: 12, mountM: 3.5, ipAddress: "10.0.0.12", serial: "S123", notes: "Loading dock" });
    expect(a.spec?.model).toBe("P3265-LVE");
    expect(b.spec?.kind).toBe("ptz");
    expect(r.result.mapping.name).toBe("Camera Name");
    expect(r.result.mapping.mountM).toBe("Mount Height (m)");
    expect(r.result.unmapped).toEqual([]);
  });

  it("handles semicolons, BOM, blank rows, feet, and junk numbers", () => {
    const r = parseCameraCsv(
      "﻿name;model;height;no\n" +
        "Cam A;unknown thing;12 ft;7\n" +
        ";;;\n" + // nameless -> skipped
        "Cam B;;;3.5\n", // fractional channel -> dropped
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.delimiter).toBe(";");
    expect(r.result.rows).toHaveLength(2);
    expect(r.result.skipped).toBe(1);
    expect(r.result.rows[0].mountM).toBeCloseTo(3.66, 2); // 12 ft
    expect(r.result.rows[0].spec).toBeUndefined();
    expect(r.result.rows[1].opNumber).toBeUndefined(); // 3.5 is not a channel
  });

  it("refuses a file with no name column, naming what it did see", () => {
    const r = parseCameraCsv("foo,bar\n1,2\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No name column/);
    expect(r.error).toMatch(/foo, bar/);
  });

  it("x/y come through as metres when present", () => {
    const r = parseCameraCsv("name,x,y\nA,12.5,30\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.rows[0]).toMatchObject({ x: 12.5, y: 30 });
  });
});
