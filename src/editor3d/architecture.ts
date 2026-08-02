// Wall and opening construction for the walk editor (Phase B of the AAA venue
// render pass, docs/superpowers/plans/2026-08-01-aaa-venue-render.md).
//
// three.js is imported here ONLY inside src/editor3d/ so the bundle boundary stays
// grep-auditable and the single-file viewer never pulls it in.
//
// WHAT CHANGED AND WHY: walls used to be one InstancedMesh of solid boxes running
// floor to ceiling, with every unit contributing its own edges. Two consequences,
// both of which dominated the render far more than any material or shader gap:
//
//   · `openings` — real door data, present in every venue — rendered as NOTHING.
//     Every room was a sealed cube. You could not see through a doorway, into a
//     shop, or across a threshold, which is why the venues read as a maze of
//     blank partitions rather than as buildings.
//   · a partition shared by two rooms was emitted TWICE, as two boxes in the same
//     volume: doubled apparent thickness and z-fighting down every shared face.
//
// scene-build now merges shared edges and solves each opening onto the wall it
// belongs to. This module turns that into geometry: solid spans around the holes,
// then the furniture that fills them — frames and leaves for doors, mullions and
// glazing and a lettered signage band for shopfronts.
//
// PERF CONTRACT: hole-free walls (the overwhelming majority) stay on the fast
// instanced path, one InstancedMesh per finish. Only walls that actually carry an
// opening are built as bespoke geometry, and those are merged per finish, so a
// floor costs a bounded handful of draw calls no matter how many doors it has.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SceneWall, SceneWallHole } from "../scene/scene-build";
import { WALL_THICKNESS_M } from "../scene/scene-build";
import { getMaterial, materialForWallFinish } from "./materials";

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** Baseboard trim height, metres. */
const BASEBOARD_H = 0.12;
/** Cornice height, metres — the trim band where wall meets ceiling. Cheap, and
 *  the single most effective cue that a wall was BUILT rather than extruded:
 *  real interiors almost never present a raw plaster-to-plaster junction. */
const CORNICE_H = 0.16;
/** How far trim stands proud of the wall face. */
const TRIM_PROUD = 0.02;

/** Depth of a door/opening reveal lining, metres. */
const LINING_D = 0.06;
/** Door leaf thickness, metres. */
const LEAF_T = 0.045;
/** Storefront mullion spacing, metres — the bay rhythm of a glazed shopfront. */
const MULLION_STEP_M = 1.45;
const MULLION_W = 0.07;
/** Height of the lettered signage band above a shopfront, metres. */
const SIGN_BAND_H = 0.62;

// ---- sign atlas --------------------------------------------------------------
// Every shopfront label on a floor is drawn into ONE canvas and every sign quad
// takes a sub-rect of it, so the whole floor's signage is a single draw call and a
// single texture. The alternative — a CanvasTexture per shop — is ~40 textures on
// a mall floor, allocated and thrown away on every rebuild.

const ATLAS_W = 2048;
const ATLAS_H = 2048;
const CELL_W = 1024; // two columns
const CELL_H = 72;
const ATLAS_COLS = ATLAS_W / CELL_W;
const ATLAS_ROWS = Math.floor(ATLAS_H / CELL_H);
const ATLAS_CAP = ATLAS_COLS * ATLAS_ROWS;

interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Lays labels out into a shared canvas and hands back each one's UV rect. Labels
 *  are deduped, so twenty units of the same chain occupy one cell. */
