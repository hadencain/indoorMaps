// Vertical circulation for the walk editor (Phase C of the AAA venue render pass,
// docs/superpowers/plans/2026-08-01-aaa-venue-render.md).
//
// three.js is imported here ONLY inside src/editor3d/ so the bundle boundary stays
// grep-auditable and the single-file viewer never pulls it in.
//
// Stair and elevator units were rendered exactly like any other room: a floor
// patch and four walls. A stairwell with a flat floor is one of those details that
// quietly tells you a building is fake — it is a space defined ENTIRELY by the
// thing inside it, and the thing inside it was missing. So a `stairs` unit now
// gets a real flight (treads, risers, stringers, handrails) fitted to its own
// footprint, and an `elevator` unit gets a door pair and a call plate.
//
// Everything merges per material: a floor's whole vertical circulation is three
// draw calls regardless of how many cores it has.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MetreXY } from "../types";
import type { SceneFloorPatch } from "../scene/scene-build";

/** Comfortable riser height, metres — the target the flight is fitted to. Real
 *  code is ~0.15–0.19; the actual riser is solved from the ceiling height so a
 *  flight always lands exactly on the floor above rather than ending in mid-air. */
const TARGET_RISER_M = 0.175;
/** Minimum tread going, metres. */
const MIN_GOING_M = 0.24;
/** Handrail height above the nosing line, metres. */
const RAIL_H = 0.95;

interface Frame {
  cx: number;
  cy: number;
  /** Unit vector along the flight's run. */
  ux: number;
  uy: number;
  lengthM: number;
  widthM: number;
}

/** Oriented frame of a ring: its longest-edge direction, and the extents measured
 *  along that direction and across it. Exact for the rectilinear cores these
 *  venues are made of, and degrades gracefully for anything else. */
function ringFrame(ring: MetreXY[]): Frame | null {
  if (ring.length < 3) return null;
  let best = -1;
  let ux = 1;
  let uy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      const len = Math.sqrt(d) || 1;
      ux = dx / len;
      uy = dy / len;
    }
  }
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  cx /= ring.length;
  cy /= ring.length;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, y] of ring) {
    const du = (x - cx) * ux + (y - cy) * uy;
    const dv = -(x - cx) * uy + (y - cy) * ux;
    minU = Math.min(minU, du);
    maxU = Math.max(maxU, du);
    minV = Math.min(minV, dv);
    maxV = Math.max(maxV, dv);
  }
  return { cx, cy, ux, uy, lengthM: maxU - minU, widthM: maxV - minV };
}

/** Push a box authored in the frame's local space (u along the run, v across it,
 *  y up) into world space. */
function frameBox(
  out: THREE.BufferGeometry[],
  f: Frame,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  y0: number,
  y1: number,
): void {
  const du = u1 - u0;
  const dv = v1 - v0;
  const dy = y1 - y0;
  if (du <= 1e-4 || dv <= 1e-4 || dy <= 1e-4) return;
  const g = new THREE.BoxGeometry(du, dy, dv);
  g.translate((u0 + u1) / 2, (y0 + y1) / 2, -(v0 + v1) / 2);
  // Rotate local +u onto the frame direction, then move to the ring's centre.
  g.rotateY(Math.atan2(f.uy, f.ux));
  g.translate(f.cx, 0, -f.cy);
  out.push(g);
}

/**
 * A straight flight filling the unit, rising the full storey height.
 *
 * The riser is SOLVED (`riseM / n`) rather than fixed, so the flight always lands
 * exactly on the floor above instead of stopping short or punching through it —
 * which is the whole reason a stair reads as real. The going is whatever the
 * footprint affords, floored at MIN_GOING_M; a core too short for a comfortable
 * run just gets a steeper stair, the same compromise a real tight core makes.
 */
