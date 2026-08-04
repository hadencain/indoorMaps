// Post-processing for the walk renderer's High / Cinematic paths. Lives in
// src/editor3d/ with the rest of the three.js code (bundle boundary is
// grep-auditable; the single-file viewer never imports this).
//
// WHY THERE IS AN AO PASS NOW: the render read as flat-shaded no matter how good
// the materials and light rig got, and the reason was that NOTHING grounded.
// Every surface met every other surface at a uniformly lit seam — no darkening in
// a corner, under a counter, behind a mullion, where a column meets the floor.
// Ambient occlusion is the single largest "this is CG" tell, and it was the one
// item the original realism spec called for (R1: "SSAO — contact shadows/AO the
// procedural lighting can't fake") and never shipped. Bloom went in instead, which
// makes bright things brighter and does nothing for the problem.
//
// Pass order + tone mapping (do NOT double tone-map):
//   RenderPass  → renders into the composer's HalfFloat target. Because that's a
//                 render target, three applies NEITHER tone mapping NOR sRGB — the
//                 scene stays LINEAR HDR, which is what both later passes need.
//   GTAOPass    → renders its own depth+normal prepass and multiplies ground-truth
//                 ambient occlusion into the beauty. Must come BEFORE bloom, or the
//                 bloom halo gets darkened by AO instead of the surfaces being
//                 darkened before they bloom.
//   UnrealBloomPass → extracts + blurs real highlights in linear HDR.
//   OutputPass  → applies the renderer's ACESFilmicToneMapping + sRGB. The ONLY
//                 tone-map in the chain.
//   GradePass   → LAST. Black point, contrast, saturation and vignette on the
//                 tone-mapped sRGB image (see GradeShader).

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

// Bloom tuning — only genuinely bright things bloom (emissive fittings, signage,
// screens, the coverage-lit floor), NOT the whole scene.
export const BLOOM_THRESHOLD = 0.95;
export const BLOOM_STRENGTH = 0.28;
export const BLOOM_RADIUS = 0.5;

// AO tuning. `radius` is in WORLD METRES and is the parameter that matters most.
// A first pass at 0.55 m — reasoning from skirting boards and table legs — produced
// an almost pure-white AO buffer: at venue scale, where a gaming hall is 60 m across
// and the camera routinely sees 40 m down a concourse, sub-metre occlusion covers a
// fraction of a pixel and denoises away to nothing. These are ROOMS; the occlusion
// that reads is the metre-scale kind — under a slot bank, along a wall base, in the
// pocket where a column meets the floor.
export const AO_RADIUS_M = 2.2;
export const AO_DISTANCE_EXPONENT = 1.0;
export const AO_THICKNESS = 1.0;
export const AO_SCALE = 1.6;
export const AO_SAMPLES = 16;
/** How hard the AO is multiplied in. Below 1 keeps corners believable rather than
 *  sooty — real interiors have bounce light filling their corners, which a
 *  screen-space pass cannot know about, so a full-strength multiply always
 *  over-darkens. */
export const AO_BLEND = 0.85;


// ---- final grade -------------------------------------------------------------
// Runs AFTER OutputPass, i.e. on tone-mapped sRGB pixels, which is where a grade
// belongs: contrast applied in linear HDR fights the tone curve instead of
// shaping it.
//
// WHY: even with AO and cast shadows the image sat milky — everything bunched in
// the midtones, nothing approaching black, and a flat falloff to the frame edge.
// ACES alone does not give a photograph's tonal range; a photograph has a black
// point, a shoulder, and darker corners because real lenses vignette.
//
// Deliberately mild. This is a corrective grade, not a look: crushing it further
// would hide the geometry and lighting work underneath, which is the actual
// subject.
const GRADE_CONTRAST = 1.14;
const GRADE_SATURATION = 1.07;
const GRADE_VIGNETTE = 0.34;
const GRADE_BLACK_POINT = 0.012;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    contrast: { value: GRADE_CONTRAST },
    saturation: { value: GRADE_SATURATION },
    vignette: { value: GRADE_VIGNETTE },
    blackPoint: { value: GRADE_BLACK_POINT },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    uniform float blackPoint;
    varying vec2 vUv;

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;

      // Black point: remap so the darkest values reach true black instead of
      // floating at the fog/ambient floor, then contrast about mid grey.
      c = max(c - blackPoint, 0.0) / (1.0 - blackPoint);
      c = (c - 0.5) * contrast + 0.5;

      // Saturation about Rec.709 luma.
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, saturation);

      // Vignette: smooth radial falloff from the frame centre, in UV space so it
      // follows the aspect the user is actually looking at.
      vec2 d = vUv - 0.5;
      float r = dot(d, d);
      c *= 1.0 - vignette * smoothstep(0.12, 0.62, r);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }
  `,
};

/** Owns the composer chain bound to one renderer/scene/camera. `render()` draws
 *  the composed frame; `setSize`/`setPixelRatio` keep the internal targets matched
 *  to the canvas; `dispose` frees the composer, every pass, and their targets.
 *  The scene/camera are referenced by identity, so a floor rebuild (which swaps
 *  the scene's children but keeps the same THREE.Scene) needs no re-wiring. */
export class BloomPipeline {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly gtaoPass: GTAOPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;
  private readonly gradePass: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);

    this.gtaoPass = new GTAOPass(scene, camera, size.x, size.y);
    this.gtaoPass.updateGtaoMaterial({
      radius: AO_RADIUS_M,
      distanceExponent: AO_DISTANCE_EXPONENT,
      thickness: AO_THICKNESS,
      scale: AO_SCALE,
      samples: AO_SAMPLES,
    });
    this.gtaoPass.blendIntensity = AO_BLEND;

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.outputPass = new OutputPass(); // applies ACES tone map + sRGB
    // LAST: grade on tone-mapped sRGB pixels.
    this.gradePass = new ShaderPass(GradeShader);

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtaoPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.gradePass);
  }

  /** Toggle the AO pass. Low quality skips it entirely (it is the most expensive
   *  pass in the chain — a full depth+normal prepass plus a denoise). */
  setAoEnabled(on: boolean): void {
    this.gtaoPass.enabled = on;
  }

  render(): void {
    this.composer.render();
  }

  /** Match the composer (and every pass's internal targets) to the canvas. Pass
   *  CSS pixels, exactly like renderer.setSize — pixel ratio is applied inside. */
  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  /** Mirror a renderer.setPixelRatio change (EffectComposer snapshots the ratio at
   *  construction, so the quality valve must push it through or the targets stay
   *  at the old resolution). */
  setPixelRatio(pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
  }

  /** Repoint the passes at a new camera. Unused today (the fp camera is never
   *  swapped) but kept so a future change can't silently leave AO on a stale one. */
  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
    this.gtaoPass.camera = camera;
  }

  /** Free the composer's targets AND every pass's own targets/materials.
   *  EffectComposer.dispose only frees its two internal targets + copy pass, so
   *  each pass is disposed explicitly — UnrealBloomPass owns a mip chain and
   *  GTAOPass owns depth/normal/denoise targets that would otherwise leak on every
   *  walk-mode teardown. */
  dispose(): void {
    this.gtaoPass.dispose();
    this.bloomPass.dispose();
    this.gradePass.dispose();
    this.outputPass.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
  }
}