class SignAtlas {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly rects = new Map<string, AtlasRect>();
  private next = 0;
  used = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    // Transparent background: the emissive map lights only the glyphs, so the
    // band behind them stays the dark material and the letters read as backlit.
    this.ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
  }

  /** UV rect for a label, drawing it on first request. Null once the atlas is
   *  full — an over-capacity floor loses signage rather than corrupting the
   *  layout by wrapping onto occupied cells. */
  rectFor(label: string): AtlasRect | null {
    const existing = this.rects.get(label);
    if (existing) return existing;
    if (this.next >= ATLAS_CAP) return null;
    const i = this.next++;
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, CELL_H);
    ctx.clip();
    // Shrink to fit rather than clipping mid-word: a long tenant name should get
    // smaller, not get its tail cut off.
    let size = 52;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = label.toUpperCase();
    for (; size > 18; size -= 3) {
      ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
      if (ctx.measureText(text).width <= CELL_W - 60) break;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + CELL_W / 2, y + CELL_H / 2 + 1);
    ctx.restore();
    this.used = true;

    const r: AtlasRect = {
      u0: x / ATLAS_W,
      // Canvas y grows downward, texture v grows upward — flip so text is upright.
      v0: 1 - (y + CELL_H) / ATLAS_H,
      u1: (x + CELL_W) / ATLAS_W,
      v1: 1 - y / ATLAS_H,
    };
    this.rects.set(label, r);
    return r;
  }

  texture(): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }
}

// ---- shared materials --------------------------------------------------------

let trimMat: THREE.MeshStandardMaterial | null = null;
let frameMat: THREE.MeshStandardMaterial | null = null;
let leafMat: THREE.MeshStandardMaterial | null = null;

/** Painted trim (baseboard, cornice) — slightly lighter and smoother than the
 *  wall it runs against, which is what makes it read as a separate element. */
function getTrimMaterial(): THREE.MeshStandardMaterial {
  if (!trimMat) {
    trimMat = new THREE.MeshStandardMaterial({ color: 0xd8d4cb, roughness: 0.55, metalness: 0.02 });
    trimMat.userData.shared = true;
  }
  return trimMat;
}

/** Dark anodised frame/mullion metal. */
function getFrameMaterial(): THREE.MeshStandardMaterial {
  if (!frameMat) {
    frameMat = new THREE.MeshStandardMaterial({ color: 0x30333a, roughness: 0.35, metalness: 0.85 });
    frameMat.userData.shared = true;
  }
  return frameMat;
}

/** Door leaf — a mid-tone timber-ish panel. */
function getLeafMaterial(): THREE.MeshStandardMaterial {
  if (!leafMat) {
    leafMat = new THREE.MeshStandardMaterial({ color: 0x6a533a, roughness: 0.6, metalness: 0.05 });
    leafMat.userData.shared = true;
  }
  return leafMat;
}

// ---- geometry helpers --------------------------------------------------------

/** World transform of a wall: local +X runs a→b, local Y is up from the floor,
 *  local Z is across the wall's thickness, origin at the wall's MIDPOINT — the
 *  same convention the instanced path uses, so both paths land identically. */
function wallFrame(w: SceneWall): { m: THREE.Matrix4; len: number; yaw: number } | null {
  const dx = w.b[0] - w.a[0];
  const dy = w.b[1] - w.a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const yaw = Math.atan2(dy, dx);
  const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  // model (x,y) → three (x, ·, −y)
  const pos = new THREE.Vector3((w.a[0] + w.b[0]) / 2, 0, -(w.a[1] + w.b[1]) / 2);
  return { m: new THREE.Matrix4().compose(pos, q, ONE), len, yaw };
}

/** A box in wall-local space, pushed already transformed into world space. */
function localBox(
  out: THREE.BufferGeometry[],
  m: THREE.Matrix4,
  len: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  depth: number,
  zOff = 0,
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 1e-4 || h <= 1e-4) return;
  const g = new THREE.BoxGeometry(w, h, depth);
  // Wall-local X is measured from the a-end, but the frame's origin is the wall
  // midpoint, hence the −len/2.
  g.translate((x0 + x1) / 2 - len / 2, (y0 + y1) / 2, zOff);
  g.applyMatrix4(m);
  out.push(g);
}

/** Merge a batch and emit one mesh, or nothing if the batch is empty. Disposes
 *  the source parts — they exist only to be merged. */
function emitMerged(
  parts: THREE.BufferGeometry[],
  material: THREE.Material,
  out: THREE.Object3D[],
  opts: { cast?: boolean; receive?: boolean } = {},
): void {
  if (parts.length === 0) return;
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = opts.cast ?? true;
  mesh.receiveShadow = opts.receive ?? true;
  out.push(mesh);
}