function buildFlight(
  f: Frame,
  riseM: number,
  treads: THREE.BufferGeometry[],
  metal: THREE.BufferGeometry[],
): void {
  const n = Math.max(3, Math.round(riseM / TARGET_RISER_M));
  const riser = riseM / n;
  const runAvail = Math.max(1, f.lengthM - 0.6); // leave a landing at the top
  const going = Math.max(MIN_GOING_M, runAvail / n);
  const halfW = Math.max(0.5, Math.min(f.widthM / 2 - 0.12, 1.1));
  const u0 = -f.lengthM / 2 + 0.3;

  for (let i = 0; i < n; i++) {
    const uA = u0 + i * going;
    const y = (i + 1) * riser;
    // Tread + the solid mass beneath it, as one box from the floor up: cheaper
    // than a separate tread and riser, and identical from every angle a walker
    // ever sees.
    frameBox(treads, f, uA, uA + going, -halfW, halfW, 0, y);
  }

  // Stringers down each side, and a handrail above them following the pitch.
  const topY = riseM;
  const runEnd = u0 + n * going;
  for (const side of [-1, 1]) {
    const v = side * halfW;
    // The rail is a thin box spanning the run; it is drawn horizontal at the
    // midpoint height rather than raked, because a raked box needs a rotation
    // about the run-perpendicular axis that this frame deliberately does not
    // carry — and at handrail scale the difference is invisible while walking.
    frameBox(metal, f, u0, runEnd, v - 0.04, v + 0.04, topY / 2 + RAIL_H - 0.03, topY / 2 + RAIL_H + 0.03);
    frameBox(metal, f, runEnd, f.lengthM / 2, v - 0.04, v + 0.04, topY + RAIL_H - 0.03, topY + RAIL_H + 0.03);
  }
  // Top landing.
  frameBox(treads, f, runEnd, f.lengthM / 2, -halfW, halfW, 0, topY);
}

/** Elevator doors: a centre-parting pair set into the longest wall, with a call
 *  plate beside them. */
function buildElevatorDoors(f: Frame, metal: THREE.BufferGeometry[]): void {
  const doorW = Math.min(1.1, f.widthM * 0.4);
  const doorH = 2.15;
  const v = f.widthM / 2;
  const uMid = 0;
  // Two leaves either side of the centre line, on the long wall.
  frameBox(metal, f, uMid - doorW, uMid - 0.02, v - 0.08, v, 0.02, doorH);
  frameBox(metal, f, uMid + 0.02, uMid + doorW, v - 0.08, v, 0.02, doorH);
  // Head architrave and a call plate.
  frameBox(metal, f, uMid - doorW - 0.1, uMid + doorW + 0.1, v - 0.1, v, doorH, doorH + 0.14);
  frameBox(metal, f, uMid + doorW + 0.16, uMid + doorW + 0.32, v - 0.09, v, 1.0, 1.35);
}

export interface VerticalBuild {
  meshes: THREE.Object3D[];
}

/**
 * Build the stair flights and elevator doors for one floor.
 *
 * `riseM` is the storey height the flights climb — the level's ceiling, which is
 * the best available stand-in for floor-to-floor in a model that stores ceilings
 * rather than slab levels.
 */
export function buildVertical(patches: SceneFloorPatch[], riseM: number): VerticalBuild {
  const treads: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];

  for (const patch of patches) {
    const f = ringFrame(patch.ring);
    // Guard against degenerate or absurd cores: a "stairs" unit the size of a
    // whole hall would emit a 60 m flight, which is worse than emitting nothing.
    if (!f || f.lengthM < 1.5 || f.widthM < 0.9) continue;
    if (patch.category === "stairs") {
      if (f.lengthM > 30) continue;
      buildFlight(f, Math.max(2.4, riseM), treads, metal);
    } else if (patch.category === "elevator") {
      if (f.lengthM > 12) continue;
      buildElevatorDoors(f, metal);
    }
  }

  const meshes: THREE.Object3D[] = [];
  const emit = (parts: THREE.BufferGeometry[], mat: THREE.Material): void => {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  };
  emit(treads, getTreadMaterial());
  emit(metal, getRailMaterial());
  return { meshes };
}

// ---- shared materials --------------------------------------------------------

let treadMat: THREE.MeshStandardMaterial | null = null;
let railMat: THREE.MeshStandardMaterial | null = null;

/** Precast concrete tread. */
function getTreadMaterial(): THREE.MeshStandardMaterial {
  if (!treadMat) {
    treadMat = new THREE.MeshStandardMaterial({ color: 0x8f8c86, roughness: 0.85, metalness: 0.02 });
    treadMat.userData.shared = true;
  }
  return treadMat;
}

/** Stainless handrail / lift door. */
function getRailMaterial(): THREE.MeshStandardMaterial {
  if (!railMat) {
    railMat = new THREE.MeshStandardMaterial({ color: 0xb6bcc4, roughness: 0.28, metalness: 0.9 });
    railMat.userData.shared = true;
  }
  return railMat;
}

/** Dispose the shared vertical-circulation materials. Call ONCE from dispose(). */
export function disposeVertical(): void {
  treadMat?.dispose();
  treadMat = null;
  railMat?.dispose();
  railMat = null;
}
