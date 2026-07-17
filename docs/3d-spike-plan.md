# 3D Walk-the-Space Spike — Throwaway Plan

Date: 2026-07-17
Status: not started. Companion to `docs/3d-editor-spec.md` — the spec defines what we'd build; this spike decides whether we build it. **Everything here is disposable**: lives in `scratch/_scratch-3d-spike/`, never merged, never imported by app code, deleted (or archived as screenshots + verdict notes) when done.

## Purpose

Answer two questions with running pixels, before any data-model or editor work:

1. **Feel:** does walking a reconstructed demo building first-person (WASD + mouse-look) feel like *the* product moment, or like a gimmick? This is a taste call that no spec can make.
2. **Graphics core (make-or-break):** can we get **occlusion-correct camera coverage** painted on the floor via depth-buffer / shadow-mapping, at acceptable quality and frame rate on the actual dev GPU (GTX 1650, 4 GB)? If this fails, the 3D editor's whole value proposition (see coverage where 2D polygons lie about height) collapses to "pretty walkthrough," and we should stop.

No editing, no gizmos, no persistence, no collision physics, no multi-floor, no materials polish. Anything not listed in the steps below is out of scope by default.

## Engine: Three.js (recommended) over Babylon.js

**Three.js**, for three reasons in priority order:

1. **The make-or-break step needs low-level access.** The coverage PoC is exactly the territory where Three is strongest: direct control of `WebGLRenderTarget` / `DepthTexture`, per-light shadow-map parameters (`shadow.mapSize`, `bias`, `normalBias`, `shadow.camera` frustum), and `onBeforeCompile` / custom `ShaderMaterial` if we outgrow the built-in spotlight path. The overwhelming majority of projective-texturing and shadow-technique reference material is written against Three; when the PoC hits acne/peter-panning tuning (it will), that corpus is the difference between an afternoon and a week.
2. **Bundle discipline.** Three's core tree-shakes to roughly 150–170 KB gzipped; Babylon's core starts around 4× that. The spike doesn't care, but if any of this ever migrates toward the single-file shareable viewer (currently ~1.2–1.5 MB total), Babylon would foreclose that option on day one.
3. **Thin-adapter fit.** The spec's architecture makes the engine a leaf adapter behind a pure `src/scene/` description. Three's unopinionated mesh/material/light primitives map 1:1 onto that; Babylon's richer framework (its own scene conventions, observables, asset pipeline) buys nothing when the scene is generated from our own data.

