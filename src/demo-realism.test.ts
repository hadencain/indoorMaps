// Realism gates for the rebuilt demos (casino v6, mall v2). These encode the
// spec's success criteria: wall-to-wall partitioning (no void), real service
// program, genuine floor variation, full reachability. Scoped to the two
// rebuilt venues — the legacy demos predate this bar.
import { describe, expect, it } from "vitest";
import { casinoBuilding } from "./demos/casino";
import { mallBuilding } from "./demos/mall";
import { buildGraph } from "./graph";
import { pointInRing } from "./coverage";
import { bbox, polygonArea } from "./geo";
import type { Building, MetreXY, Unit } from "./types";

const CIRCULATION = new Set(["corridor", "stairs", "elevator"]);

function fillRatio(b: Building, ordinal: number): number {
  const fp = b.footprints!.find((f) => f.ordinal === ordinal)!.polygon;
  const interior = b.units.filter((u) => u.ordinal === ordinal && u.category !== "outside");
  const [x0, y0, x1, y1] = bbox(fp);
  let inFp = 0, covered = 0;
  for (let x = x0 + 0.37; x < x1; x += 2)
    for (let y = y0 + 0.37; y < y1; y += 2) {
      const pt: MetreXY = [x, y];
      if (!pointInRing(pt, fp)) continue;
      inFp++;
      if (interior.some((u) => pointInRing(pt, u.polygon))) covered++;
    }
  return covered / inFp;
}

function reachableUnits(b: Building): Set<string> {
  const g = buildGraph(b);
  // Opening nodes are namespaced (`entrance:<id>`) in the graph; seed the BFS
  // from each live entrance's host unit (same form as the generator's gates).
  const seen = new Set<string>(
    b.openings
      .filter((op) => op.kind === "entrance" && g.nodes.has(`entrance:${op.id}`))
      .map((op) => op.unit),
  );
  const stack = [...seen];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of g.adj.get(n) ?? []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return seen;
}

function checkVenue(name: string, b: Building) {
  describe(name, () => {
    it("declares demoRev ≥ 2", () => expect(b.demoRev ?? 0).toBeGreaterThanOrEqual(2));

    it("every floor: ≥95% footprint fill (no void), corridor present, restroom pair, service room", () => {
      for (const lvl of b.levels) {
        const o = lvl.ordinal;
        const interior = b.units.filter((u) => u.ordinal === o && u.category !== "outside");
        expect(fillRatio(b, o), `ord${o} fill`).toBeGreaterThanOrEqual(0.95);
        expect(interior.some((u) => u.category === "corridor"), `ord${o} corridor`).toBe(true);
        expect(interior.filter((u) => u.category === "restroom").length, `ord${o} restrooms`).toBeGreaterThanOrEqual(2);
        expect(interior.some((u) => u.category === "mechanical" || u.category === "storage"), `ord${o} service`).toBe(true);
      }
    });

    it("no sliver rooms", () => {
      for (const u of b.units) {
        if (u.category === "outside") continue;
        const [x0, y0, x1, y1] = bbox(u.polygon);
        expect(polygonArea(u.polygon), `${u.id} area`).toBeGreaterThanOrEqual(6);
        expect(Math.min(x1 - x0, y1 - y0), `${u.id} width`).toBeGreaterThanOrEqual(1.4);
      }
    });

    it("every routable unit is reachable from an entrance; restricted units still have doors", () => {
      const g = buildGraph(b);
      const seen = reachableUnits(b);
      for (const u of b.units) {
        if (u.category === "outside") continue;
        if (u.security === "restricted") {
          expect(b.openings.some((op) => op.unit === u.id), `${u.id} door`).toBe(true);
          continue;
        }
        if (g.nodes.has(u.id)) expect(seen.has(u.id), `${u.id} reachable`).toBe(true);
      }
    });

    it("floors share the core but not the plan (<30% identical non-circulation polygons)", () => {
      const polys = (o: number, circ: boolean) =>
        new Set(
          b.units
            .filter((u: Unit) => u.ordinal === o && u.category !== "outside" && CIRCULATION.has(u.category) === circ)
            .map((u) => JSON.stringify(u.polygon)),
        );
      for (let o = 0; o + 1 < b.levels.length; o++) {
        const a = polys(o, false), c = polys(o + 1, false);
        const identical = [...a].filter((p) => c.has(p)).length;
        expect(identical / Math.min(a.size, c.size), `ord${o}↔${o + 1}`).toBeLessThan(0.3);
      }
    });

    it("has tenants (occupants) and cameras", () => {
      expect((b.occupants ?? []).length).toBeGreaterThan(0);
      expect(b.cameras.length).toBeGreaterThan(20);
    });
  });
}

checkVenue("casino (v6)", casinoBuilding);
checkVenue("mall (v2)", mallBuilding);
