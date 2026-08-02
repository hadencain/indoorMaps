// Procedural indoor environment map for the walk editor (Phase A of the AAA venue
// render pass, docs/superpowers/plans/2026-08-01-aaa-venue-render.md).
//
// WHY THIS EXISTS: before this module the scene had NO environment map at all
// (`grep envMap` returned nothing). A MeshStandardMaterial with no environment
// reflects pure black in its specular lobe, so every metal, every glass pane and
// every polished stone surface in the venue rendered as dead plastic no matter how
// good its albedo/roughness maps were. Image-based lighting is the single largest
// material-quality win available, and it costs one PMREM build at startup.
//
// It is GENERATED, never fetched: a float32 equirectangular radiance map painted in
// code, run through THREE.PMREMGenerator. That keeps the offline / no-network /
// single-file guarantee (no .hdr, no CDN, no RGBELoader) while still giving genuine
// HDR values — the luminaire cells are painted well above 1.0 so they produce real
// specular highlights, which an LDR canvas texture (capped at 1.0) cannot do.
//
// The map describes a GENERIC LIT INTERIOR, not any specific venue: a bright
// luminaire-studded ceiling, a mid-value wall band with lighter backlit panels, and
// a darker floor. That's the correct ambient for every property here — the venue's
// own character comes from its geometry, materials and light rig, while this
// supplies the "what is around me" term those all reflect.

import * as THREE from "three";

/** Equirect source resolution. 256×128 is ample: PMREM immediately convolves this
 *  into roughness mips, so extra source detail is blurred away. Keeps the float
 *  buffer at 256·128·4·4 ≈ 512 KB and the build well under a frame. */
const EQ_W = 256;
const EQ_H = 128;

// Radiance values are LINEAR and deliberately exceed 1.0 for emitters — that is the
// entire point of using a float texture over a canvas.
const CEIL_BASE: Rgb = [0.62, 0.63, 0.68]; // lit ceiling plane between fittings
const LUMINAIRE: Rgb = [7.4, 7.1, 6.4]; // the fittings themselves (HDR)
const WALL_UPPER: Rgb = [0.4, 0.39, 0.38];
const WALL_LOWER: Rgb = [0.22, 0.21, 0.21];
const WALL_PANEL: Rgb = [1.5, 1.42, 1.24]; // backlit signage / storefront band
const FLOOR_NEAR: Rgb = [0.1, 0.098, 0.1];
const FLOOR_FAR: Rgb = [0.16, 0.155, 0.155];

