// R4 post-processing — an EffectComposer bloom pipeline for the walk renderer's
// "High" quality path. Lives in src/editor3d/ with the rest of the three.js code
// (bundle boundary is grep-auditable; the single-file viewer never imports this).
//
// The bloom SERVES the camera-primary look: the bright things in the scene are the
// green coverage-lit floor, the selected camera's emissive body, and the emissive
// slot screens / neon signage. Thresholded bloom makes ONLY those bright regions
// glow, so the coverage cones and cameras pop harder while the receded world does
// not — bloom does not touch the coverage/camera logic, it just amplifies its read.
//
// Pass order + tone mapping (do NOT double tone-map):
//   RenderPass  → renders the scene into the composer's internal HalfFloat render
//                 target. Because that's a render target (not the screen), three
//                 applies NEITHER tone mapping NOR sRGB here — the scene stays in
//                 LINEAR HDR, which is exactly what UnrealBloomPass needs to
//                 threshold real highlights.
//   UnrealBloomPass → extracts + blurs the bright regions in linear HDR and screens
//                 them back in.
//   OutputPass  → LAST. Applies the renderer's ACESFilmicToneMapping + sRGB output
//                 at the final blit to screen (it reads tone mapping + color space
//                 off the renderer). This is the ONLY tone-map in the chain, so the
//                 renderer keeps toneMapping = ACESFilmicToneMapping and we let
//                 OutputPass do it — no double tone-map, no double sRGB.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Bloom tuning — exposed as named constants for the human to tune after screenshots.
// Chosen so ONLY genuinely bright things bloom (emissive slot screens, neon
// signage, camera-body emissive, the bright green coverage-lit floor), NOT the
// whole scene: a high threshold keeps the dim, receded world matte.
export const BLOOM_THRESHOLD = 0.95; // luminance above which a pixel contributes to bloom
export const BLOOM_STRENGTH = 0.32; // overall bloom intensity (a controlled glow, not a whiteout)
export const BLOOM_RADIUS = 0.5; // bloom spread across the mip chain

/** Owns an EffectComposer bloom pipeline bound to one renderer/scene/camera.
 *  render() draws the composed (bloomed + tone-mapped) frame; setSize keeps the
 *  composer's render targets matched to the canvas; dispose frees the composer,
 *  every pass, and their render targets. The scene/camera are referenced by
 *  identity, so a floor rebuild (which swaps the scene's children but keeps the
 *  same THREE.Scene object) needs no re-wiring. */
export class BloomPipeline {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    // No explicit render target: EffectComposer defaults its internal targets to
    // HalfFloatType, giving the linear-HDR buffer the bloom threshold needs.
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.outputPass = new OutputPass(); // LAST — applies ACES tone map + sRGB
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
  }

  render(): void {
    this.composer.render();
  }

  /** Match the composer (and thus every pass's internal targets) to the canvas.
   *  EffectComposer.setSize resizes its read/write targets AND forwards to each
   *  pass, so the bloom mip chain resizes with it — pass CSS pixels, exactly like
   *  renderer.setSize (pixel ratio is applied internally). */
  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  /** Match the composer's cached pixel ratio to the renderer's (EffectComposer
   *  snapshots it at construction, so a later renderer.setPixelRatio — e.g. the
   *  quality valve dropping to 1 — must be mirrored here or the bloom targets
   *  stay at the old resolution). */
  setPixelRatio(pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
  }

  /** Repoint the RenderPass at a new camera. Unused today (the fp camera is never
   *  swapped) but kept for safety if that ever changes. */
  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  /** Free the composer's render targets AND every pass's own targets/materials.
   *  EffectComposer.dispose only frees its two internal targets + copy pass, so
   *  each added pass is disposed explicitly — UnrealBloomPass in particular owns a
   *  chain of render targets that would otherwise leak on every walk-mode teardown. */
  dispose(): void {
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
  }
}
