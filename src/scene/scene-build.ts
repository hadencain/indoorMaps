// 3D scene description — pure, metre-space, renderer-agnostic.
//
// render.ts's sibling: Building + ordinal in, plain data out (prisms, wall
// segments, camera poses) — same inputs, different output shape (prisms vs
// GeoJSON). The Three.js adapter in src/editor3d/ maps this description to
// meshes; a future Babylon/WebGPU swap replaces only that adapter.
//
// FORBIDDEN IMPORTS (spec "Forbidden relationships", docs/3d-editor-spec.md,
// grep-audited): three.js, React, MapLibre, the zustand store. Only pure
// sibling modules (types / render tables / coverage constants / geo).

import type { Building, CameraKind, Category, MetreXY } from "../types";
import {
  DEFAULT_FIXTURE_HEIGHT_M,
  FIXTURE_HEIGHT_M,
  UNIT_HEIGHT_M,
  levelCeilingM,
  resolveStructureExtent,
} from "../render";
import { MOUNT_H } from "../coverage";
import { polygonArea } from "../geo";

/** First-person eye height above the floor slab, metres (walk-mode camera). */
export const EYE_M = 1.7;

/** Synthesized wall thickness, metres. Walls have no thickness data field —
 *  a SceneWall is an infinitely thin segment; the renderer extrudes it as a
 *  box this deep so it reads as a solid wall at eye level. */
export const WALL_THICKNESS_M = 0.15;

/** Vertical FOV derived from a horizontal FOV at a 16:9 sensor aspect:
 *  vfov = 2·atan(tan(hfov/2) · 9/16), in degrees — the spec's default rule
 *  (OQ-2), used when Camera.vfovDeg is absent. Exact projection trig, valid
 *  only for hfov < 180° (tan(hfov/2) flips sign past that), so the input is
 *  clamped into [1, 179] first: the data model permits wide wedges
 *  (180 < fovDeg < 360) and hand-edited files reach here unvalidated; domes
 *  ignore vfov anyway (OQ-5 hemisphere gizmo). The 2D tilt band (vfovHalfRad
 *  in coverage.ts) clamps a LINEAR approximation of the same rule — a
 *  recorded OQ-2 divergence: the 3D frustum wants the true angle, the 2D
 *  band keeps its shipped numbers. */
export function deriveVfovDeg(fovDeg: number): number {
  const h = Math.min(179, Math.max(1, fovDeg));
  return (2 * Math.atan(Math.tan((h * Math.PI) / 360) * (9 / 16)) * 180) / Math.PI;
}

/** Drop below the ceiling for a ceiling-mounted camera with no authored height. */
const CEILING_MOUNT_DROP_M = 0.6;
/** Practical ceiling for an unauthored mount: a 12 m atrium does not put its
 *  cameras 11.4 m up — installers work off catwalks/poles around this height. */
const MAX_DEFAULT_MOUNT_M = 7;

/**
 * Display mount height for a camera with no authored `mountM`, given the floor's
 * ceiling. Cameras are ceiling-mounted hardware: pinning every unauthored camera
 * to the flat MOUNT_H (4 m) left them floating mid-air in a 7 m casino hall and
 * reading as "too low to the ground" in walk mode.
 *
 * At the 3.2 m default ceiling this returns the legacy value (4 m clamped to
 * 3.1 m by the caller), so existing venues render unchanged. 3D-ONLY: the 2D
 * tiltBand keeps using the raw stored value — and is null for untilted/dome
 * cameras anyway, so coverage geometry never moves because of this.
 */
export function defaultMountM(ceilingM: number): number {
  return Math.min(
    Math.max(MOUNT_H, ceilingM - CEILING_MOUNT_DROP_M),
    MAX_DEFAULT_MOUNT_M,
  );
}

/** A vertical extrusion of an open metre ring, baseM..topM above the floor
 *  slab. `kind` is the source object's category/kind string — the renderer's
 *  material lookup key, never geometry. */
export interface ScenePrism {
  id: string;
  kind: string;
  ring: MetreXY[];
  baseM: number;
  topM: number;
}

