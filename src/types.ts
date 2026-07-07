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
  security?: "public" | "secure" | "restricted";
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