// ---- opening furniture -------------------------------------------------------

/** Reveal lining around a hole: two jambs and a head, standing slightly proud of
 *  both wall faces so the opening reads as a built frame rather than a void cut
 *  with a knife. */
function addLining(
  parts: THREE.BufferGeometry[],
  m: THREE.Matrix4,
  len: number,
  h: SceneWallHole,
): void {
  const x0 = h.atM - h.widthM / 2;
  const x1 = h.atM + h.widthM / 2;
  const d = WALL_THICKNESS_M + LINING_D;
  localBox(parts, m, len, x0 - 0.05, x0, h.sillM, h.headM + 0.05, d);
  localBox(parts, m, len, x1, x1 + 0.05, h.sillM, h.headM + 0.05, d);
  localBox(parts, m, len, x0 - 0.05, x1 + 0.05, h.headM, h.headM + 0.05, d);
}

/** One or two door leaves filling the hole, hung on the host-unit side. */
function addLeaves(
  parts: THREE.BufferGeometry[],
  m: THREE.Matrix4,
  len: number,
  h: SceneWallHole,
): void {
  const inner = h.widthM - 0.06;
  const top = h.headM - 0.03;
  // Sit the leaf against the host-unit face of the wall, the way a real leaf hangs
  // in its frame rather than floating on the wall's centreline.
  const z = -h.outward * (WALL_THICKNESS_M / 2 - LEAF_T / 2);
  if (h.style === "double") {
    const half = inner / 2 - 0.01;
    localBox(parts, m, len, h.atM - inner / 2, h.atM - inner / 2 + half, h.sillM + 0.01, top, LEAF_T, z);
    localBox(parts, m, len, h.atM + inner / 2 - half, h.atM + inner / 2, h.sillM + 0.01, top, LEAF_T, z);
  } else {
    localBox(parts, m, len, h.atM - inner / 2, h.atM + inner / 2, h.sillM + 0.01, top, LEAF_T, z);
  }
}

/** Glazed shopfront: a base rail, vertical mullions on a regular bay rhythm, and
 *  a head rail — the frame that makes a pane of glass read as a shopfront instead
 *  of a hole. The glazing itself is emitted separately (different material). */
function addStorefrontFrame(
  parts: THREE.BufferGeometry[],
  m: THREE.Matrix4,
  len: number,
  h: SceneWallHole,
): void {
  const x0 = h.atM - h.widthM / 2;
  const x1 = h.atM + h.widthM / 2;
  const d = WALL_THICKNESS_M + 0.04;
  const base = h.sillM + 0.14;
  localBox(parts, m, len, x0, x1, h.sillM, base, d); // base rail / kickplate
  localBox(parts, m, len, x0, x1, h.headM - 0.1, h.headM, d); // head rail
  // Jamb posts, then intermediate mullions on an even division of the bay so the
  // rhythm is regular rather than leaving a runt panel at one end.
  localBox(parts, m, len, x0, x0 + MULLION_W, base, h.headM, d);
  localBox(parts, m, len, x1 - MULLION_W, x1, base, h.headM, d);
  const bays = Math.max(1, Math.round(h.widthM / MULLION_STEP_M));
  const step = h.widthM / bays;
  for (let i = 1; i < bays; i++) {
    const cx = x0 + i * step;
    localBox(parts, m, len, cx - MULLION_W / 2, cx + MULLION_W / 2, base, h.headM, d);
  }
}

// ---- public API --------------------------------------------------------------

export interface WallBuildResult {
  meshes: THREE.Object3D[];
  /** The sign atlas texture, when any shopfront was lettered. Per-rebuild (unlike
   *  the shared materials), so the caller disposes it with the rest of the world. */
  signTexture: THREE.CanvasTexture | null;
}

