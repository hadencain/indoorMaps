// IMDF-flavored data model (simplified for the viewer-core spike).
// Real IMDF is a set of GeoJSON FeatureCollections per feature type
// (venue, building, level, unit, opening, ...). We keep the same *concepts*
// — levels with an ordinal, units (rooms/corridors), openings (doors),
// and vertical connections — authored in local metres and projected to lng/lat.

export type LngLat = [number, number];
export type MetreXY = [number, number];

export type Category =
  // structural / circulation (existing)
  | "room"
  | "corridor"
  | "elevator"
  | "stairs"
  // cosmetic spaces (new — semantic + fill color only)
  | "office"
  | "restroom"
  | "lobby"
  | "retail"
  | "storage"
  | "mechanical"
  // behavioral (new)
  | "outside"; // walkable exterior region

export interface Level {
  ordinal: number;
  name: string;
}

/** Access-control classification for a unit. Absent ⇒ treated as "public". */
export type SecurityLevel = "public" | "secure" | "restricted";

export interface Unit {
  id: string;
  ordinal: number;
  name: string;
  category: Category;
  /**
   * Access level. Absent is treated as "public". `restricted` is non-routable
   * (excluded from the nav graph — see `isNonRoutable` in categories.ts).
   * Access is an attribute orthogonal to `category` (a restricted office is
   * `{ category: "office", security: "restricted" }`).
   */
  security?: SecurityLevel;
  /** Polygon outline in local metres, as an open ring (no repeated last point). */
  polygon: MetreXY[];
}

/** A door or entrance. `at` is a point on the owning unit's wall.
 *  - "door"     (default): connects `unit` to the corridor on the same ordinal.
 *  - "entrance": connects `unit` to the nearest outside area on the same ordinal
 *    (an opening on the building envelope).
 *  `kind` is optional; `undefined` is treated as `"door"` everywhere, so every
 *  existing opening and every persisted `v3` building / prior GeoJSON export
 *  remains valid with no migration. */
export interface Opening {
  id: string;
  unit: string;
  at: MetreXY;
  kind?: "door" | "entrance";
}

/** A stair/elevator run connecting two units across ordinals. */
export interface Vertical {
  a: string;
  b: string;
  name: string;
}

/** A raster floorplan image anchored beneath the vector layers on one floor.
 *  User-provided local file → data URI (no network). One optional image per
 *  ordinal; adjustable width/position/opacity in the underlay controls. */
export interface RasterUnderlay {
  ordinal: number;
  dataUrl: string; // data: URI (may be "" if stripped from persistence — re-import after reload)
  naturalW: number; // image pixel dimensions, for aspect
  naturalH: number;
  widthM: number; // real-world width of the image span, metres
  offset: MetreXY; // SW corner offset from building origin, metres
  rotation: number; // degrees CCW, default 0
  opacity: number; // 0..1, default 0.5
}

/** CCTV camera kind.
 *  - "fixed" = static sector (a wedge at a fixed heading).
 *  - "dome"  = 360° sight; `fovDeg`/`heading` are ignored (treated as full circle).
 *  - "ptz"   = pan/tilt/zoom; geometrically identical to `fixed` for a static
 *    coverage snapshot, flagged visually as sweeping. */
export type CameraKind = "fixed" | "dome" | "ptz";

/** A placed CCTV camera. Position/aim authored in local metres; coverage is
 *  derived (never stored). Heading is degrees from +x (map-east), CCW positive,
 *  so `heading°` maps directly onto `Math.atan2(dy, dx)` with no conversion. */
export interface Camera {
  id: string;
  ordinal: number; // floor the camera lives on (mirrors Unit.ordinal)
  at: MetreXY; // position in local metres
  heading: number; // degrees, from +x axis, CCW positive (atan2-native)
  fovDeg: number; // horizontal field of view in degrees; ignored when kind === "dome"
  rangeM: number; // useful sight range in metres (hard cap on sightline length)
  kind: CameraKind;
  name: string;
  /** Freeform device/stream reference (RTSP URL, NVR channel, device id, …).
   *  The live-console app resolves this to a real feed; the prototype only
   *  stores + echoes it. Optional + additive — persistence stays v3 (a camera
   *  with no `streamRef` loads unchanged; default undefined). */
  streamRef?: string;
}

/** What an incident annotation records. Drives the pin color + kind dropdown. */
export type IncidentKind =
  | "trespass"
  | "theft"
  | "vandalism"
  | "medical"
  | "hazard"
  | "alarm"
  | "other";

