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
  /** Active floor's coverage/blind analysis — null unless `showCoverage` is on
   *  (the boolean union is not run while the overlay is off). */
  coverage: CoverageResult | null;
}

export function useVisibility(): VisibilityInfo {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const showCoverage = useStore((s) => s.showCoverage);

  const walls = useMemo(
    () => collectWalls(building, ordinal),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building.units, ordinal],
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

  // Coverage/blind union — gated behind showCoverage (skip the work when off),
  // memoized on the same walls/visibility identity so it recomputes exactly
  // when the visibility set or floor geometry changes.
  const coverage = useMemo<CoverageResult | null>(() => {
    if (!showCoverage) return null;
    return computeCoverage(building, ordinal, polys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCoverage, polys, walls, ordinal]);

  return { polys, coverage };
}
