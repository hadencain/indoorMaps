# 3D First-Person Editor — Data Model & Architecture Spec

Date: 2026-07-17
Status: design only — no implementation until the spike (`docs/3d-spike-plan.md`) passes its done-criteria.

## What this is

Data-model and architecture groundwork for a first-person 3D editor: walk a building at eye level, place and aim CCTV cameras on real mount surfaces, and see occlusion-correct coverage painted on the floor. It extends the existing IMDF-flavored 2D model (`src/types.ts`) with the minimum vertical dimension it currently lacks — camera mount height and full 3D orientation, first-class occluding structures (columns, soffits, large obstacles), and a per-floor ceiling — while the 2D MapLibre editor, wayfinding, exports, and the shareable viewer continue to read every building unchanged. It inherits the codebase's one schema discipline: **additive optional fields on a frozen v3 envelope**, defaults centralized in `withBuildingDefaults` (`src/persistence.ts`). The 3D editor itself is a second renderer over the same zustand store, never a second source of truth. This is distinct from and layered above the shipped Phase A "3D view" (MapLibre fill-extrusion tilt, spec 2026-07-16), which stays as the map-side 3D look.

## Success criteria

1. A building saved by today's build (v3, no new fields) loads in both editors with zero migration; the 3D editor renders it using derived defaults (ceiling 3.2 m, cameras at 4 m ceiling mounts) and looks plausible without any authoring.
2. A building authored in the 3D editor (mount heights, roll, structures, ceilings) round-trips through `buildingFileText` → `parseBuildingFileText` and loads in the **current shipped build** without error — new fields are carried or ignored, never fatal. Verifiable by feeding a new-field save to the current `isValidBuildingShape` + `loadBuilding` path.
3. Setting `mountM` on a tilted camera visibly changes the 2D tilt-band coverage annulus (near/far edges move per the `tiltBand` math) — the two renderers agree on the same physical camera.
4. A column placed in the 3D editor casts a 2D coverage shadow: the camera's visibility polygon in the MapLibre editor is clipped by the column footprint, and blind-spot analysis counts the area behind it.
5. The shareable viewer exported from a 3D-authored building contains no camera field of any kind (existing strip covers the new fields for free) and drops structures inside restricted units; structures in public space survive and extrude in the viewer's Phase A 3D toggle.
6. `npm run build:viewer && git diff --exit-code src/generated/viewer-template.html` stays green after adding `src/scene/` and `src/editor3d/` — proof the 3D editor is not bundled into the viewer.

## Data-model additions

All additions are optional fields or optional collections. Persistence version stays **3**. Nothing existing is renamed, retyped, or re-interpreted.

### 1. Camera: mount height, 3D orientation, mount surface

`Camera` already carries two of the three orientation angles — `heading` (pan, degrees from +x, CCW, atan2-native) and `tiltDeg` (degrees **below** horizontal). These are kept verbatim; the 3D editor adopts their conventions rather than introducing parallel fields. Added:

```ts
export interface Camera {
  // ...existing fields unchanged...
  /** Lens height above the floor slab, metres. Absent ⇒ MOUNT_H (4 m), the
   *  constant tiltBand already assumes — so legacy coverage is bit-identical. */
  mountM?: number;
  /** Roll about the optical axis, degrees CW looking along the view direction.
   *  Absent ⇒ 0 (level horizon). Affects only the rendered frustum/feed
   *  orientation — never the coverage footprint (a rolled rectangle sweeps the
   *  same floor region for coverage purposes at our fidelity). */
  rollDeg?: number;
  /** What the camera is fastened to. Drives 3D gizmo defaults and mesh
   *  orientation, and constrains the placement snap in the 3D editor:
   *  ceiling ⇒ mountM snaps to level ceilingM; wall ⇒ position snaps to the
   *  nearest wall segment (from collectWalls); column ⇒ snaps to a Structure
   *  of kind "column". Absent ⇒ "ceiling". */
  mount?: "ceiling" | "wall" | "column";
  /** Vertical FOV, degrees. Absent ⇒ derived from fovDeg at 16:9
   *  (vfov = 2·atan(tan(fovDeg/2) · 9/16)). Stored only when the user
   *  overrides it (unusual sensor formats). */
  vfovDeg?: number;
}
```

