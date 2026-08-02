// Procedural PBR material + texture library for the walk editor (R1 of the 3D
// realism pass, docs/3d-realism-spec.md). three.js is imported here ONLY — this
// module lives inside src/editor3d/ so the bundle boundary stays grep-auditable
// and the single-file viewer never pulls it in.
//
// Everything is generated from code: canvas-2D + deterministic value noise →
// CanvasTexture, one build per material family, shared + cached. No image
// fetches, no glTF, no CDN — the offline/single-file guarantee holds and the
// bundle stays small (decision "Procedural textures, not images", the spec).
//
// Sharing contract: getMaterial(name) builds a MeshStandardMaterial on first use
// and returns the SAME instance forever after. Every cached material is tagged
// `userData.shared = true` so the renderer's clearGroup teardown (which disposes
// each world mesh's geometry+material on every rebuild) knows to dispose the
// per-rebuild GEOMETRY but skip these shared materials/textures. They are freed
// exactly once, in disposeMaterials(), called from the renderer's dispose().

import * as THREE from "three";
import type { Category } from "../types";

export type MaterialName =
  | "carpet"
  | "felt"
  | "woodFloor"
  | "woodPanel"
  | "marble"
  | "tile"
  | "concrete"
  | "wallPaint"
  | "ceilingTile"
  | "brushedMetal"
  | "glass"
  | "darkGlass";

// ---- deterministic value noise ---------------------------------------------
// Hash-based (never Math.random) so every texture is reproducible/cacheable.
// Math.imul keeps the mixing in exact 32-bit integer space.

