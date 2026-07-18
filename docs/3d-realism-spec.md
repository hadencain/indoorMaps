# 3D Realism — "Tech-Team Render" Walk Mode

Date: 2026-07-17. Extends the walk editor (`docs/3d-editor-spec.md`). Goal: the walk view should feel like a game-engine replica of the property that the venue's own tech team pre-rendered — believable materials, lighting, and fixtures — **with the CCTV cameras and their coverage still the primary subject.**

## The honest bar (what "realistic" means here)

Not photoreal, and not hand-modeled per property. The properties exist only as IMDF-ish **data** (unit polygons + category, fixture polygons + kind, openings, footprints, camera poses). The walk scene is *generated* from that data, so realism means **procedural richness from the same data** — PBR materials, parametric fixture models, and staged lighting synthesized in code. This is the only approach that respects the hard constraints:

- **Local-first / offline / single-file viewer:** no external asset fetches, no glTF/texture downloads, no CDN. Textures are generated procedurally (canvas 2D + value noise) and shared; geometry is built in code. (An asset-pack pipeline would also break the viewer's zero-network guarantee and bloat the bundle — out of scope, "within reason".)
- **Scale:** the casino demo is ~500 fixtures + ~500 cameras *per floor*. Everything realistic must be **instanced per kind** or merged, or draw calls explode on the GTX 1650 target.
- **Camera-primary:** the richer the world, the easier the green coverage cones get lost. The world must recede so the cameras read.

Target: a clean, well-lit architectural-game look (think a modern stealth/heist game interior), 60 fps on the dev GPU at High quality, with a Low quality valve.

## Architecture — realism lives in editor3d, the scene stays abstract

```
src/scene/scene-build.ts (PURE, no three)  ── unchanged contract ──▶ Scene3D
   floorPatches[], wallSegs[], slabPrisms[], structurePrisms[],
   fixturePrisms[] (kind+ring+base+top), cameras[], ceilingM, footprintRing
                                   │ consumed by
                                   ▼
src/editor3d/  (ALL three.js realism — grep-audited, never in the viewer bundle)
   materials.ts   procedural PBR material + texture library (carpet/felt/wood/
                  metal/glass/tile/concrete/neon), canvas+noise, shared+cached
   fixtures.ts    parametric detailed geometry per FixtureKind; instanced by kind
                  (uniform kinds) or built per-polygon (bar/counter/stage)
   lighting.ts    fixture-aware lights: pit chandeliers, slot neon, downlights,
                  emissive signage; shadow budget shared with coverage cones
   post.ts        EffectComposer: ACES tone map + SSAO + bloom + SMAA (High only)
   walk-renderer.ts  orchestrates; owns the Quality setting + camera-primary look
```

**Forbidden (unchanged from the walk spec):** three stays inside `src/editor3d/`. `src/scene/` gains no three, no renderer types — if a fixture model needs orientation, the renderer derives it from the polygon (principal axis), not a new data field. The single-file viewer never imports `editor3d/`, so **none of this touches the viewer template** (editor3d is app-only, code-split). `src/types.ts` / building data are **not** modified — realism is pure rendering synthesis, exactly like the shipped `heightM` extrusion synthesis.

## Decisions (locked)

- **Procedural textures, not images.** Canvas-drawn + value-noise → `CanvasTexture` for albedo/roughness/normal, per material family, generated once and shared. Keeps the bundle small and the viewer network-free. Deviation from a typical game pipeline (which ships texture atlases): we can't ship binary assets into a single-file offline artifact, and procedural is good enough for the stylized bar.
- **Instancing per fixture kind is mandatory.** One detailed geometry per uniform kind (blackjack/roulette/poker/baccarat/craps table, slot machine, seating unit, car), placed via per-instance matrix (position + polygon principal-axis rotation). Variable-footprint kinds (bar, counter, stage, planter) are built from their polygon and merged per floor. Selection/hover never rebuilds — matrix/color updates only.
- **PBR + tone mapping.** `MeshStandardMaterial` with roughness/metalness/normal; `ACESFilmicToneMapping`; `SRGBColorSpace` output; physically-scaled light intensities. Replaces the current flat `MeshStandard` boxes.
- **Post-processing behind a Quality toggle.** High = SSAO (contact shadows/AO the procedural lighting can't fake) + bloom (neon/screens/coverage cones glow) + SMAA. Low = forward render, no composer. Default High; a HUD "Quality" control flips it; auto-drop to Low if the first frames blow the budget. This is the perf valve the GTX 1650 target needs.
- **Camera-primary look (the constraint).** In the walk view the world is rendered slightly cool and dimmer; the CCTV bodies carry an emissive accent + status LED so they read from across a room; the green coverage cones use additive blending + bloom so they float above the detailed world. Selecting a camera subtly desaturates/darkens the rest of the scene so the chosen camera and its cone dominate. Coverage remains the reason the tool exists.
- **Shadow budget is shared and capped.** Realistic house lights want shadows, but the coverage spotlights already cost up to 9 shadow maps. Cap total shadow casters (house + coverage) at a fixed budget; house lighting leans on SSAO + emissive + a single key directional-ish fill for softness rather than N shadow-casting point lights. Coverage cones keep shadow priority (occlusion honesty is the product).

## Phases

- **R1 — pipeline + architecture.** Renderer upgrade (tone map, color space, shadow config, optional composer), `materials.ts` procedural PBR library, and re-materialed **walls / floors / ceiling** (per-category flooring, wall material + baseboard, ceiling coffers + recessed lights). The foundation everything sits on. Verify: walk the casino, screenshot — surfaces read as materials, not flat fills; 60 fps High.
- **R2 — fixture model library.** `fixtures.ts`: parametric, instanced detailed models for every `FixtureKind` (tables with felt/rail/chip-tray, slot cabinets with emissive screens, bar + back-bar, roulette wheel, stage, seating, planter w/ foliage, car). The big content phase. Verify: the pit reads as gaming tables + slots, not colored boxes.
- **R3 — lighting, atmosphere, props + camera-primary polish.** Pit chandeliers, slot neon, room signage, downlights; instanced chairs/stools around tables; the camera-primary look (world recede + cone bloom + select-to-focus). Verify: it feels like a rendered venue; cameras/cones dominate.
- **R4 — perf + quality valve + multi-venue verify + review.** Quality toggle wired + auto-fallback; LOD/instancing tuning; verify casino + one non-casino venue (mall/airport) so generic kinds hold up; adversarial review; merge.

Each phase is workflow-built, browser-verified with screenshots (this is inherently visual — the gate is the render, not a unit test), and adversarially reviewed before merge.

## Out of scope

Downloaded/asset-pack models, glTF import, AI-generated geometry, photoreal lightmaps/baking, per-property hand-authoring, characters/NPCs, exterior/skybox beyond a simple environment, VR. Data model unchanged. Viewer (single-file) 3D stays the shipped fill-extrusion look — realism is walk-editor only.