type Rgb = [number, number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Deterministic hash noise — never Math.random, so the map is reproducible and the
 *  same every session (a reflection that shifts between reloads reads as a bug). */
function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 0x1f1f1f1f) ^ Math.imul(iy | 0, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Paint the equirectangular radiance buffer.
 *
 * u ∈ [0,1) is azimuth, v ∈ [0,1) is polar angle with v=0 at the ZENITH (straight
 * up) — the standard equirect convention THREE.EquirectangularReflectionMapping
 * expects, so "the bright band belongs at low v" means the ceiling really does end
 * up overhead rather than underfoot.
 */
function paintEquirect(): Float32Array {
  const data = new Float32Array(EQ_W * EQ_H * 4);
  for (let y = 0; y < EQ_H; y++) {
    const v = (y + 0.5) / EQ_H;
    for (let x = 0; x < EQ_W; x++) {
      const u = (x + 0.5) / EQ_W;
      let c: Rgb;

      if (v < 0.34) {
        // ---- ceiling: base plane with a grid of rectangular luminaires ---------
        // A coarse cell grid; cells whose hash passes the threshold are fittings.
        // Sampled against a soft-edged inset rect so PMREM gets a shape with real
        // extent (a single hot texel would convolve away to nothing).
        const cx = u * 14;
        const cy = v * 5;
        const gi = Math.floor(cx);
        const gj = Math.floor(cy);
        const fx = cx - gi;
        const fy = cy - gj;
        const lit = hash2(gi, gj) > 0.42;
        const inset =
          smooth((fx - 0.16) / 0.14) *
          smooth((0.84 - fx) / 0.14) *
          smooth((fy - 0.2) / 0.16) *
          smooth((0.8 - fy) / 0.16);
        const k = lit ? inset : 0;
        c = mix(CEIL_BASE, LUMINAIRE, k);
        // Fade the ceiling into the wall across the last slice so PMREM's low mips
        // don't band at the seam.
        c = mix(c, WALL_UPPER, smooth((v - 0.28) / 0.06));
      } else if (v < 0.66) {
        // ---- wall band: vertical gradient + periodic backlit panels ------------
        const t = (v - 0.34) / 0.32;
        c = mix(WALL_UPPER, WALL_LOWER, smooth(t));
        // Backlit storefront/signage band sitting in the upper third of the wall.
        const band = smooth((t - 0.1) / 0.1) * smooth((0.42 - t) / 0.12);
        const bay = Math.abs(((u * 9) % 1) - 0.5); // 9 bays around the horizon
        const panel = band * smooth((0.34 - bay) / 0.1);
        c = mix(c, WALL_PANEL, panel * (0.5 + hash2(Math.floor(u * 9), 3) * 0.5));
        // Break the perfect verticals so reflections aren't obviously synthetic.
        const n = 0.94 + hash2(Math.floor(u * 40), Math.floor(v * 40)) * 0.12;
        c = [c[0] * n, c[1] * n, c[2] * n];
      } else {
        // ---- floor: darker, slightly brighter at the horizon -------------------
        const t = (v - 0.66) / 0.34;
        c = mix(FLOOR_FAR, FLOOR_NEAR, smooth(t));
        c = mix(WALL_LOWER, c, smooth(t / 0.12)); // soften the horizon seam
      }

      const o = (y * EQ_W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 1;
    }
  }
  return data;
}

let cached: THREE.Texture | null = null;

/**
 * The shared, cached PMREM environment texture. Built on first call (one equirect
 * paint + one PMREM convolution, a few ms) and returned identically thereafter, so
 * every floor rebuild and every renderer reuses it.
 *
 * Assign to `scene.environment`. Do NOT assign to `scene.background`: this is an
 * interior, and showing the map behind the geometry would read as a photographic
 * backdrop pasted outside the walls. Exterior context is Phase E's job.
 */
export function getEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (cached) return cached;
  const src = new THREE.DataTexture(paintEquirect(), EQ_W, EQ_H, THREE.RGBAFormat, THREE.FloatType);
  src.mapping = THREE.EquirectangularReflectionMapping;
  src.colorSpace = THREE.NoColorSpace; // already linear radiance, never sRGB-decode
  src.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(src);
  // The equirect source and the generator are both consumed by the convolution —
  // only the resulting cube-UV render target's texture is kept.
  src.dispose();
  pmrem.dispose();
  cached = target.texture;
  cached.userData.shared = true;
  return cached;
}

// ---- exterior sky ------------------------------------------------------------
// Separate from the environment map above, and for a different job. The IBL is
// what surfaces REFLECT; this is what the player SEES through a shopfront, an
// entrance or a gate. Before it, `scene.background` was a flat fog-coloured fill,
// so every opening in the building envelope looked out onto dead grey — which
// made the exterior read as a void rather than as outside.

let skyCached: THREE.Texture | null = null;

/** A vertical sky gradient as an equirect texture: deep zenith blue, pale band at
 *  the horizon, dull ground below it. Painted rather than shaded so it costs one
 *  small texture and no per-frame work. */
export function getSky(): THREE.Texture {
  if (skyCached) return skyCached;
  const W = 8; // horizontally uniform — one column would stretch, eight is plenty
  const H = 128;
  const data = new Uint8Array(W * H * 4);
  const zenith: Rgb = [58, 92, 148];
  const horizon: Rgb = [176, 196, 214];
  const ground: Rgb = [64, 62, 58];
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1); // 0 = zenith
    let c: Rgb;
    if (v < 0.5) {
      // Bias the blend toward the horizon so the pale band is tight, the way a
      // real sky reads, rather than a linear wash from top to bottom.
      c = mix(zenith, horizon, smooth(Math.pow(v / 0.5, 2.2)));
    } else {
      c = mix(horizon, ground, smooth(Math.min(1, (v - 0.5) / 0.06)));
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  t.userData.shared = true;
  skyCached = t;
  return t;
}

/** Free the cached environment. Call ONCE from the renderer's dispose(), alongside
 *  disposeMaterials() / disposeFixtureModels(). */
export function disposeEnvironment(): void {
  cached?.dispose();
  cached = null;
  skyCached?.dispose();
  skyCached = null;
}
