// "Suggest cameras" — the productized camera-plant planner. Descends from the
// scratch plant-lib proven on all seven demo venues (corner-mount pass per
// unit, greedy gap-fill against a coverage grid, every greedy candidate must
// RECOVER under-covered points to commit). Product differences from the demo
// generator:
//   - Floor-scoped: plans ONE ordinal per call (the floor the user is on).
//   - Seeds with EXISTING cameras' occlusion-clipped rings, so it fills the
//     actual gaps in the current plant instead of re-planting from zero.
//   - Footprint optional: a user-traced building (New property from image) has
//     no footprint yet — the coverage grid then falls back to the union of its
//     eligible units.
//   - No demo artifacts: no fake RTSP streamRefs, kind is honest "fixed".
import { collectWalls, computeCoverage, computeVisibility, pointInRing } from "../coverage";
import type { Segment, VisibilityPolygon } from "../coverage";
import { bbox, polygonArea } from "../geo";
import type { Building, Camera, MetreXY } from "../types";

const SKIP_CATEGORIES = new Set(["stairs", "elevator", "outside"]);

export interface Suggestion {
  cam: Camera;
  /** Occlusion-clipped visibility ring, precomputed at suggest time — rendered
   *  as the ghost's dashed coverage preview without re-raycasting per frame. */
  ring: MetreXY[];
}

export interface SuggestStats {
  /** Coverage % before / after (projected) the plan — computed with the SAME
   *  polygon-union area math as the coverage layer's readout (computeCoverage),
   *  not the planner's search grid. The grid samples cell centres, which counts
   *  a half-covered cell as covered and once overstated a projection by eight
   *  points (94% projected, 86% delivered) — a credibility problem when the
   *  number is read out in a sales meeting. The grid remains the greedy
   *  search's heuristic; it no longer makes claims. */
  beforePct: number;
  afterPct: number;
  cornerCount: number;
  fillCount: number;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  stats: SuggestStats;
}

function coverCounts(pts: MetreXY[], rings: MetreXY[][]): Uint16Array {
  const boxes = rings.map(bbox);
  const counts = new Uint16Array(pts.length);
  for (let i = 0; i < rings.length; i++) {
    const [bx0, by0, bx1, by1] = boxes[i];
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j];
      if (p[0] < bx0 || p[0] > bx1 || p[1] < by0 || p[1] > by1) continue;
      if (pointInRing(p, rings[i])) counts[j]++;
    }
  }
  return counts;
}

/** Plan ghost cameras for one floor. Pure — never mutates the building; the
 *  caller decides which suggestions to commit. */