**The one behavioral coupling, made explicit:** `MOUNT_H` in `coverage.ts` stops being a global constant and becomes the *default* — `tiltBand` reads `cam.mountM ?? MOUNT_H`. This is the point where 3D authoring feeds back into 2D analysis, and it is intentional: mount height is a physical property of the camera, not a rendering detail. It is still additive — every existing save has no `mountM` and computes exactly today's bands.

Note: the tilt model's sign convention (positive = down) is unusual for 3D tooling (most gizmos treat pitch-up as positive). The 3D editor's UI may display "tilt down 30°" however it likes, but the **stored field keeps today's convention** — flipping it would be a silent breaking change to every persisted camera.

### 2. Structures: columns and large obstacles (new collection)

Fixtures cannot carry this. The `Fixture` contract is explicit and load-bearing: *"purely visual … don't occlude cameras."* Coverage math, the viewer strip rules, and every demo were built against that promise. A column that blocks sightlines is a different kind of thing, so it gets a first-class type instead of a poisoned `FixtureKind`:

```ts
/** A sightline-blocking, walkable-around solid: structural column, soffit,
 *  duct run, shelving mass, kiosk block. The anti-Fixture: structures ALWAYS
 *  occlude — collectWalls() gains their edges (2D line-of-sight) and the 3D
 *  scene extrudes them solid. They are not units: not routable space, not
 *  coverage floor, no occupants. */
export interface Structure {
  id: string;
  ordinal: number;
  kind: "column" | "obstacle";
  /** Footprint in local metres, open ring (same convention as Unit.polygon).
   *  Canonical geometry — everything downstream reads only this. */
  polygon: MetreXY[];
  /** Top of the solid above the floor slab. Absent ⇒ the level's ceiling
   *  (full-height column). */
  heightM?: number;
  /** Bottom of the solid above the floor slab. Absent ⇒ 0 (floor-standing).
   *  baseM > 0 models soffits/ducts/signage you can walk under —
   *  2D coverage treats baseM > ~1.8 m as NON-occluding (sightlines at
   *  camera height pass under... see open question OQ-3). */
  baseM?: number;
  /** Authoring hint for round columns: the editor's column tool tessellates
   *  center+radius into a 12-gon polygon and keeps the params here so the
   *  column stays re-editable as a circle. Renderers ignore it. */
  round?: { center: MetreXY; radiusM: number };
}

// Building gains: structures?: Structure[];  // additive; defaults to []
```

`withBuildingDefaults` adds `"structures"` to its collection list. `collectWalls(b, ordinal)` appends structure footprint edges (for `baseM` low enough to occlude) — this changes 2D coverage **only** for buildings that contain structures, so it is behavior-additive in the same sense as `tiltDeg` was.

Two-geometry rule: `polygon` is canonical, `round` is a hint. One representation flows through coverage, rendering, hit-testing, and export; the hint only reconstitutes the circle gizmo. This avoids every "is it a circle or a polygon this frame" branch downstream.

### 3. Ceiling per floor

The ceiling is a property of the level, not a new geometry object:

```ts
export interface Level {
  ordinal: number;
  name: string;
  /** Ceiling height above the floor slab, metres. Absent ⇒ 3.2 (the value
   *  UNIT_HEIGHT_M has always synthesized for full-height categories, so
   *  legacy buildings render identical extrusions). */
  ceilingM?: number;
}
```

Ceiling **geometry** is never stored — it is derived at render time: the level's `Footprint.polygon` if present, else the union of non-`outside` unit polygons at that ordinal. Storing a ceiling polygon would create a second copy of the floor outline that drifts from the units it must cover.

**Snap-grid is editor state, not building data.** The 3D editor's height snap increment (default 0.1 m; ceiling drag, mountM drag, structure heightM all snap to it) lives in the zustand UI state alongside `showGrid`/`gridSize` and persists in the display-prefs key — the same place the 2D grid already lives. Putting it in the building file would make a UI preference travel with the data and fight the recipient's own preference.

Deliberately deferred (recorded, not designed): per-unit ceiling overrides (`Unit.ceilingM?` for atria / double-height spaces) and `Level.elevationM?` (absolute slab elevation for stacked multi-floor 3D). Both slot in as further additive optionals when needed; v1 of the 3D editor renders one floor at a time, so neither blocks anything. Adding them now would be speculative fields with no consumer.

### 4. Schema versioning strategy

Keep the proven regime; write its rules down so 3D work doesn't erode it:

