import { useMemo, useRef } from "react";
import { useStore } from "../store";
import { collectWalls, computeVisibility, computeCoverage } from "../coverage";
import type { Segment, VisibilityPolygon, CoverageResult } from "../coverage";
import type { Camera } from "../types";

/** Cheap per-camera signature: changes iff the camera's geometry inputs change. */
function camSig(c: Camera): string {
  return `${c.at[0]},${c.at[1]}:${c.heading}:${c.fovDeg}:${c.rangeM}:${c.kind}`;
}

interface CacheEntry {
  sig: string;
  walls: Segment[]; // identity check — new walls array ⇒ recompute
  ring: import("../coverage").VisibilityPolygon["ring"];
}

/**
 * Active floor's occlusion-clipped visibility polygons, one per camera.
 *
 * Memoization (exact, off the render path — not the spec's version-counter):
 *  - `walls` is memoized on `[building.units, ordinal]`. Camera-only mutations
 *    (`moveCamera`, `rotateCamera`, …) do `{ ...building, cameras: [...] }`,
 *    preserving the `building.units` array *reference*, so `walls` stays stable
 *    and identity-equal. Any unit-geometry edit produces a *new* `units` array,
 *    invalidating `walls`.
 *  - Per-camera results are cached by id in a ref. A camera recomputes only when
 *    its own signature changes OR the `walls` reference changes. So moving one
 *    camera recomputes only that camera; moving a wall recomputes every camera
 *    on the floor. No store action needs touching.
 */
export interface VisibilityInfo {
  /** Active floor's occlusion-clipped visibility polygons, one per camera. */
  polys: VisibilityPolygon[];
  /** Active floor's coverage/blind analysis — null unless the coverage or
   *  blind-spots layer is on (the boolean union is skipped while both are off). */
  coverage: CoverageResult | null;
}

export function useVisibility(): VisibilityInfo {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  // The Layers popover is the single source of truth for coverage visibility:
  // compute the (expensive) boolean union whenever EITHER overlay is on.
  const coverageOn = useStore((s) => s.layers.coverage);
  const blindOn = useStore((s) => s.layers.blindSpots);

  const walls = useMemo(
    () => collectWalls(building, ordinal),
    // footprints joins units as an occluder input (see collectWalls); include it
    // so editing the envelope invalidates the wall cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building.units, building.footprints, ordinal],
  );

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  const polys = useMemo(() => {
    const cache = cacheRef.current;
    const cams = building.cameras.filter((c) => c.ordinal === ordinal);
    const seen = new Set<string>();
    const out: VisibilityPolygon[] = [];

    for (const cam of cams) {
      seen.add(cam.id);
      const sig = camSig(cam);
      const prev = cache.get(cam.id);
      let ring: CacheEntry["ring"];
      if (prev && prev.sig === sig && prev.walls === walls) {
        ring = prev.ring; // unchanged camera on unchanged floor geometry
      } else {
        ring = computeVisibility(cam, walls);
        cache.set(cam.id, { sig, walls, ring });
      }
      out.push({ cameraId: cam.id, ordinal, ring });
    }

    // Prune deleted / off-floor cameras so the cache can't grow unbounded.
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);

    return out;
  }, [building.cameras, walls, ordinal]);

  // Coverage/blind union — gated behind the coverage/blind layers (skip when off),
  // memoized on the same walls/visibility identity so it recomputes exactly
  // when the visibility set or floor geometry changes.
  const coverage = useMemo<CoverageResult | null>(() => {
    if (!coverageOn && !blindOn) return null;
    try {
      return computeCoverage(building, ordinal, polys);
    } catch {
      // The boolean-geometry library (polygon-clipping) can throw on pathological
      // / near-degenerate inputs (e.g. many overlapping high-vertex visibility
      // polygons). Degrade to no coverage overlay rather than crash the render;
      // the per-camera FOV cones still show.
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageOn, blindOn, polys, walls, ordinal]);

  return { polys, coverage };
}