function hash2i(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 0x1f1f1f1f) ^ Math.imul(iy | 0, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Tileable lattice hash: wrap integer coords to [0,period) so noise sampled over
// a [0,period) domain wraps seamlessly — no visible seam where a texture repeats.
function hash2iTiled(ix: number, iy: number, period: number): number {
  const wx = ((ix % period) + period) % period;
  const wy = ((iy % period) + period) % period;
  return hash2i(wx, wy);
}

const fade = (t: number): number => t * t * (3 - 2 * t); // smoothstep

function valueNoiseTiled(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const n00 = hash2iTiled(xi, yi, period);
  const n10 = hash2iTiled(xi + 1, yi, period);
  const n01 = hash2iTiled(xi, yi + 1, period);
  const n11 = hash2iTiled(xi + 1, yi + 1, period);
  const nx0 = n00 * (1 - u) + n10 * u;
  const nx1 = n01 * (1 - u) + n11 * u;
  return nx0 * (1 - v) + nx1 * v;
}

/** Tileable fractional-Brownian-motion: a few octaves of value noise. `x`,`y`
 *  are in units of `period` lattice cells; each octave doubles frequency AND
 *  wrap-period, so the result tiles seamlessly across [0,period). Returns ~[0,1). */
function fbmTiled(x: number, y: number, period: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoiseTiled(x * freq, y * freq, period * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---- canvas + pixel helpers -------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeCanvas(size: number): Canvas2D {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  return { canvas, ctx };
}

type Rgb = [number, number, number];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Paint an albedo canvas from a per-pixel shader returning [r,g,b] in 0..255. */
function paint(size: number, shade: (px: number, py: number, u: number, v: number) => Rgb): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const c = shade(px, py, px / size, py / size);
      const o = (py * size + px) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Grayscale (roughness) canvas from a per-pixel value in 0..1. */
function grayMap(size: number, val: (px: number, py: number) => number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const g = clamp01(val(px, py)) * 255;
      const o = (py * size + px) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Tangent-space normal map from a tileable height field (wraps at edges so the
 *  normal map tiles). `strength` scales the slope. */
function normalMapFromHeight(
  size: number,
  height: (px: number, py: number) => number,
  strength: number,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const wrap = (n: number): number => ((n % size) + size) % size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const hL = height(wrap(px - 1), py);
      const hR = height(wrap(px + 1), py);
      const hD = height(px, wrap(py - 1));
      const hU = height(px, wrap(py + 1));
      let nx = (hL - hR) * strength;
      let ny = (hD - hU) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const o = (py * size + px) * 4;
      img.data[o] = (nx * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz / len) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---- material specs ---------------------------------------------------------
// Each family returns canvases + PBR params. `repeat` is the THREE texture.repeat
// value. Floors/prisms/ceiling/ground carry metre-scale UVs (ShapeGeometry /
// ExtrudeGeometry emit UVs equal to the metre coordinates; the ground plane's
// UVs are rescaled to metres in the renderer), so repeat = 1/tileMetres. Walls
// and baseboards use unit (0..1) box UVs, so those families (wallPaint, woodPanel)
// use an absolute repeat instead.

interface MatSpec {
  map: HTMLCanvasElement;
  normal?: HTMLCanvasElement;
  roughnessMap?: HTMLCanvasElement;
  color?: number;
  roughness: number;
  metalness: number;
  normalScale?: number;
  repeat: number;
  side?: THREE.Side;
  emissive?: number;
}

const BUILDERS: Record<MaterialName, () => MatSpec> = {
  // Patterned casino carpet: a two-tone diamond lattice + fine grain.
  // Lifted out of near-black (was 26,22,30): that value was chosen when the whole
  // world was dimmed for the camera-primary look, and under a properly lit ceiling
  // it inverted the natural contrast of a room — a bright soffit over a floor that
  // read as a hole. Still the darkest surface in the venue, just not a void.
  carpet: () => {
    const S = 512;
    const base: Rgb = [58, 40, 40];
    const accent: Rgb = [92, 66, 50];
    const map = paint(S, (_px, _py, u, v) => {
      const grain = fbmTiled(u * 24, v * 24, 24, 4);
      const lattice = Math.abs(Math.sin(u * Math.PI * 4) * Math.sin(v * Math.PI * 4));
      const motif = fade(clamp01((lattice - 0.35) / 0.5));
      const c = mix(base, accent, motif * 0.55);
      const s = 0.82 + grain * 0.32;
      return [c[0] * s, c[1] * s, c[2] * s];
    });
    return { map, color: 0xffffff, roughness: 0.97, metalness: 0, repeat: 1 / 3 };
  },

  // Even green baize (table felt) — fine even nap. Exposed now for R2 tables.
  felt: () => {
    const S = 256;
    const base: Rgb = [28, 92, 56];
    const map = paint(S, (_px, _py, u, v) => {
      const n = fbmTiled(u * 40, v * 40, 40, 3);
      const s = 0.86 + n * 0.24;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    return { map, color: 0xffffff, roughness: 0.9, metalness: 0, repeat: 1 / 1.5 };
  },

  // Warm plank floor for bar / F&B. Planks run along U; darker seams between them
  // are cut into a height field so a normal map gives the grooves relief.
  woodFloor: () => {
    const S = 512;
    const planks = 6;
    const dark: Rgb = [70, 45, 26];
    const light: Rgb = [120, 82, 48];
    const seam = 0.035;
    const heightAt = (px: number, py: number): number => {
      const v = py / S;
      const fy = (v * planks) % 1;
      const inSeam = fy < seam || fy > 1 - seam;
      const grain = fbmTiled((px / S) * 60, Math.floor(v * planks) * 3.3, 60, 3);
      return inSeam ? 0.15 : 0.7 + grain * 0.25;
    };
    const map = paint(S, (_px, _py, u, v) => {
      const pi = Math.floor(v * planks);
      const fy = (v * planks) % 1;
      const inSeam = fy < seam || fy > 1 - seam;
      const tint = 0.75 + hash2i(pi, 7) * 0.5;
      const grain = fbmTiled(u * 60, pi * 3.3, 60, 3);
      const c = mix(dark, light, clamp01(grain));
      const s = (inSeam ? 0.35 : 1) * tint;
      return [c[0] * s, c[1] * s, c[2] * s];
    });
    const normal = normalMapFromHeight(S, heightAt, 2.2);
    return { map, normal, color: 0xffffff, roughness: 0.55, metalness: 0, normalScale: 0.7, repeat: 1 / 2 };
  },

  // Warm wall panel / baseboard trim — subtly darker than the floor wood, faint
  // vertical seams. Used on unit-UV baseboards so repeat is absolute.
  woodPanel: () => {
    const S = 256;
    const dark: Rgb = [40, 27, 17];
    const light: Rgb = [72, 50, 30];
    const map = paint(S, (_px, _py, u, v) => {
      const grain = fbmTiled(v * 40, u * 6, 40, 3);
      const seam = Math.abs(((u * 3) % 1) - 0.5) > 0.47 ? 0.6 : 1;
      const c = mix(dark, light, clamp01(grain));
      const s = 0.8 + grain * 0.25;
      return [c[0] * s * seam, c[1] * s * seam, c[2] * s * seam];
    });
    return { map, color: 0xffffff, roughness: 0.6, metalness: 0.05, repeat: 1 };
  },

  // Veined polished marble for lobby floors. Turbulent domain-warped veining;
  // veins read slightly rougher than the polished base via a roughness map.
  marble: () => {
    const S = 512;
    const base: Rgb = [206, 204, 200];
    const veinCol: Rgb = [120, 122, 132];
    const veinAt = (u: number, v: number): number => {
      const t = fbmTiled(u * 3, v * 3, 3, 5);
      const s = Math.abs(Math.sin((u * 3 + t * 4) * Math.PI));
      return Math.pow(1 - clamp01(s), 6); // 1 at a vein, 0 elsewhere
    };
    const map = paint(S, (_px, _py, u, v) => {
      const vein = veinAt(u, v);
      const mottle = 0.94 + fbmTiled(u * 8, v * 8, 8, 3) * 0.1;
      const c = mix(base, veinCol, vein);
      return [c[0] * mottle, c[1] * mottle, c[2] * mottle];
    });
    const roughnessMap = grayMap(S, (px, py) => 0.12 + veinAt(px / S, py / S) * 0.35);
    return { map, roughnessMap, color: 0xffffff, roughness: 0.18, metalness: 0.1, repeat: 1 / 4 };
  },

  // Grid tile with recessed grout, for restrooms. Grout is darker + rougher + cut
  // into the height field for grooves.
  tile: () => {
    const S = 512;
    const n = 4; // tiles across the texture
    const gw = 0.045; // grout half-width (in tile-fraction)
    const tileBase: Rgb = [188, 192, 196];
    const grout: Rgb = [96, 98, 100];
    const groutMask = (u: number, v: number): boolean => {
      const gx = (u * n) % 1;
      const gy = (v * n) % 1;
      return gx < gw || gx > 1 - gw || gy < gw || gy > 1 - gw;
    };
    const map = paint(S, (_px, _py, u, v) => {
      const ti = Math.floor(u * n) + Math.floor(v * n) * n;
      const speck = fbmTiled(u * 30, v * 30, 30, 2);
      if (groutMask(u, v)) {
        const s = 0.9 + speck * 0.15;
        return [grout[0] * s, grout[1] * s, grout[2] * s];
      }
      const tint = 0.92 + hash2i(ti, 3) * 0.12;
      const s = tint * (0.96 + speck * 0.08);
      return [tileBase[0] * s, tileBase[1] * s, tileBase[2] * s];
    });
    const normal = normalMapFromHeight(S, (px, py) => (groutMask(px / S, py / S) ? 0.1 : 0.85), 2.6);
    const roughnessMap = grayMap(S, (px, py) => (groutMask(px / S, py / S) ? 0.85 : 0.22));
    return { map, normal, roughnessMap, color: 0xffffff, roughness: 0.3, metalness: 0, normalScale: 0.6, repeat: 1 / 1.2 };
  },

  // Troweled concrete for BOH / slabs / ground. Broad low-contrast mottle with a
  // faint normal so raking light catches the surface.
  concrete: () => {
    const S = 512;
    const base: Rgb = [86, 88, 92];
    const heightAt = (px: number, py: number): number =>
      fbmTiled((px / S) * 6, (py / S) * 6, 6, 5) * 0.7 + fbmTiled((px / S) * 22, (py / S) * 22, 22, 2) * 0.3;
    const map = paint(S, (px, py) => {
      const h = heightAt(px, py);
      const blot = fbmTiled((px / S) * 3, (py / S) * 3, 3, 3);
      const s = 0.78 + h * 0.34 - Math.pow(clamp01(blot - 0.6) / 0.4, 2) * 0.12;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    const normal = normalMapFromHeight(S, heightAt, 1.1);
    return { map, normal, color: 0xffffff, roughness: 0.92, metalness: 0, normalScale: 0.35, repeat: 1 / 4 };
  },

  // Near-flat interior wall paint — a faint roughness/tone variation only. Used
  // on unit-UV wall boxes, so repeat is absolute and low-frequency.
  wallPaint: () => {
    const S = 256;
    const base: Rgb = [150, 148, 142];
    const map = paint(S, (_px, _py, u, v) => {
      const n = fbmTiled(u * 5, v * 5, 5, 3);
      const s = 0.95 + n * 0.08;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    const roughnessMap = grayMap(S, (px, py) => 0.85 + fbmTiled((px / S) * 5, (py / S) * 5, 5, 2) * 0.1);
    return { map, roughnessMap, color: 0xffffff, roughness: 0.9, metalness: 0, repeat: 1.6 };
  },

  // Acoustic ceiling tile grid — off-white speckled squares with a faint grout
  // grid. Seen from below; DoubleSide so the underside always draws.
  ceilingTile: () => {
    const S = 512;
    const n = 4;
    const base: Rgb = [200, 200, 194];
    const line: Rgb = [150, 150, 146];
    const map = paint(S, (_px, _py, u, v) => {
      const gx = (u * n) % 1;
      const gy = (v * n) % 1;
      const grid = gx < 0.02 || gx > 0.98 || gy < 0.02 || gy > 0.98;
      const speck = fbmTiled(u * 60, v * 60, 60, 2);
      const c = grid ? line : base;
      const s = 0.92 + speck * 0.16;
      return [c[0] * s, c[1] * s, c[2] * s];
    });
    return { map, color: 0xffffff, roughness: 0.95, metalness: 0, repeat: 1 / 2.4, side: THREE.DoubleSide };
  },

  // Brushed metal for fixtures/trim — horizontal streaks give an anisotropic-ish
  // read via a streaked roughness map. Exposed for R2 fixture models too.
  brushedMetal: () => {
    const S = 256;
    const base: Rgb = [150, 152, 158];
    const streak = (u: number, v: number): number => fbmTiled(u * 120, v * 6, 120, 3);
    const map = paint(S, (_px, _py, u, v) => {
      const s = 0.82 + streak(u, v) * 0.34;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    const roughnessMap = grayMap(S, (px, py) => 0.32 + streak(px / S, py / S) * 0.3);
    return { map, roughnessMap, color: 0xffffff, roughness: 0.45, metalness: 0.85, repeat: 1 };
  },

  // Clear architectural glazing for shopfronts and vision panels. Nearly
  // colourless and very smooth, so almost all of its read comes from the
  // environment map's reflection — which is exactly why it only started looking
  // like glass once env.ts existed. Transparency is set on the material (below),
  // not in the texture, so the pane still takes a specular highlight.
  glass: () => {
    const S = 128;
    const base: Rgb = [176, 190, 196];
    const map = paint(S, (_px, _py, u, v) => {
      // Very faint large-scale unevenness — real float glass is not perfectly flat,
      // and a dead-flat pane reads as a hole rather than as glazing.
      const n = fbmTiled(u * 3, v * 3, 3, 2);
      const s = 0.97 + n * 0.06;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    return { map, color: 0xffffff, roughness: 0.05, metalness: 0, repeat: 1 / 3 };
  },

  // Smoked dark glass — for later dome caps / screens. Near-black, low roughness,
  // partly metallic so it reflects. Exposed now, unused in R1.
  darkGlass: () => {
    const S = 256;
    const base: Rgb = [12, 14, 18];
    const map = paint(S, (_px, _py, u, v) => {
      const n = fbmTiled(u * 10, v * 10, 10, 3);
      const s = 0.7 + n * 0.6;
      return [base[0] * s, base[1] * s, base[2] * s];
    });
    return { map, color: 0xffffff, roughness: 0.12, metalness: 0.4, repeat: 1 };
  },
};

// ---- texture + material build/cache ----------------------------------------

function toTexture(canvas: HTMLCanvasElement, srgb: boolean, repeat: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function buildMaterial(name: MaterialName): THREE.MeshStandardMaterial {
  const s = BUILDERS[name]();
  const isGlass = name === "glass";
  const mat = new THREE.MeshStandardMaterial({
    color: s.color ?? 0xffffff,
    // Glazing is drawn from both sides (you see a shopfront from the concourse and
    // from inside the shop), never writes depth (so what's behind it still draws),
    // and never casts — a shadow-casting transparent pane would darken the very
    // interior it's meant to reveal.
    transparent: isGlass,
    opacity: isGlass ? 0.22 : 1,
    depthWrite: !isGlass,
    map: toTexture(s.map, true, s.repeat),
    normalMap: s.normal ? toTexture(s.normal, false, s.repeat) : null,
    roughnessMap: s.roughnessMap ? toTexture(s.roughnessMap, false, s.repeat) : null,
    roughness: s.roughness,
    metalness: s.metalness,
    side: s.side ?? (isGlass ? THREE.DoubleSide : THREE.FrontSide),
    emissive: new THREE.Color(s.emissive ?? 0x000000),
  });
  if (mat.normalMap && s.normalScale != null) mat.normalScale.set(s.normalScale, s.normalScale);
  // Tag as shared so the renderer's per-rebuild geometry teardown skips it (only
  // disposeMaterials() ever frees these).
  mat.userData.shared = true;
  return mat;
}

const cache = new Map<MaterialName, THREE.MeshStandardMaterial>();

/** The shared, cached MeshStandardMaterial for a material family. Built (with its
 *  textures) on first use; every later call returns the same instance, so a scene
 *  rebuild reuses materials and never rebuilds textures. */
export function getMaterial(name: MaterialName): THREE.MeshStandardMaterial {
  let m = cache.get(name);
  if (!m) {
    m = buildMaterial(name);
    cache.set(name, m);
  }
  return m;
}

// Category → material family. Category is the reliable key; an optional unit id
// lets the casino demo's id-prefix buckets (all category "room") split into
// gaming-carpet / F&B-wood / BOH-concrete, matching the 2D functionBucket read.
const CATEGORY_MATERIAL: Record<Category, MaterialName> = {
  room: "carpet",
  corridor: "carpet",
  office: "carpet",
  retail: "woodFloor",
  lobby: "marble",
  restroom: "tile",
  storage: "concrete",
  mechanical: "concrete",
  elevator: "concrete",
  stairs: "concrete",
  outside: "concrete",
};

function idBucketMaterial(id: string): MaterialName | null {
  if (id.startsWith("food-") || id.startsWith("bar-")) return "woodFloor";
  if (id.startsWith("boh-") || id.startsWith("cage-")) return "concrete";
  if (id.startsWith("pit-") || id.startsWith("poker-") || id.startsWith("hilimit-")) return "carpet";
  return null;
}

/** Material family name for a floor category, refined by unit id-prefix bucket
 *  when one is recognised (Category still wins as the fallback). */
export function materialNameForCategory(category: Category, id?: string): MaterialName {
  const byId = id ? idBucketMaterial(id) : null;
  return byId ?? CATEGORY_MATERIAL[category] ?? "carpet";
}

/** Shared material for a floor category (see materialNameForCategory). */
export function materialForCategory(category: Category, id?: string): THREE.MeshStandardMaterial {
  return getMaterial(materialNameForCategory(category, id));
}

// Wall finish → material family. Distinct from the FLOOR table above: a restroom
// has a tiled floor AND tiled walls, but a storage room's concrete floor sits
// under painted block, and the building envelope is concrete on both. A single
// wallPaint everywhere was one of the reasons every space read the same.
const FINISH_MATERIAL: Record<string, MaterialName> = {
  envelope: "concrete",
  restroom: "tile",
  storage: "concrete",
  mechanical: "concrete",
  stairs: "concrete",
  elevator: "brushedMetal",
  retail: "wallPaint",
  lobby: "marble",
  room: "wallPaint",
  office: "wallPaint",
  corridor: "wallPaint",
  outside: "concrete",
};

/** Shared material for a wall finish key (SceneWall.finish — a unit Category, or
 *  "envelope" for the building outline). */
export function materialForWallFinish(finish: string): THREE.MeshStandardMaterial {
  return getMaterial(FINISH_MATERIAL[finish] ?? "wallPaint");
}

// ---- emissive (signage / neon) materials -----------------------------------
// Textureless self-lit materials for R3 neon valances / glow strips. Cached by
// colour+intensity so the whole signage pass is a handful of shared materials
// (one per neon colour), each drawn on a merged strip mesh. Tagged shared so the
// renderer's per-rebuild teardown skips them; freed once in disposeMaterials().
// The renderer scales `emissiveIntensity` for the camera-primary world-recede and
// restores it from a stored base — mutating the level, not the cache key, so
// lookups stay stable.

const emissiveCache = new Map<string, THREE.MeshStandardMaterial>();

/** Shared emissive material for a signage/neon accent, cached by colour+level.
 *  Black base colour (unlit it reads dark), the colour lives on `emissive`. Kept
 *  modest so neon never outshines the green coverage cones (camera-primary). */
export function getEmissiveMaterial(color: number, intensity: number): THREE.MeshStandardMaterial {
  const key = `${color}:${intensity}`;
  let m = emissiveCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 1,
      metalness: 0,
    });
    m.userData.shared = true;
    emissiveCache.set(key, m);
  }
  return m;
}

/** Dispose every cached material and its textures. Call ONCE from the renderer's
 *  dispose() — never per rebuild (clearGroup skips shared materials by design). */
export function disposeMaterials(): void {
  for (const m of cache.values()) {
    m.map?.dispose();
    m.normalMap?.dispose();
    m.roughnessMap?.dispose();
    m.emissiveMap?.dispose();
    m.dispose();
  }
  cache.clear();
  for (const m of emissiveCache.values()) m.dispose();
  emissiveCache.clear();
}