export function suggestCameras(
  b: Building,
  ordinal: number,
  targetPct: number,
  maxNew: number,
): SuggestResult {
  const walls: Segment[] = collectWalls(b, ordinal);
  const target = Math.min(0.99, Math.max(0.1, targetPct / 100));

  const eligibleUnits = b.units.filter(
    (u) =>
      u.ordinal === ordinal &&
      !SKIP_CATEGORIES.has(u.category) &&
      u.polygon.length >= 3 &&
      polygonArea(u.polygon) >= 20,
  );

  // Coverage region: the footprint when one exists, else the eligible units.
  const fp = b.footprints?.find((f) => f.ordinal === ordinal)?.polygon;
  const regionPolys: MetreXY[][] =
    fp && fp.length >= 3 ? [fp] : eligibleUnits.map((u) => u.polygon);
  const empty: SuggestResult = {
    suggestions: [],
    stats: { beforePct: 0, afterPct: 0, cornerCount: 0, fillCount: 0 },
  };
  if (regionPolys.length === 0) return empty;

  // Grid: adaptive pitch so a small club and an airport concourse both land in
  // a workable point count (~2-4k points).
  let regionArea = 0;
  for (const p of regionPolys) regionArea += Math.abs(polygonArea(p));
  const grid = Math.min(4, Math.max(1.25, Math.sqrt(regionArea / 2500)));
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const p of regionPolys) {
    const [x0, y0, x1, y1] = bbox(p);
    gx0 = Math.min(gx0, x0); gy0 = Math.min(gy0, y0);
    gx1 = Math.max(gx1, x1); gy1 = Math.max(gy1, y1);
  }
  const inRegion = (p: MetreXY) => regionPolys.some((ring) => pointInRing(p, ring));
  const pts: MetreXY[] = [];
  for (let x = gx0 + grid / 2; x < gx1; x += grid)
    for (let y = gy0 + grid / 2; y < gy1; y += grid)
      if (inRegion([x, y])) pts.push([x, y]);
  if (pts.length === 0) return empty;

  // Seed with the EXISTING plant on this floor.
  const existing = b.cameras.filter((c) => c.ordinal === ordinal);
  const rings: MetreXY[][] = [];
  for (const cam of existing) {
    const ring = computeVisibility(cam, walls);
    if (ring.length >= 3) rings.push(ring);
  }

  const out: Suggestion[] = [];
  let seq = 1;
  const stamp = Date.now();

  // Duplicate guard — seeded with the existing plant so a suggestion can never
  // land on top of a camera that's already there (same position + same aim).
  const placedCams: { at: MetreXY; heading: number }[] = existing.map((c) => ({
    at: c.at,
    heading: c.heading,
  }));
  const headingDiff = (a: number, bb: number) => {
    const d = Math.abs(a - bb) % 360;
    return d > 180 ? 360 - d : d;
  };
  const isDuplicateCam = (at: MetreXY, heading: number) =>
    placedCams.some(
      (p) => Math.hypot(p.at[0] - at[0], p.at[1] - at[1]) <= 1.5 && headingDiff(p.heading, heading) <= 25,
    );

  const tryPlace = (at: MetreXY, heading: number, fov: number, range: number, zone: string) => {
    const cam: Camera = {
      id: `cam-sg-${stamp}-${seq}`,
      ordinal,
      at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10],
      heading: Math.round(heading + 360) % 360,
      fovDeg: fov,
      rangeM: range,
      kind: "fixed",
      name: `${zone} · New ${String(seq).padStart(2, "0")}`,
    };
    const ring = computeVisibility(cam, walls);
    if (ring.length < 3 || Math.abs(polygonArea(ring)) < 15) return null;
    return { cam, ring };
  };
  const commit = (p: Suggestion) => {
    rings.push(p.ring);
    out.push(p);
    placedCams.push({ at: p.cam.at, heading: p.cam.heading });
    seq++;
  };

  // ---- Pass 1: corner mounts, only in rooms with NO camera yet ----
  let cornerCount = 0;
  for (const u of eligibleUnits) {
    if (out.length >= maxNew) break;
    if (existing.some((c) => pointInRing(c.at, u.polygon))) continue;
    const poly = u.polygon;
    const area = polygonArea(poly);
    if (area < 25) continue;
    let cx = 0, cy = 0;
    for (const [x, y] of poly) { cx += x; cy += y; }
    cx /= poly.length;
    cy /= poly.length;
    // Gentler than the demo generator (which styles a dense casino plant):
    // 1-4 corner cams by room size; gap-fill closes the rest to target.
    const k = area < 120 ? 1 : area < 400 ? 2 : area < 1200 ? 3 : 4;
    const camRange = Math.min(50, Math.max(16, Math.round(1.7 * Math.sqrt(area))));
    const step = poly.length / Math.min(k, poly.length);
    for (let i = 0; i < Math.min(k, poly.length) && out.length < maxNew; i++) {
      const v = poly[Math.floor(i * step) % poly.length];
      const d = Math.hypot(cx - v[0], cy - v[1]) || 1;
      const at: MetreXY = [v[0] + ((cx - v[0]) / d) * 1.3, v[1] + ((cy - v[1]) / d) * 1.3];
      const heading = (Math.atan2(cy - at[1], cx - at[0]) * 180) / Math.PI;
      if (isDuplicateCam(at, heading)) continue;
      const p = tryPlace(at, heading, 100, camRange, u.name);
      if (p) {
        commit(p);
        cornerCount++;
      }
    }
  }

  // ---- Pass 2: greedy gap-fill over the region to the coverage target ----
  // Every candidate must actually recover under-covered grid points to commit
  // (a jittered candidate can land across a wall and cover the wrong side).
  const OFFSETS: MetreXY[] = [[0.7, 0.7], [-1.3, 0.9], [1.1, -1.1], [-0.9, -0.7], [2.3, 1.7]];
  let fillCount = 0;
  {
    const counts = coverCounts(pts, rings);
    const dead = new Set<number>();
    let guard = 0;
    const maxFill = maxNew - out.length;
    while (fillCount < maxFill && guard++ < maxFill * 5 + 40) {
      const under: number[] = [];
      let met = 0;
      for (let j = 0; j < pts.length; j++) {
        if (counts[j] >= 1) met++;
        else if (!dead.has(j)) under.push(j);
      }
      if (met / pts.length >= target || under.length === 0) break;
      // Densest under-covered cluster wins the next camera.
      const sample: number[] = [];
      const stride = Math.max(1, Math.floor(under.length / 400));
      for (let j = 0; j < under.length; j += stride) sample.push(under[j]);
      let best = -1, bi = -1;
      for (const j of sample) {
        let n = 0;
        for (const m of under)
          if (Math.hypot(pts[j][0] - pts[m][0], pts[j][1] - pts[m][1]) <= 14) n++;
        if (n > best) { best = n; bi = j; }
      }
      if (best < 2) break;
      const seed = pts[bi];
      let cxn = 0, cyn = 0, nn = 0;
      for (const m of under) {
        const q = pts[m];
        if (Math.hypot(q[0] - seed[0], q[1] - seed[1]) <= 22) { cxn += q[0]; cyn += q[1]; nn++; }
      }
      cxn /= nn;
      cyn /= nn;
      let bestCand: (Suggestion & { gain: number }) | null = null;
      for (const [ox, oy] of OFFSETS) {
        const at: MetreXY = [seed[0] + ox, seed[1] + oy];
        if (!inRegion(at)) continue;
        const baseHeading =
          nn > 1 && Math.hypot(cxn - at[0], cyn - at[1]) > 0.5
            ? (Math.atan2(cyn - at[1], cxn - at[0]) * 180) / Math.PI
            : 0;
        const unit = b.units.find((u) => u.ordinal === ordinal && pointInRing(at, u.polygon));
        const zone = unit?.name ?? "Open floor";
        // Natural heading plus two diversified variants, so a second angle near
        // a covered seed can still win on gain when the natural aim duplicates.
        for (const heading of [baseHeading, baseHeading + 40, baseHeading - 40]) {
          if (isDuplicateCam(at, heading)) continue;
          const cand = tryPlace(at, heading, 110, 45, zone);
          if (!cand) continue;
          const [bx0, by0, bx1, by1] = bbox(cand.ring);
          let gain = 0;
          for (const m of under) {
            const q = pts[m];
            if (q[0] < bx0 || q[0] > bx1 || q[1] < by0 || q[1] > by1) continue;
            if (pointInRing(q, cand.ring)) gain++;
          }
          if (!bestCand || gain > bestCand.gain) bestCand = { ...cand, gain };
        }
      }
      if (bestCand && bestCand.gain >= Math.max(2, Math.floor(nn * 0.15))) {
        commit(bestCand);
        fillCount++;
        const [bx0, by0, bx1, by1] = bbox(bestCand.ring);
        for (let j = 0; j < pts.length; j++) {
          const p = pts[j];
          if (p[0] < bx0 || p[0] > bx1 || p[1] < by0 || p[1] > by1) continue;
          if (pointInRing(p, bestCand.ring)) counts[j]++;
        }
      } else dead.add(bi);
    }
  }

  // Report with the layer's own math so "projected" and the readout after
  // Accept-all are the SAME number by construction.
  const toVis = (ring: MetreXY[], i: number): VisibilityPolygon => ({
    cameraId: `proj-${i}`,
    ordinal,
    ring,
  });
  const existingVis = existing
    .map((cam) => computeVisibility(cam, walls))
    .filter((r) => r.length >= 3)
    .map(toVis);
  const projectedVis = [...existingVis, ...out.map((sg, i) => toVis(sg.ring, 1000 + i))];
  return {
    suggestions: out,
    stats: {
      beforePct: computeCoverage(b, ordinal, existingVis).coveragePct,
      afterPct: computeCoverage(b, ordinal, projectedVis).coveragePct,
      cornerCount,
      fillCount,
    },
  };
}