What Babylon would have bought — a built-in FPS `UniversalCamera` with gravity/collisions and the inspector — is explicitly out of spike scope (no collision) or replaceable (Three's `PointerLockControls` + 20 lines of WASD is the standard recipe; `three/examples` ships it). Not decisive. Decision recorded here; revisit only if the Three PoC fails for engine-specific reasons, which step 6 is designed to surface.

## Setup

- `scratch/_scratch-3d-spike/` containing `index.html` + `main.ts`; served with the existing Vite dev server (add nothing to any build config — open it via `vite serve` root path or a one-line `server.fs` allowance if needed). `three` installed as a devDependency and logged in deps as **spike-only, remove with the spike**.
- **Building data:** import `src/demos/casino.ts` directly (richest demo: fixtures, cameras, multi-room) plus the pure modules it needs (`types`, `geo`, `coverage.collectWalls`, `render.UNIT_HEIGHT_M` / `FIXTURE_HEIGHT_M`). Importing pure modules from scratch is fine for a throwaway; nothing imports *back*.
- Coordinate mapping, fixed once at the top of `main.ts`: model metre-space `[x, y]` → Three `(x, z = −y)`, height → `y`. (Three is right-handed Y-up; our plan is X-east/Y-north. The `−y` flip keeps headings CCW-consistent — get this wrong and every camera aims mirrored, so step 1 includes a north-arrow sanity marker.)

## Steps (each has an exit check; stop and reassess on any red)

1. **Ground + orientation sanity** (½ h) — floor plane from the casino footprint, colored axes helper, one labeled marker at a known unit's centroid. *Exit: marker sits where the 2D map says it is; north arrow agrees.*
2. **Walls → boxes** (2 h) — feed `collectWalls(building, ordinal)` output through a segment→box mapper: each wall segment becomes a `BoxGeometry` (length × 0.15 m thick × 3.2 m tall), positioned/rotated from its endpoints. This reuses the exact segment set 2D coverage occludes against — the two coverage systems disagree only where the *technique* differs, never the geometry. *Exit: recognizable casino floor plan standing up; rooms are hollow (walls, not solid prisms).*
3. **Fixtures → obstacle meshes** (1 h) — extrude fixture polygons (`ExtrudeGeometry` from a `Shape`) to `FIXTURE_HEIGHT_M[kind]`. *Exit: blackjack tables at 0.9 m, slots at 1.6 m, walkable between them.*
4. **Ceiling plane** (½ h) — footprint-shaped `ShapeGeometry` at 3.2 m, `DoubleSide`, slightly offset from wall tops to dodge z-fighting. *Exit: looking up shows ceiling; no shimmer along wall/ceiling seams.*
5. **First-person controller** (1–2 h) — `PointerLockControls`, WASD in the ground plane, eye height 1.7 m, sprint on Shift. **No collision** — walking through walls is fine for a spike; note the feel-cost in the verdict if it grates. *Exit: 5 continuous minutes of walking the floor without motion sickness, camera weirdness, or FPS dips below ~50 at 1080 p.*
6. **Camera frustum mesh** (1 h) — take one `Camera` record from the demo; place a small box at `(at, 4 m)` oriented by `heading`/`tiltDeg`; attach a `THREE.CameraHelper` on a `PerspectiveCamera` configured with `fovDeg` (vfov via 16:9 derivation), `far = rangeM`. *Exit: standing under the camera and looking along its axis, the frustum visibly covers what the 2D FOV wedge claims.*
7. **THE MAKE-OR-BREAK: depth-render / shadow-map coverage PoC** (1–2 days, detailed below).

Total: ~2–3 focused days. If steps 1–6 exceed two days, that is itself a finding — report, don't push.

## Step 7 — occlusion-correct coverage proof-of-concept

**The idea:** a CCTV camera's coverage *is* a shadow-mapping problem inverted — "what can the camera see" ≡ "what would a light at the camera illuminate." Depth-render the scene from the camera's pose; any floor fragment whose depth passes the comparison is covered. Walls, columns, and fixtures then occlude coverage *in 3D, correctly, for free* — including the walk-under/see-over cases the 2D polygon model can only approximate (spec OQ-3).

**Stage A — built-in spotlight path (try first, ~½ day):**
One `THREE.SpotLight` per camera: `angle = fovDeg/2` (accepting the cone-vs-rectangular-pyramid mismatch for now), `distance = rangeM`, `decay = 0`, `castShadow = true`, `shadow.mapSize = 2048²`, positioned/aimed from the camera pose. Scene lit by dim ambient + camera-lights in a distinct color; lit floor = covered floor. Walls/structures/fixtures all `castShadow = true`; floor `receiveShadow = true`.

**Stage B — custom depth pass (only if A's quality fails):**
Render the scene to a `DepthTexture` from a `PerspectiveCamera` at the CCTV pose; floor `ShaderMaterial` projects each fragment into that camera's clip space and does the depth comparison with PCF, tinting covered fragments. Full control over the rectangular frustum, bias, and blending — at the cost of owning the shader. Stage B existing as a known fallback is why Stage A failing on *quality* doesn't kill the spike; only Stage B failing on *feasibility or perf* does.

**What Stage A must prove (the checklist that constitutes the PoC):**

- **P1 Occlusion truth:** for ONE camera, screenshot the floor top-down (orthographic) with the spotlight coverage visible, and overlay the 2D `computeVisibility` polygon for the same camera. The lit region and the polygon must agree in shape — same wall shadows, same range arc — within eyeball tolerance. This is the acceptance test that the 3D and 2D systems describe the same physical camera.
- **P2 Column occlusion:** hand-add one 12-gon column mesh (a stand-in for the spec's `Structure`) inside the FOV; a clean coverage shadow must appear behind it.
- **P3 Tilt consistency:** set `tiltDeg = 30`; the lit band's near/far edges must move consistently with `tiltBand`'s annulus math (near hole under the mount, far edge pulled in).
- **P4 Artifact budget:** shadow acne / peter-panning tamed with `bias`/`normalBias` tuning at building scale (~100 m extents — depth precision across that range with a 2048² map is the real unknown). Verdict red if walls need visible gaps or coverage edges crawl while walking.
- **P5 Scale & perf on the GTX 1650:** all demo cameras lit simultaneously (casino has several; force **8** minimum, duplicating if needed). 8 × 2048² depth maps ≈ 128 MB+ of the 4 GB VRAM plus a shadow-render pass per light per frame — this GPU is the floor of plausible hardware, which makes it the honest test bench. Record FPS at 1080 p walking the densest aisle. Red below 30 fps; the product answer at scale is likely "shadow-update only the selected/nearby cameras," but the spike must measure the naive cost first.

## Done-criteria (all must hold before ANY further 3D commitment)

1. Continuous first-person walk of the casino floor at ≥ 50 fps (1080 p, GTX 1650) with geometry from steps 2–4 and coverage from ONE active camera; ≥ 30 fps with 8 active cameras.
2. P1 screenshot pair (3D coverage vs 2D visibility polygon) archived and agreeing — walls occlude identically in both.
3. P2 column shadow and P3 tilt-band behavior demonstrated and archived as screenshots.
4. No disqualifying artifacts: no z-fighting on ceiling/floor seams, coverage edges stable while moving (P4).
5. A one-page verdict note (appended to this file) answering: does the walk *feel* like the product? Stage A sufficient or is Stage B required? What did the frustum-vs-cone mismatch actually look like? Naive perf numbers, and the implied camera-count budget.
6. The spike directory is deleted or clearly quarantined; `three` removed from deps unless the verdict is GO.

**No-go conditions, stated in advance:** Stage B required AND estimated > 1 week; or 8-camera perf unrecoverable below 30 fps even with obvious knobs (1024² maps, static shadow caching); or the walk feel verdict is "gimmick." Any of these → the 3D editor drops to backlog and the spec stays a document.

## Open questions to settle before starting (30 minutes, not days)

- **Cone vs rectangle:** accept spotlight's circular cone for Stage A (undercovers the frustum corners)? Proposed: yes — P1's overlay will show exactly how much it lies, which is the data we want.
- **Coverage color mixing:** overlapping cameras additively brighten (spotlights sum naturally). Fine for the spike; the product question (per-camera colors? seen-by-N heat?) is deferred.
- **Which demo:** casino assumed (fixtures + cameras). If its camera count is < 4, pre-duplicate cameras in the spike loader rather than editing the demo file.
- **Screenshot harness:** manual screenshots are fine for a spike; do NOT wire the verify skill / headless harness into scratch.
