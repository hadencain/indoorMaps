// Venue lighting design for the walk editor (Phase A of the AAA venue render pass,
// docs/superpowers/plans/2026-08-01-aaa-venue-render.md). This is the `lighting.ts`
// the R-spec named and never built.
//
// three.js is imported here ONLY inside src/editor3d/ so the bundle boundary stays
// grep-auditable and the single-file viewer never pulls it in.
//
// TWO SEPARATE BUDGETS, and conflating them is the mistake this module exists to fix.
//
//   1. LUMINAIRES — the fittings you can SEE. Emissive geometry: troffers, pendants,
//      downlight cans, bare strips. Effectively unlimited (instanced per kind+colour,
//      a handful of draw calls per floor) and they cost no light-shader work at all.
//      This is what actually makes a space read as designed: before this, house
//      lighting was 8 INVISIBLE PointLights, so the venue was lit by nothing you
//      could point at. A real interior is legible because you can see the fittings
//      and read the rhythm they're laid out on.
//
//   2. REAL LIGHTS — the bounded set of THREE.Light objects that do the shading.
//      Forward rendering recompiles per light count and costs fragments per light,
//      so this stays small and is spent where it buys the most: the highest-weighted
//      zones. Everything else is carried by the environment map (env.ts), the
//      hemisphere term, and the emissive fittings themselves.
//
// VENUE-PRIMARY (locked decision 1): the old rig was deliberately cool and dim so
// the CCTV coverage cones stayed the brightest thing in frame. That constraint is
// gone. This rig lights the venue as a venue — per-category colour temperature,
// fitting rhythm that matches the room's function, and enough level that the
// procedural materials actually read.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Category, MetreXY } from "../types";
import { pointInRing } from "../coverage";
import type { SceneFloorPatch } from "../scene/scene-build";

/** Fitting archetype. `none` means the space gets no fittings (exterior areas). */
export type LuminaireKind = "troffer" | "downlight" | "pendant" | "strip" | "none";

/** The lighting design for one class of space. */
export interface LightZone {
  /** Colour temperature in kelvin. The single strongest signal that a venue was
   *  designed rather than generated: 2700 K over a bar and 5000 K in a plant room
   *  read as different places even with identical geometry. */
  kelvin: number;
  luminaire: LuminaireKind;
  /** Fitting grid spacing, metres. Tight in service spaces, generous in halls. */
  spacingM: number;
  /** Emissive level of the fitting's lit face. Above ~2 it clears the bloom
   *  threshold and blooms, which is what makes a fitting read as a light source
   *  rather than a white rectangle. */
  emissiveI: number;
  /** Priority when handing out the scarce real-light budget. Higher wins. */
  weight: number;
}

const ZONES: Record<string, LightZone> = {
  gaming: { kelvin: 2900, luminaire: "pendant", spacingM: 7, emissiveI: 3.4, weight: 1.0 },
  fnb: { kelvin: 2700, luminaire: "pendant", spacingM: 5.5, emissiveI: 3.0, weight: 0.9 },
  boh: { kelvin: 5000, luminaire: "strip", spacingM: 6, emissiveI: 2.6, weight: 0.35 },
  lobby: { kelvin: 3200, luminaire: "pendant", spacingM: 9, emissiveI: 3.8, weight: 1.0 },
  retail: { kelvin: 4000, luminaire: "troffer", spacingM: 5, emissiveI: 3.2, weight: 0.8 },
  office: { kelvin: 4100, luminaire: "troffer", spacingM: 4.5, emissiveI: 2.8, weight: 0.45 },
  corridor: { kelvin: 3500, luminaire: "downlight", spacingM: 6, emissiveI: 3.0, weight: 0.7 },
  restroom: { kelvin: 4000, luminaire: "downlight", spacingM: 3.2, emissiveI: 2.8, weight: 0.3 },
  service: { kelvin: 5000, luminaire: "strip", spacingM: 7, emissiveI: 2.4, weight: 0.25 },
  vertical: { kelvin: 3800, luminaire: "downlight", spacingM: 4, emissiveI: 2.8, weight: 0.3 },
  none: { kelvin: 4000, luminaire: "none", spacingM: 99, emissiveI: 0, weight: 0 },
};