/** One wall segment, floor (0) to `topM`. Thin by convention — the renderer
 *  applies WALL_THICKNESS_M. */
export interface SceneWall {
  a: MetreXY;
  b: MetreXY;
  topM: number;
}

/** A flat per-unit floor patch (carpet colour by category) laid over the
 *  slab so the space reads at eye level. */
export interface SceneFloorPatch {
  id: string;
  category: Category;
  ring: MetreXY[];
}

/** A CCTV camera pose with every absent-able field resolved — the renderer
 *  never reads a `?? default` again. Angle conventions are the stored ones
 *  (types.ts): headingDeg from +x CCW (atan2-native), tiltDeg BELOW
 *  horizontal, rollDeg CW looking along the view direction. */
export interface SceneCameraPose {
  id: string;
  name: string;
  at: MetreXY;
  mountM: number;
  headingDeg: number;
  tiltDeg: number;
  rollDeg: number;
  fovDeg: number;
  vfovDeg: number;
  rangeM: number;
  kind: CameraKind;
  mount: "ceiling" | "wall" | "column";
}

/** Everything the 3D renderer needs for one floor, in local metres.
 *  `footprintRing` is null when the ordinal has no usable footprint polygon
 *  (no slab, no exterior envelope). */
export interface Scene3D {
  ordinal: number;
  ceilingM: number;
  footprintRing: MetreXY[] | null;
  floorPatches: SceneFloorPatch[];
  wallSegs: SceneWall[];
  slabPrisms: ScenePrism[];
  structurePrisms: ScenePrism[];
  fixturePrisms: ScenePrism[];
  cameras: SceneCameraPose[];
}

/** True when `ring` cannot form a real face: fewer than 3 vertices or ~zero
 *  area (collapsed / self-touching outlines emit no geometry). Same threshold
 *  collectWalls (coverage.ts) uses, so 2D and 3D skip the same polygons. */
function degenerate(ring: MetreXY[]): boolean {
  return ring.length < 3 || polygonArea(ring) < 1e-6;
}

/** Append every edge of an open ring (edge i -> (i+1)%n — the Unit.polygon
 *  closing convention, matching collectWalls). */
function pushEdges(out: SceneWall[], ring: MetreXY[], topM: number): void {
  for (let i = 0; i < ring.length; i++) {
    out.push({ a: ring[i], b: ring[(i + 1) % ring.length], topM });
  }
}

/**
 * Build the renderer-agnostic 3D scene for one floor.
 *
 * Derivations (all display-time — nothing here is written back to the data):
 * - `ceilingM`: levelCeilingM(b, ordinal) — authored Level.ceilingM, absent ⇒
 *   DEFAULT_CEILING_M.
 * - `footprintRing`: the ordinal's footprint polygon (≥ 3 verts) else null.
 * - `floorPatches`: every unit on the ordinal with a ≥ 3-vertex polygon.
 * - `wallSegs`: edges of full-height units (UNIT_HEIGHT_M ≥ 3) plus the
 *   footprint ring (exterior envelope), all rising to `ceilingM`. Mirrors
 *   collectWalls (coverage.ts) geometry — same edge convention, same
 *   degenerate skip, same footprint envelope — so 2D and 3D occlude against
 *   the same segments. Low-slab unit edges (corridor/lobby) become
 *   `slabPrisms` instead of walls: the recorded OQ-6 divergence (2D keeps
 *   treating every unit edge as a blocker).
 * - `slabPrisms`: units with 0 < UNIT_HEIGHT_M < 3, floor to that height.
 * - `structurePrisms`: structures on the ordinal. topM = the authored heightM
 *   clamped into [0, `ceilingM`] at render time (the stored value is
 *   preserved — spec failure-mode rule: the user may raise the ceiling next);
 *   absent ⇒ full height. baseM absent ⇒ 0, clamped into [0, topM]
 *   (degenerate-safe). Same clamps as structuresToGeoJSON, so 2D and 3D
 *   render identical prisms even from hand-edited negative values.
 * - `fixturePrisms`: fixtures on the ordinal at their synthesized display
 *   height (FIXTURE_HEIGHT_M, unknown kinds ⇒ DEFAULT_FIXTURE_HEIGHT_M);
 *   zero-height kinds (e.g. parking) emit nothing.
 * - `cameras`: every camera on the ordinal, absents resolved. mountM (absent
 *   ⇒ MOUNT_H) is display-clamped into [0.1, ceilingM − 0.1] so the gizmo
 *   stays under the authored ceiling — a deliberate divergence from the 2D
 *   tiltBand, which uses the raw stored value (clamped only at 0).
 */