- **The version number stays 3.** `BUILDING_KEY_BASE` and the file envelope `version: 3` are untouched. v3 means "the spine plus any subset of the additive optionals" — it has meant that since cameras were added, and every consumer already tolerates unknown extra fields (`JSON.parse` keeps them; nothing validates against a closed schema).
- **New collections** ⇒ one line in `withBuildingDefaults`. **New scalars** ⇒ documented absent-semantics at the type declaration (as `kind?` on `Opening` and `tiltDeg?` on `Camera` already do) and a `?? default` at every read site.
- **`isValidBuildingShape` never grows.** It checks the v0 spine (units/levels/openings/verticals/origin) — the set whose absence crashes the first render. Adding new fields to it would retroactively invalidate every older save; new fields are guarded by defaults, not by validation.
- **Forward-compat is free and verified:** an old build loading a new save ignores fields it doesn't read. Success criterion 2 pins this with a test (new-field fixture through the current parse path).
- **v4 is reserved for a genuinely breaking change** (a renamed field, a re-interpreted convention like flipping tilt sign). The rule if that day comes: `parseBuildingFileText` learns to read v3 and migrate up; v3 files remain loadable forever. No 3D feature in this spec requires it.
- **Export surfaces:** IMDF/GeoJSON export maps `Structure` → IMDF `fixture` with `category: "column"`/`"obstacle"` (IMDF has no occlusion concept; the distinction is ours). The viewer's `toVisitorBuilding` keeps structures (public architecture) but drops those whose centroid lies inside a restricted unit — the same rule that already drops restricted-interior fixtures. Camera additions need no new stripping: cameras are removed wholesale from visitor payloads, and the new fields ride out with them.

## Architecture — two renderers, one store, knowledge flows down

```
                    ┌────────────────────────────────────────────┐
                    │            zustand store (src/store.ts)    │
                    │  Building (single source of truth)         │
                    │  actions: addUnit, setCameraPose*, undo…   │
                    └───────▲──────────────▲─────────────────────┘
                            │ actions       │ actions
              subscribe/    │               │            subscribe/
              derive        │               │            derive
        ┌───────────────────┴───┐       ┌───┴──────────────────────┐
        │  2D editor (MapLibre) │       │  3D editor (src/editor3d/)│
        │  render.ts → GeoJSON  │       │  Three.js adapter, FPS    │
        │  sources/layers       │       │  controls, mount gizmos   │
        └───────────┬───────────┘       └───────────┬──────────────┘
                    │ imports                        │ imports
        ┌───────────▼────────────────────────────────▼──────────────┐
        │  shared pure modules (no React, no renderer, no store)    │
        │  types.ts · geo.ts · coverage.ts (collectWalls, tiltBand) │
        │  categories.ts · graph/astar (untouched by 3D)            │
        │  NEW src/scene/ — build3dScene(building, ordinal) →       │
        │    { floorPlane, ceilingPlane, wallPrisms, structurePrisms,│
        │      fixturePrisms, cameraPoses }  (plain metre-space data)│
        └────────────────────────────────────────────────────────────┘
```

**`src/scene/` is the load-bearing new piece.** It converts a `Building` + ordinal into a renderer-agnostic 3D scene description — wall segments (from `collectWalls`) as prisms with the level's `ceilingM`, structures as base/height prisms, fixtures as `FIXTURE_HEIGHT_M` prisms, camera poses as `{position: [x,y,z], heading, tiltDeg, rollDeg, fovDeg, vfovDeg, rangeM}`. Pure metre-space arrays and numbers, zero Three.js types, fully vitest-able without a GPU. The Three adapter in `editor3d/` is then a thin "scene description → meshes" mapping, and a future Babylon/WebGPU swap replaces only the adapter.

**Forbidden relationships** (the constraints that keep the two editors decoupled):

- `src/scene/` never imports three.js, React, MapLibre, or the store. It is `render.ts`'s sibling: same inputs (Building), different output shape (prisms vs GeoJSON).
- Nothing outside `src/editor3d/` imports three.js. One directory owns the dependency; the bundle boundary is auditable with a grep.
- `src/editor3d/` never imports MapLibre or any `src/ui/` map component, and never touches `localStorage` or building JSON directly — every mutation is a store action, so undo/redo, persistence quota-stripping, and the 2D editor's reactivity work identically for edits from either renderer.
- The store learns **actions**, not renderers: `setCameraPose`, `addStructure`, `setLevelCeiling`. It must never hold a Three object, a MapLibre map ref, or renderer-specific derived state.
- The shareable viewer never gains `scene/` or `editor3d/` in its import graph (success criterion 6 pins this). The viewer's 3D remains the Phase A fill-extrusion recipe. Corollary: `types.ts` changes are type-erased and `render.ts`'s `UNIT_HEIGHT_M` default must equal the `ceilingM` default (3.2) — one constant, exported from one place, imported by both.