const CATEGORY_ZONE: Record<Category, keyof typeof ZONES> = {
  room: "gaming",
  corridor: "corridor",
  office: "office",
  retail: "retail",
  lobby: "lobby",
  restroom: "restroom",
  storage: "service",
  mechanical: "service",
  elevator: "vertical",
  stairs: "vertical",
  outside: "none",
};

/** Unit-id prefix override, mirroring materials.ts's idBucketMaterial: the casino
 *  demo's spaces are all category "room", and lighting a back-of-house cage like a
 *  gaming pit is exactly the tell that the venue was generated. Same buckets as the
 *  floor-material read, so finish and light agree about what a space IS. */
function idBucketZone(id: string): keyof typeof ZONES | null {
  if (id.startsWith("food-") || id.startsWith("bar-")) return "fnb";
  if (id.startsWith("boh-") || id.startsWith("cage-")) return "boh";
  if (id.startsWith("pit-") || id.startsWith("poker-") || id.startsWith("hilimit-")) return "gaming";
  return null;
}

/** The lighting design for a space, by category and (when recognised) unit id. */
export function zoneFor(category: Category, id?: string): LightZone {
  const byId = id ? idBucketZone(id) : null;
  return ZONES[byId ?? CATEGORY_ZONE[category] ?? "corridor"];
}

// ---- colour temperature ------------------------------------------------------

/** Kelvin → linear-ish sRGB, the standard piecewise blackbody approximation
 *  (Tanner Helland's fit), clamped to the 1000–12000 K range it is valid over.
 *  Returned as a THREE.Color so callers can hand it straight to a light. */
export function kelvinColor(kelvin: number): THREE.Color {
  const t = Math.min(12000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number): number => Math.min(1, Math.max(0, v / 255));
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

// ---- fitting geometry --------------------------------------------------------
// Each canonical fitting is authored in REAL METRES with its MOUNTING POINT at the
// origin and hanging/recessing DOWNWARD (−Y), so the renderer places an instance by
// translating to (x, ceilingM, −y) with no per-kind offset maths. Housing and lit
// face are separate geometries: the housing takes a shared dark-metal material, the
// face takes a per-colour-temperature emissive one, so one fitting kind at one
// colour temp is exactly two InstancedMesh draw calls.

interface FittingGeo {
  housing: THREE.BufferGeometry;
  face: THREE.BufferGeometry;
  /** How far below the mount the fitting hangs — used to keep it clear of the
   *  player's head in a low space. */
  dropM: number;
}

function troffer(): FittingGeo {
  // Recessed 1200×300 modular panel, the workhorse of every retail/office ceiling.
  const frame = new THREE.BoxGeometry(1.24, 0.08, 0.34);
  frame.translate(0, -0.04, 0);
  const face = new THREE.BoxGeometry(1.16, 0.02, 0.26);
  face.translate(0, -0.085, 0);
  return { housing: frame, face, dropM: 0.1 };
}

function downlight(): FittingGeo {
  // Small recessed can — trim ring proud of the ceiling, lit disc inside it.
  const trim = new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12);
  trim.translate(0, -0.025, 0);
  const face = new THREE.CylinderGeometry(0.085, 0.085, 0.02, 12);
  face.translate(0, -0.055, 0);
  return { housing: trim, face, dropM: 0.07 };
}

function pendant(): FittingGeo {
  // Suspended shade on a stem. The stem is what actually sells ceiling height —
  // a hall reads tall because things hang INTO it.
  const stem = new THREE.CylinderGeometry(0.018, 0.018, 0.9, 6);
  stem.translate(0, -0.45, 0);
  const canopy = new THREE.CylinderGeometry(0.07, 0.07, 0.03, 10);
  canopy.translate(0, -0.015, 0);
  const shade = new THREE.CylinderGeometry(0.1, 0.34, 0.26, 16, 1, true);
  shade.translate(0, -1.03, 0);
  const housing = mergeGeometries([stem, canopy, shade], false);
  [stem, canopy, shade].forEach((g) => g.dispose());
  const face = new THREE.CylinderGeometry(0.3, 0.3, 0.02, 16);
  face.translate(0, -1.15, 0);
  return { housing: housing ?? new THREE.BufferGeometry(), face, dropM: 1.2 };
}