export function build3dScene(b: Building, ordinal: number): Scene3D {
  const ceilingM = levelCeilingM(b, ordinal);

  const fp = b.footprints?.find((f) => f.ordinal === ordinal && f.polygon.length >= 3);
  const footprintRing = fp?.polygon ?? null;

  const floorPatches: SceneFloorPatch[] = [];
  const wallSegs: SceneWall[] = [];
  const slabPrisms: ScenePrism[] = [];
  for (const u of b.units) {
    if (u.ordinal !== ordinal) continue;
    if (u.polygon.length >= 3) {
      floorPatches.push({ id: u.id, category: u.category, ring: u.polygon });
    }
    if (degenerate(u.polygon)) continue;
    const h = UNIT_HEIGHT_M[u.category];
    if (h >= 3) {
      pushEdges(wallSegs, u.polygon, ceilingM);
    } else if (h > 0) {
      slabPrisms.push({ id: u.id, kind: u.category, ring: u.polygon, baseM: 0, topM: h });
    }
    // h === 0 (outside): floor patch only — never extruded.
  }
  if (footprintRing) pushEdges(wallSegs, footprintRing, ceilingM);

  const structurePrisms: ScenePrism[] = [];
  for (const s of b.structures ?? []) {
    if (s.ordinal !== ordinal || degenerate(s.polygon)) continue;
    // resolveStructureExtent is the SINGLE source shared with structuresToGeoJSON
    // (render.ts), so the 2D extrusion and this 3D prism can never disagree on a
    // structure's height (heightM ceiling-capped, baseM clamped into [0, topM]).
    const { baseM, topM } = resolveStructureExtent(s.heightM, s.baseM, ceilingM);
    structurePrisms.push({ id: s.id, kind: s.kind, ring: s.polygon, baseM, topM });
  }

  const fixturePrisms: ScenePrism[] = [];
  for (const f of b.fixtures ?? []) {
    if (f.ordinal !== ordinal || degenerate(f.polygon)) continue;
    const topM = FIXTURE_HEIGHT_M[f.kind] ?? DEFAULT_FIXTURE_HEIGHT_M;
    if (topM <= 0) continue;
    fixturePrisms.push({ id: f.id, kind: f.kind, ring: f.polygon, baseM: 0, topM });
  }

  const cameras: SceneCameraPose[] = [];
  for (const c of b.cameras) {
    if (c.ordinal !== ordinal) continue;
    cameras.push({
      id: c.id,
      name: c.name,
      at: c.at,
      mountM: Math.max(0.1, Math.min(c.mountM ?? defaultMountM(ceilingM), ceilingM - 0.1)),
      headingDeg: c.heading,
      tiltDeg: c.tiltDeg ?? 0,
      rollDeg: c.rollDeg ?? 0,
      fovDeg: c.fovDeg,
      // Authored override clamped into the same sane (0°, 180°) window the 2D
      // twin (vfovHalfRad) enforces — hand-edited files reach here unvalidated.
      vfovDeg:
        c.vfovDeg != null
          ? Math.min(179, Math.max(1, c.vfovDeg))
          : deriveVfovDeg(c.fovDeg),
      rangeM: c.rangeM,
      kind: c.kind,
      mount: c.mount ?? "ceiling",
    });
  }

  return {
    ordinal,
    ceilingM,
    footprintRing,
    floorPatches,
    wallSegs,
    slabPrisms,
    structurePrisms,
    fixturePrisms,
    cameras,
  };
}