/** An annotation pin: something that happened at a point on a floor. Local
 *  metres, same frame as Unit.polygon / Opening.at. Additive optional
 *  collection on Building (persistence stays v3; defaults to []). */
export interface Incident {
  id: string;
  ordinal: number;
  at: MetreXY;
  kind: IncidentKind;
  note: string;
}

/** An ordered open polyline across a single floor — a hand-drawn or
 *  auto-generated guard path. NOT a nav-graph route. `points` has >= 2
 *  waypoints, open (no repeated last point), like Unit.polygon. */
export interface PatrolPath {
  id: string;
  ordinal: number;
  name: string;
  points: MetreXY[];
}

/** Furniture / equipment drawn on the floor for realism (IMDF "fixture"). Purely
 *  visual: fixtures are NOT units — they don't count as coverage floor, aren't
 *  route endpoints, and don't occlude cameras. `kind` drives the fill colour. */
export type FixtureKind =
  | "blackjack"
  | "roulette"
  | "poker"
  | "baccarat"
  | "slot"
  | "bar"
  | "counter"
  | "seating"
  | "stage"
  | "planter"
  | "parking"
  | "car"
  | "craps"
  | "wheel";

export interface Fixture {
  id: string;
  ordinal: number;
  kind: FixtureKind;
  /** Outline in local metres, open ring (like Unit.polygon). */
  polygon: MetreXY[];
}

/** A point-of-interest marker (IMDF "amenity"): restroom, ATM, exit, etc. Drives
 *  a small glyph badge on the map. Visual/wayfinding aid — not a unit. */
export type AmenityKind =
  | "restroom"
  | "atm"
  | "exit"
  | "info"
  | "firstaid"
  | "ticketing"
  | "dining"
  | "bar"
  | "coatcheck"
  | "smoking";

export interface Amenity {
  id: string;
  ordinal: number;
  at: MetreXY;
  kind: AmenityKind;
  name?: string;
}

/** The building outline for one floor — a floor-slab base + thick exterior wall,
 *  drawn beneath everything so the plan reads as an enclosed building. Visual
 *  only; coverage still measures the units. */
export interface Footprint {
  ordinal: number;
  polygon: MetreXY[];
}

export interface Building {
  /** SW origin of the local metre grid, as [lng, lat]. */
  origin: LngLat;
  levels: Level[];
  units: Unit[];
  openings: Opening[];
  verticals: Vertical[];
  /** Placed CCTV cameras. Defaults to [] for legacy buildings (see loadBuilding). */
  cameras: Camera[];
  /** Optional raster floorplan underlays, at most one per ordinal (P11c). */
  underlays?: RasterUnderlay[];
  /** Incident annotation pins (P10). Additive; defaults to [] in loadBuilding. */
  incidents?: Incident[];
  /** Guard patrol paths (P10). Additive; defaults to [] in loadBuilding. */
  patrols?: PatrolPath[];
  /** Furniture/equipment for realism (tables, machines, bars…). Additive; visual. */
  fixtures?: Fixture[];
  /** Per-floor building outline (floor slab + exterior wall). Additive; visual. */
  footprints?: Footprint[];
  /** Point-of-interest markers (restrooms, ATMs, exits…). Additive; visual. */
  amenities?: Amenity[];
}

/** Per-overlay visibility toggles (UI state; persisted separately from the
 *  building). No `grid` member — the grid row proxies the existing `showGrid`. */
export interface LayerVisibility {
  cameras: boolean; // camera markers + FOV cones
  coverage: boolean; // clipped coverage polygons
  blindSpots: boolean; // blind-spot fills
  accessZones: boolean; // secure/restricted perimeter + badge readers
  labels: boolean; // room name/area labels
  routes: boolean; // A* route line + pins
  incidents: boolean; // incident markers (Phase E)
  patrols: boolean; // patrol path lines (Phase E)
  fixtures: boolean; // furniture/equipment (tables, machines, bars…)
  amenities: boolean; // POI markers (restrooms, ATMs, exits…)
}

export interface NodeMeta {
  id: string;
  ordinal: number;
  xy: MetreXY;
  lnglat: LngLat;
  kind: "unit" | "door" | "entrance";
  name?: string;
  category?: Category;
}

export interface Edge {
  to: string;
  w: number;
}

export interface Graph {
  nodes: Map<string, NodeMeta>;
  adj: Map<string, Edge[]>;
}