function strip(): FittingGeo {
  // Bare surface-mounted linear fitting — the back-of-house signature.
  const body = new THREE.BoxGeometry(1.5, 0.07, 0.11);
  body.translate(0, -0.035, 0);
  const face = new THREE.BoxGeometry(1.44, 0.02, 0.07);
  face.translate(0, -0.075, 0);
  return { housing: body, face, dropM: 0.09 };
}

const FITTING_BUILDERS: Record<Exclude<LuminaireKind, "none">, () => FittingGeo> = {
  troffer,
  downlight,
  pendant,
  strip,
};

const fittingCache = new Map<LuminaireKind, FittingGeo>();

function getFitting(kind: Exclude<LuminaireKind, "none">): FittingGeo {
  let f = fittingCache.get(kind);
  if (!f) {
    f = FITTING_BUILDERS[kind]();
    f.housing.userData.shared = true;
    f.face.userData.shared = true;
    fittingCache.set(kind, f);
  }
  return f;
}

// ---- shared materials --------------------------------------------------------

let housingMat: THREE.MeshStandardMaterial | null = null;

function getHousingMaterial(): THREE.MeshStandardMaterial {
  if (!housingMat) {
    housingMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.7 });
    housingMat.userData.shared = true;
  }
  return housingMat;
}

const faceCache = new Map<string, THREE.MeshStandardMaterial>();

/** Emissive lit-face material for one colour temperature + level, cached so a
 *  floor's fittings collapse to a few materials. Colour lives on `emissive`; the
 *  base colour carries a dim tint of the same hue so an unlit face (outside every
 *  light's reach) still reads as a lamp rather than a black hole. */
function getFaceMaterial(kelvin: number, intensity: number): THREE.MeshStandardMaterial {
  const k = Math.round(kelvin / 100) * 100;
  const key = `${k}:${intensity.toFixed(2)}`;
  let m = faceCache.get(key);
  if (!m) {
    const c = kelvinColor(k);
    m = new THREE.MeshStandardMaterial({
      color: c.clone().multiplyScalar(0.25),
      emissive: c,
      emissiveIntensity: intensity,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide, // pendant faces are seen from below AND above
    });
    m.userData.shared = true;
    faceCache.set(key, m);
  }
  return m;
}

// ---- placement ---------------------------------------------------------------

/** Per-unit fitting cap: one enormous gaming hall must not eat the whole floor
 *  budget and starve every other space of fittings. */
const MAX_PER_UNIT = 80;
/** Whole-floor instance cap across every kind. Well above any real venue's need
 *  (the casino floor lands around 700), purely a runaway guard on bad polygons. */
const MAX_TOTAL = 1400;

/** A placed fitting, before it is bucketed into instanced meshes. */
interface Placement {
  x: number;
  y: number;
  zone: LightZone;
  /** The FINISHED ceiling of the host unit — which is not the level's ceiling once
   *  ceilings.ts gives each space its own height. Mounting to the level ceiling
   *  put every fitting in a shop or corridor ABOVE its own ceiling tile, i.e.
   *  invisible, lighting the back of the plane. */
  ceilM: number;
  /** Longest axis of the host unit, radians — fittings run WITH the room, not
   *  across it. A ceiling of troffers all facing the same way regardless of the
   *  room they're in is an instant tell. */
  yaw: number;
  /** Host unit area, m². Weights the real-light lottery toward big spaces. */
  area: number;
}

function ringBBox(ring: MetreXY[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

/** Yaw of the longest edge of a ring — a cheap stand-in for the room's principal
 *  axis that costs one pass and is exact for the rectilinear rooms these venues
 *  are actually made of. */
function ringYaw(ring: MetreXY[]): number {
  let best = -1;
  let yaw = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      yaw = Math.atan2(dy, dx);
    }
  }
  return yaw;
}