/**
 * Build every wall on a floor, plus the furniture in every opening.
 *
 * Hole-free walls go on the instanced path (one InstancedMesh per finish). Walls
 * carrying an opening are built as spans around the hole and merged per finish.
 * Trim, frames, leaves, mullions, glazing and signage are each merged across the
 * whole floor into one mesh, so the total draw-call cost is a small constant.
 */
export function buildWalls(walls: SceneWall[]): WallBuildResult {
  const out: THREE.Object3D[] = [];
  if (walls.length === 0) return { meshes: out, signTexture: null };

  const plainByFinish = new Map<string, SceneWall[]>();
  const holedByFinish = new Map<string, THREE.BufferGeometry[]>();
  const trimParts: THREE.BufferGeometry[] = [];
  const frameParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const glassParts: THREE.BufferGeometry[] = [];
  const signParts: THREE.BufferGeometry[] = [];
  const atlas = new SignAtlas();

  for (const w of walls) {
    if (w.holes.length === 0) {
      const arr = plainByFinish.get(w.finish);
      if (arr) arr.push(w);
      else plainByFinish.set(w.finish, [w]);
      continue;
    }
    const frame = wallFrame(w);
    if (!frame) continue;
    const { m, len } = frame;
    const parts = holedByFinish.get(w.finish) ?? [];

    // Solid spans between the holes, plus a header over each and a sill under any
    // hole that doesn't reach the floor.
    let cursor = 0;
    for (const h of w.holes) {
      const x0 = h.atM - h.widthM / 2;
      const x1 = h.atM + h.widthM / 2;
      if (x0 > cursor) localBox(parts, m, len, cursor, x0, 0, w.topM, WALL_THICKNESS_M);
      if (h.sillM > 0) localBox(parts, m, len, x0, x1, 0, h.sillM, WALL_THICKNESS_M);
      if (h.headM < w.topM) localBox(parts, m, len, x0, x1, h.headM, w.topM, WALL_THICKNESS_M);
      cursor = x1;
    }
    if (cursor < len) localBox(parts, m, len, cursor, len, 0, w.topM, WALL_THICKNESS_M);
    holedByFinish.set(w.finish, parts);

    // Trim runs on the solid spans only — a baseboard crossing a doorway is the
    // kind of detail that reads as wrong even when nobody can say why.
    let tc = 0;
    for (const h of w.holes) {
      const x0 = h.atM - h.widthM / 2;
      if (x0 > tc) {
        localBox(trimParts, m, len, tc, x0, 0, BASEBOARD_H, WALL_THICKNESS_M + TRIM_PROUD);
      }
      tc = h.atM + h.widthM / 2;
    }
    if (tc < len) localBox(trimParts, m, len, tc, len, 0, BASEBOARD_H, WALL_THICKNESS_M + TRIM_PROUD);
    // The cornice is continuous — it runs over the head of every opening.
    localBox(trimParts, m, len, 0, len, w.topM - CORNICE_H, w.topM, WALL_THICKNESS_M + TRIM_PROUD);

    for (const h of w.holes) {
      if (h.style === "storefront") {
        addStorefrontFrame(frameParts, m, len, h);
        // Glazing: one pane spanning the bay, inset so the mullions stand proud.
        const base = h.sillM + 0.14;
        localBox(
          glassParts,
          m,
          len,
          h.atM - h.widthM / 2 + MULLION_W,
          h.atM + h.widthM / 2 - MULLION_W,
          base,
          h.headM - 0.1,
          0.012,
        );
        // Signage band on the header, lettered with the tenant, facing the
        // concourse (h.outward). Skipped when the header is too shallow to carry
        // a band — better no sign than one clipping through the ceiling.
        const bandBottom = h.headM + 0.06;
        if (h.label && w.topM - bandBottom >= SIGN_BAND_H) {
          const r = atlas.rectFor(h.label);
          if (r) {
            const signW = h.widthM * 0.9;
            const q = new THREE.PlaneGeometry(signW, SIGN_BAND_H);
            const uv = q.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
              uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
            }
            uv.needsUpdate = true;
            // A PlaneGeometry faces +Z; rotate 180° about Y when the concourse is
            // on the −Z side so the lettering is never mirrored.
            if (h.outward < 0) q.rotateY(Math.PI);
            q.translate(
              h.atM - len / 2,
              bandBottom + SIGN_BAND_H / 2,
              h.outward * (WALL_THICKNESS_M / 2 + 0.03),
            );
            q.applyMatrix4(m);
            signParts.push(q);
          }
        }
      } else if (h.style === "door" || h.style === "double") {
        addLining(frameParts, m, len, h);
        addLeaves(leafParts, m, len, h);
      } else {
        // "opening" / "gate": a cased reveal, no leaf — you walk straight through.
        addLining(frameParts, m, len, h);
      }
    }
  }

  // ---- instanced hole-free walls --------------------------------------------
  for (const [finish, segs] of plainByFinish) {
    const proto = new THREE.BoxGeometry(1, 1, WALL_THICKNESS_M);
    const mesh = new THREE.InstancedMesh(proto, materialForWallFinish(finish), segs.length);
    // Baseboard + cornice for the whole finish bucket, both instanced against the
    // same per-segment transform.
    const baseProto = new THREE.BoxGeometry(1, 1, WALL_THICKNESS_M + TRIM_PROUD);
    const trim = new THREE.InstancedMesh(baseProto, getTrimMaterial(), segs.length * 2);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let n = 0;
    let t = 0;
    for (const s of segs) {
      const dx = s.b[0] - s.a[0];
      const dy = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const cx = (s.a[0] + s.b[0]) / 2;
      const cy = (s.a[1] + s.b[1]) / 2;
      q.setFromAxisAngle(UP, Math.atan2(dy, dx));
      m4.compose(new THREE.Vector3(cx, s.topM / 2, -cy), q, new THREE.Vector3(len, s.topM, 1));
      mesh.setMatrixAt(n++, m4);
      m4.compose(new THREE.Vector3(cx, BASEBOARD_H / 2, -cy), q, new THREE.Vector3(len, BASEBOARD_H, 1));
      trim.setMatrixAt(t++, m4);
      m4.compose(
        new THREE.Vector3(cx, s.topM - CORNICE_H / 2, -cy),
        q,
        new THREE.Vector3(len, CORNICE_H, 1),
      );
      trim.setMatrixAt(t++, m4);
    }
    mesh.count = n;
    trim.count = t;
    mesh.instanceMatrix.needsUpdate = true;
    trim.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    trim.castShadow = false;
    trim.receiveShadow = true;
    out.push(mesh, trim);
  }

  // ---- merged holed walls + furniture ---------------------------------------
  for (const [finish, parts] of holedByFinish) {
    emitMerged(parts, materialForWallFinish(finish), out);
  }
  emitMerged(trimParts, getTrimMaterial(), out, { cast: false });
  emitMerged(frameParts, getFrameMaterial(), out);
  emitMerged(leafParts, getLeafMaterial(), out);
  // Glazing never casts: a shadow-casting transparent pane would darken the very
  // interior the shopfront exists to reveal.
  emitMerged(glassParts, getMaterial("glass"), out, { cast: false, receive: false });

  let signTexture: THREE.CanvasTexture | null = null;
  if (signParts.length > 0 && atlas.used) {
    signTexture = atlas.texture();
    const signMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      emissive: 0xffffff,
      emissiveMap: signTexture,
      emissiveIntensity: 2.4,
      map: signTexture,
      transparent: true,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    emitMerged(signParts, signMat, out, { cast: false, receive: false });
  }

  return { meshes: out, signTexture };
}

/** Dispose the shared trim/frame/leaf materials. Call ONCE from the renderer's
 *  dispose(), alongside the other module-level dispose functions. The sign
 *  texture is NOT freed here — it is per-rebuild and travels with the world
 *  group's teardown. */
export function disposeArchitecture(): void {
  trimMat?.dispose();
  trimMat = null;
  frameMat?.dispose();
  frameMat = null;
  leafMat?.dispose();
  leafMat = null;
}