**Why not one shared renderer / why not put 3D in MapLibre:** the shipped Phase A already stretches MapLibre to its extrusion ceiling — no first-person camera, no interior walls, no real occlusion, no shadow-mapped coverage. First-person + depth-buffer coverage requires a real scene graph. Conversely, rebuilding the 2D authoring canvas in Three would forfeit two weeks of P1 interaction work for nothing. Two renderers over one store is the cheapest honest shape.

## Failure modes

- **New-field save opened in the shipped build** → fields ignored, building loads, edits re-save without the fields being dropped only if the shipped build spreads unknown keys. It does not — `persistBuilding` serializes the store's Building object, which came from `JSON.parse` and *retains* unknown keys. Verified assumption; success criterion 2's test must cover the save-back path, not just load.
- **Camera `mount: "wall"` whose wall was later deleted in the 2D editor** → the mount enum is a hint, not a constraint; the camera keeps its position, the 3D editor renders it free-floating and flags it in the health panel (same pattern as orphaned openings in `interaction/health.ts`). Never auto-move geometry to satisfy a hint.
- **Structure with `heightM` > level `ceilingM`** → clamp at render time to the ceiling, log nothing, store the authored value (the user may raise the ceiling next). Coverage uses the footprint regardless.
- **Degenerate structure polygon (< 3 distinct vertices, ~0 area)** → rejected at the store-action boundary with the same validation drawing units already gets; never persisted.
- **`mountM` set below `tiltBand`'s validity (camera at 0.5 m tilted down)** → the math degrades gracefully (band collapses toward the mount); no special case. `mountM ≤ 0` is clamped to 0.1 at the action boundary.
- **localStorage quota with structures** → structures are small (dozens of 12-gons) and are *not* added to the quota-strip fallback list; only bulky media (underlay dataUrls, CAD polylines) gets stripped, as today.

## Open questions (resolve before implementation, none block the spike)

- **OQ-1 — roll and coverage:** spec asserts roll never affects the 2D footprint. True for the coverage fidelity we compute (range-capped visibility polygon), but a rolled rectangular frustum's *floor intersection* does rotate. Accept the approximation permanently, or note it as a 3D-coverage-only refinement?
- **OQ-2 — `vfovDeg` default aspect:** 16:9 assumed. Dome cameras have no meaningful vfov (full hemisphere) — the 3D frustum for domes should render as a hemisphere gizmo, not a pyramid. Confirm before building the gizmo.
- **OQ-3 — the walk-under threshold:** at what `baseM` does an obstacle stop occluding 2D sightlines? Correct answer depends on both camera `mountM` and target height; v1 proposal is a single constant (occlude iff `baseM < 1.8`), documented as an approximation. The 3D depth-map coverage gets this right for free — which is half the point of building it.
- **OQ-4 — does the 2D editor render structures?** They must at least be visible/selectable in 2D (else 2D-only users get invisible coverage shadows). Proposal: dark hatched fill + outline, a `structures` layer-visibility row. Needs a Phase-A-3D extrusion entry too (`fill-extrusion` at heightM), which touches `render.ts` → viewer template regeneration.
- **OQ-6 — corridor edges as occluders (spike finding, 2026-07-17):** 2D `collectWalls` treats every unit edge — including corridor/lobby, which render as 0.15 m slabs — as a sightline blocker. The spike showed a promenade camera's 2D polygon trapped in the corridor band while 3D light correctly crosses the open floor. Either 2D coverage learns to skip low-slab category edges (a behavior change to shipped coverage + report numbers), or the divergence is accepted and documented. Must be resolved before the 3D editor ships coverage, since the two views would visibly disagree on every corridor-mounted camera.
- **OQ-5 — camera mesh vs pose gizmo:** does the 3D editor render a literal camera model or an abstract frustum+axis gizmo? Pure UX; defer to after the spike's walk-feel verdict.