function ringArea(ring: MetreXY[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Lay fittings out on each unit's own grid, aligned to that unit's principal axis
 *  and inset half a cell so a row never lands hard against a wall. */
function placeFittings(
  patches: SceneFloorPatch[],
  ceilingFor: (patch: SceneFloorPatch) => number,
): Placement[] {
  const out: Placement[] = [];
  for (const patch of patches) {
    if (patch.ring.length < 3) continue;
    const zone = zoneFor(patch.category, patch.id);
    if (zone.luminaire === "none") continue;
    const [minX, minY, maxX, maxY] = ringBBox(patch.ring);
    const step = zone.spacingM;
    const yaw = ringYaw(patch.ring);
    const area = ringArea(patch.ring);
    const ceilM = ceilingFor(patch);
    let n = 0;
    for (let x = minX + step / 2; x <= maxX && n < MAX_PER_UNIT; x += step) {
      for (let y = minY + step / 2; y <= maxY && n < MAX_PER_UNIT; y += step) {
        if (!pointInRing([x, y], patch.ring)) continue;
        out.push({ x, y, zone, yaw, area, ceilM });
        n++;
        if (out.length >= MAX_TOTAL) return out;
      }
    }
  }
  return out;
}

/** What buildLighting hands back: meshes to add to the world group, plus the real
 *  lights (already positioned) and the fitting placements the caller can reuse. */
export interface LightingBuild {
  meshes: THREE.Object3D[];
  /** Lights AND their spot targets — a SpotLight aims at its target's world
   *  position, so the target Object3D must be added to the scene graph too. */
  lights: THREE.Object3D[];
}

/** Real-light budget. Forward rendering recompiles per light count and costs
 *  fragments per light, so this is deliberately small — the environment map and
 *  the emissive fittings carry the rest. */
const MAX_ZONE_LIGHTS = 10;
/** How many of those also CAST. Nothing in the venue cast a shadow before this —
 *  only the green coverage cones did — so every object in every render sat on the
 *  floor with no contact and no cast at all, which no amount of material work can
 *  compensate for. Shadow maps are the expensive part of a light, so only the few
 *  highest-weighted lamps get one; the rest still shade, and ambient occlusion
 *  (post.ts) supplies the short-range grounding everywhere else. */
const MAX_SHADOW_CASTERS = 3;
/** Minimum separation between real lights so the budget spreads across the floor
 *  instead of stacking inside one big room's fitting grid. */
const LIGHT_MIN_SEP_M = 14;

/**
 * Build the whole lighting layer for one floor: visible fittings (instanced per
 * kind + colour temperature) and the bounded set of real lights that shade the
 * space, each taking its host zone's colour temperature.
 *
 * `ceilingM` is the mount plane. Fittings that would hang below `minClearM` are
 * pulled up so a 1.7 m player never walks through a pendant in a low room.
 */
export function buildLighting(
  patches: SceneFloorPatch[],
  ceilingM: number,
  ceilingFor: (patch: SceneFloorPatch) => number = () => ceilingM,
  minClearM = 2.15,
): LightingBuild {
  const meshes: THREE.Object3D[] = [];
  const lights: THREE.Object3D[] = [];
  const placements = placeFittings(patches, ceilingFor);

  // ---- visible fittings ------------------------------------------------------
  // Bucket by kind+kelvin AND mount height, so each bucket is one housing draw and
  // one face draw. Height is in the key because instances in a bucket share one
  // geometry and differ only by matrix — mixing a 2.8 m office and a 7 m hall in
  // one bucket is fine mathematically, but keying it keeps the mount clamp below
  // a single value per bucket rather than per instance.
  const buckets = new Map<
    string,
    { kind: Exclude<LuminaireKind, "none">; zone: LightZone; ceilM: number; items: Placement[] }
  >();
  for (const p of placements) {
    const kind = p.zone.luminaire as Exclude<LuminaireKind, "none">;
    const key = `${kind}:${Math.round(p.zone.kelvin / 100)}:${p.zone.emissiveI}:${p.ceilM.toFixed(2)}`;
    const b = buckets.get(key);
    if (b) b.items.push(p);
    else buckets.set(key, { kind, zone: p.zone, ceilM: p.ceilM, items: [p] });
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();

  for (const b of buckets) {
    const { kind, zone, ceilM, items } = b[1];
    const fit = getFitting(kind);
    // Hang from THIS space's finished ceiling, but never low enough to hit a
    // walking player.
    const mountY = Math.max(ceilM, minClearM + fit.dropM);
    const housing = new THREE.InstancedMesh(fit.housing, getHousingMaterial(), items.length);
    const face = new THREE.InstancedMesh(fit.face, getFaceMaterial(zone.kelvin, zone.emissiveI), items.length);
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      // model (x,y) → three (x, ·, −y); yaw about +Y matches atan2(dy,dx) there.
      q.setFromAxisAngle(up, p.yaw);
      pos.set(p.x, Math.min(mountY, ceilM), -p.y);
      m.compose(pos, q, one);
      housing.setMatrixAt(i, m);
      face.setMatrixAt(i, m);
    }
    housing.instanceMatrix.needsUpdate = true;
    face.instanceMatrix.needsUpdate = true;
    // Fittings never cast: they ARE the light source, and shadowing them against
    // the coverage spotlights would carve black rectangles out of the ceiling.
    housing.castShadow = false;
    housing.receiveShadow = true;
    face.castShadow = false;
    face.receiveShadow = false;
    meshes.push(housing, face);
  }

  // ---- real lights -----------------------------------------------------------
  // Spend the budget on the highest-weighted fittings, enforcing a minimum spacing
  // so one dense room can't hoard it. Sorting by weight×√area prefers important
  // zones AND large ones without letting either dominate outright.
  const ranked = [...placements].sort(
    (a, b2) => b2.zone.weight * Math.sqrt(b2.area) - a.zone.weight * Math.sqrt(a.area),
  );
  const chosen: Placement[] = [];
  for (const p of ranked) {
    if (chosen.length >= MAX_ZONE_LIGHTS) break;
    if (p.zone.weight <= 0) continue;
    let ok = true;
    for (const c of chosen) {
      if ((c.x - p.x) ** 2 + (c.y - p.y) ** 2 < LIGHT_MIN_SEP_M ** 2) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(p);
  }
  // Fall back to the plain ranked order if the separation filter starved the
  // budget (one small floor, everything within LIGHT_MIN_SEP_M of everything else).
  const finalPicks = chosen.length > 0 ? chosen : ranked.slice(0, MAX_ZONE_LIGHTS);

  // Intensity is SOLVED for a target, not hand-tuned, because hand-tuning it is
  // what produced a rig that was murky in one venue and blown out in the next.
  //
  // three.js uses physical units: a punctual light's irradiance at distance d is
  // intensity / d^decay, and the diffuse BRDF then multiplies by albedo/π. So the
  // linear value a floor of albedo A returns directly under a lamp at height h is
  //
  //     L = (intensity / h^decay) · A / π
  //
  // Solving for the intensity that lands a reference floor at a target level:
  //
  //     intensity = L_target · π · h^decay / A_ref
  //
  // Because h^decay is IN the formula, ceiling height compensates exactly — no
  // magic boost factor, no cap, and a 3 m office and a 12 m atrium both land on
  // target instead of one of them being wrong.
  const DECAY = 1.25;
  const TARGET_L = 0.3; // linear value a reference floor should read directly under a lamp
  const REF_ALBEDO = 0.3; // mid-grey; the venue floor materials sit near this
  // `finalPicks` is already ordered by weight x sqrt(area), so the first few are
  // the lamps over the most important, largest spaces — exactly where a cast
  // shadow buys the most.
  for (let i = 0; i < finalPicks.length; i++) {
    const p = finalPicks[i];
    // Solved PER LAMP against the height of the space it hangs in, so a 2.8 m
    // office and a 7 m gaming hall both land on target.
    const h = Math.max(2, p.ceilM - 0.4);
    const solved = (TARGET_L * Math.PI * Math.pow(h, DECAY)) / REF_ALBEDO;
    // A DOWNLIGHT, not a bare bulb. A PointLight 0.4 m under a ceiling delivers
    // intensity/0.4^decay to the plane it hangs from — roughly 3x what it puts on
    // the floor 6 m below — so every ceiling in the venue clipped to flat white
    // and lost its coffers, tile grid and cove entirely. A downward spot with a
    // wide cone excludes the soffit above it, which is also what a real recessed
    // or pendant fitting does. Same cost: these never cast shadows (the shadow
    // budget belongs to the coverage cones).
    const light = new THREE.SpotLight(
      kelvinColor(p.zone.kelvin),
      solved * p.zone.weight,
      // Reach far enough to overlap neighbours at LIGHT_MIN_SEP_M spacing, so the
      // floor between two lamps doesn't fall into a hole.
      Math.max(40, h * 8),
      1.25, // ≈72° half-angle: a broad wash, not a theatre special
      0.75, // soft edge, so the pools blend instead of showing hard circles
      DECAY,
    );
    light.position.set(p.x, h, -p.y);
    light.target.position.set(p.x, 0, -p.y);
    if (i < MAX_SHADOW_CASTERS) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = Math.max(20, h * 4);
      // A wide cone over a big room spreads 2048 texels thin, so the bias has to
      // be generous or the floor self-shadows into acne. normalBias handles the
      // grazing angles a near-vertical lamp creates across a large flat plate.
      light.shadow.bias = -0.0006;
      light.shadow.normalBias = 0.05;
      // Soften: a real luminaire is an area source, and a hard-edged shadow from
      // a point is one of the tells this whole pass is trying to remove.
      light.shadow.radius = 4;
    } else {
      light.castShadow = false;
    }
    lights.push(light);
    // A SpotLight aims at its target's WORLD position, so the target must be in
    // the scene graph or every lamp silently aims at the origin instead.
    lights.push(light.target);
  }

  return { meshes, lights };
}

/**
 * The always-on base rig: the ambient terms that keep every surface readable
 * regardless of where the bounded real lights landed.
 *
 * Venue-primary levels. The previous rig ran cool and dim on purpose so the
 * coverage cones dominated; these are tuned for a lit interior instead. The
 * hemisphere carries most of it (sky = the lit ceiling plane, ground = the floor
 * bounce), the ambient fills the last of the shadow, and a straight-down
 * directional supplies a soft key with no distance falloff so far corners of a
 * 200 m concourse read as well as the spot the player is standing in.
 */
// Base-rig levels, budgeted rather than guessed. Ambient and hemisphere feed the
// indirect diffuse term DIRECTLY (no 1/π), while the directional goes through the
// BRDF and is divided by π — so a nominally "1.35" directional contributes about a
// seventh of what a "1.35" hemisphere does. Ignoring that asymmetry is how the
// first pass at this ended up with a floor sitting at ~0.83 linear (near-white
// after ACES) before a single lamp was placed. Budget: these four terms should sum
// to roughly 0.3 on a 0.3-albedo surface, leaving the zone lamps room to create
// pools of light instead of adding to an already-clipped image.
const AMBIENT_I = 0.3;
const HEMI_I = 0.55;
const FILL_I = 1.6; // ÷π through the BRDF ⇒ ≈0.5 effective

export function buildBaseRig(): THREE.Object3D[] {
  const ambient = new THREE.AmbientLight(0xb9c2d4, AMBIENT_I);
  const hemi = new THREE.HemisphereLight(0xd8dcea, 0x3a3630, HEMI_I);
  const fill = new THREE.DirectionalLight(0xf2eee6, FILL_I);
  fill.position.set(0.25, 10, 0.18); // very slightly off-vertical so verticals shade
  fill.target.position.set(0, 0, 0);
  // fill.target must be IN the scene graph or the directional light aims at the
  // world origin's default rather than the target's position.
  return [ambient, hemi, fill, fill.target];
}

/** Dispose every cached fitting geometry and shared material. Call ONCE from the
 *  renderer's dispose(), alongside disposeMaterials() / disposeFixtureModels(). */
export function disposeLighting(): void {
  for (const f of fittingCache.values()) {
    f.housing.dispose();
    f.face.dispose();
  }
  fittingCache.clear();
  housingMat?.dispose();
  housingMat = null;
  for (const m of faceCache.values()) m.dispose();
  faceCache.clear();
}
