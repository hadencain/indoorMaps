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
  /** Authored ceiling height of this floor, metres. Absent ⇒ 3.2
   *  (DEFAULT_CEILING_M in render.ts — the value UNIT_HEIGHT_M has always
   *  synthesized for full-height categories), so a legacy building renders
   *  identically. Optional + additive: persistence stays v3. */
  ceilingM?: number;
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

/** How an opening is BUILT, as distinct from what it CONNECTS (`kind`). Routing
 *  and the nav graph care only about `kind`; this drives the 3D architecture —
 *  how wide the hole in the wall is, how tall, and what furniture fills it.
 *  - "door"       single leaf in a frame (offices, restrooms, back of house)
 *  - "double"     pair of leaves (entrances, service corridors)
 *  - "opening"    cased opening, no leaf — one room flowing into another
 *  - "storefront" full-height glazed shopfront with mullions and a signage band
 *  - "gate"       wide unglazed portal (loading, concourse threshold) */
export type OpeningStyle = "door" | "double" | "opening" | "storefront" | "gate";

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
  /** Construction style. Absent ⇒ DERIVED from `kind` plus the host unit's
   *  category (see `resolveOpeningStyle`, render.ts) — a retail unit's door
   *  becomes a storefront, an office's stays a single leaf. Deriving rather than
   *  requiring the field is what lets every shipped venue and every existing save
   *  gain real architecture with no data migration. Optional + additive:
   *  persistence stays v3. */
  style?: OpeningStyle;
  /** Clear width of the hole, metres. Absent ⇒ the style's default, clamped to
   *  leave a jamb at each end of the host wall. */
  widthM?: number;
  /** Head height of the hole above the floor, metres. Absent ⇒ the style's
   *  default, clamped under the level ceiling. */
  heightM?: number;
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

/** A CAD linework layer imported from a DXF file, kept as a per-floor vector
 *  underlay to trace over (Phase B DXF import). `polylines` are already
 *  scaled to metres and translated into the building's local-metre frame —
 *  same representation dxf.ts produces. Additive; defaults to [] in
 *  loadBuilding, same pattern as `underlays` (raster). */
export interface VectorUnderlay {
  ordinal: number;
  name: string;
  polylines: MetreXY[][];
  opacity: number; // 0..1
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
  /** Tilt in degrees BELOW horizontal for fixed/ptz cameras. When set, the
   *  visible footprint becomes an annular band on the floor (tilting up sees
   *  farther but opens a near-field blind hole under the mount; tilting down
   *  pulls the band in close) — see `tiltBand` in coverage.ts. Optional +
   *  additive: undefined = legacy planar wedge (full sector from the camera),
   *  which keeps every existing demo and save rendering unchanged. Ignored for
   *  domes (overhead 360° view). */
  tiltDeg?: number;
  /** Lens height above the floor slab, metres. Absent ⇒ MOUNT_H (4) — the
   *  constant `tiltBand` (coverage.ts) has always assumed — so legacy coverage
   *  is bit-identical. Optional + additive: persistence stays v3. */
  mountM?: number;
  /** Roll about the optical axis, degrees CW looking along the view direction.
   *  Absent ⇒ 0. NEVER affects the 2D coverage footprint (decision OQ-1 in
   *  docs/3d-editor-spec.md) — it exists for the 3D walk view only. Optional +
   *  additive: persistence stays v3. */
  rollDeg?: number;
  /** Mount surface hint. Absent ⇒ "ceiling". Drives the 3D gizmo/snap
   *  behaviour only — never geometry. Optional + additive: persistence
   *  stays v3. */
  mount?: "ceiling" | "wall" | "column";
  /** Operator call-up number, unique across the WHOLE building (not per floor,
   *  so typing it can cross floors and "42" always means one camera). Assigned
   *  once and then never reshuffled — an operator memorises numbers, so a delete
   *  must not silently renumber everything after it. Optional + additive:
   *  persistence stays v3; buildings without numbers get them on first use. */
  opNumber?: number;
  /** Saved PTZ positions, slot 1 always Home. PTZ only — nothing else moves. */
  presets?: CameraPreset[];
  /** Vertical field of view in degrees. Present ⇒ overrides the derivation
   *  (tiltBand in coverage.ts consumes it for the 2D tilt band, the 3D frustum
   *  will too); absent ⇒ derived from `fovDeg` at a 16:9 sensor aspect (see
   *  vfovHalfRad in coverage.ts). Ignored for domes. Optional + additive:
   *  persistence stays v3. */
  vfovDeg?: number;

  // ---- device + service record ----------------------------------------------
  // A coverage map answers "what can be seen"; maintaining a plant also needs
  // "which box is it, where is it on the network, and is it working". All
  // optional + additive (persistence stays v3), and all stripped from the
  // public viewer export along with the rest of the camera record.

  /** Operational state. Absent ⇒ unknown/unspecified, NOT "online" — an
   *  unaudited plant should not read as healthy. */
  status?: "online" | "offline" | "fault" | "planned";
  /** Manufacturer + model, freeform (e.g. "Axis P3265-LVE"). */
  model?: string;
  /** Serial / asset tag, for the maintenance record. */
  serial?: string;
  /** Management IP or hostname. Distinct from `streamRef`, which is the media
   *  path — the same device is reached one way to configure, another to view. */
  ipAddress?: string;
  /** Sensor resolution in megapixels. With `fovDeg` and distance this is what
   *  decides whether coverage is merely detection or good enough to identify
   *  a face — pixel density, not just geometry. */
  resolutionMP?: number;
  /** ISO date (YYYY-MM-DD) the device went in. */
  installedOn?: string;
  /** ISO date (YYYY-MM-DD) it was last serviced — the field that drives a
   *  maintenance sweep. */
  lastServicedOn?: string;
  /** Free notes: mounting quirks, glare at dusk, obstruction, anything the
   *  next technician needs. */
  notes?: string;
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

/** Business category for an occupant (tenant). Coarse IMDF-ish buckets. */
export type OccupantCategory =
  | "retail"
  | "dining"
  | "services"
  | "entertainment"
  | "health"
  | "office"
  | "transit"
  | "other";

/** A tenant business occupying a unit. Separate from the Unit polygon (IMDF
 *  occupant → anchor → unit): the unit is the space ("Unit 214"), the occupant
 *  is the business inside it. 1:N per unit (kiosks in a concourse); a
 *  room-category unit with zero occupants is vacant — a real, queryable state.
 *  Additive + defaulted (persistence stays v3, same pattern as cameras). */
export interface Occupant {
  id: string;
  name: string; // display name ("Sunglass Hut")
  unitId: string; // the unit it occupies
  category: OccupantCategory;
  hours?: string; // freeform for v1 ("Mon–Sat 10–9")
  phone?: string;
  website?: string;
  logo?: string; // data URI, local-first
  /** Label/POI point inside the unit; unset ⇒ unit centroid (occupantAnchor). */
  anchor?: MetreXY;
}

/** Structure kinds: interior columns vs larger free-form obstacles. */
export type StructureKind = "column" | "obstacle";

/** A solid structural element on one floor — the anti-Fixture: structures
 *  ALWAYS occlude (fixtures never do). `polygon` is the canonical outline in
 *  local metres, open ring (Unit.polygon convention). `heightM` absent ⇒ the
 *  level's ceiling (levelCeilingM in render.ts). `baseM` absent ⇒ 0; baseM > 0
 *  models soffits/ducts you can walk under. `round` is an authoring hint only
 *  (lets the column tool re-edit centre/radius) — renderers ignore it and use
 *  `polygon`. Additive: persistence stays v3. */
export interface Structure {
  id: string;
  ordinal: number;
  kind: StructureKind;
  polygon: MetreXY[];
  heightM?: number;
  baseM?: number;
  round?: { center: MetreXY; radiusM: number };
}

/** A hole punched through one floor's slab — an atrium, a light well, the opening
 *  a pair of escalators rises through. `ordinal` is the floor whose FLOOR PLATE is
 *  cut (so a void on level 2 lets you look down into level 1, and gives level 1's
 *  ceiling an opening to look up through).
 *
 *  VISUAL ONLY, exactly like Fixture: a void does not change the nav graph, is not
 *  subtracted from coverage floor area, and never occludes a camera. It is the one
 *  piece of venue architecture that genuinely cannot be derived — nothing in a
 *  floor's unit polygons says "and this part isn't there" — which is why it needs
 *  a field rather than a heuristic. Additive + optional; persistence stays v3. */
export interface Void {
  id: string;
  ordinal: number;
  /** Outline in local metres, open ring (Unit.polygon convention). */
  polygon: MetreXY[];
}

/** The building outline for one floor — a floor-slab base + thick exterior wall,
 *  drawn beneath everything so the plan reads as an enclosed building. Visual
 *  only; coverage still measures the units. */
export interface Footprint {
  ordinal: number;
  polygon: MetreXY[];
}

/** Operator-facing site metadata (right edge panel in display mode): location
 *  photos + opening hours. Additive + optional — persistence stays v3, and it
 *  rides along in the building-file export like everything else. Photos are
 *  data: URIs, downscaled at import time to keep the persisted blob small. */
export interface SiteInfo {
  photos: string[];
  hours: string;
}

/** An operator preset: a hand-picked set of cameras viewed together as a
 *  feed wall — e.g. every camera along a delivery route, even when the
 *  mounts are nowhere near each other. `cameraIds` keeps insertion order
 *  (the order the operator built the route in). Additive + optional. */
export interface CameraView {
  id: string;
  name: string;
  cameraIds: string[];
}

/** A saved PTZ aim. Exactly the four values the joystick drives — enough to put
 *  a camera back on a shot, and nothing that would make a preset go stale if the
 *  building around it is edited. */
export interface PtzAim {
  heading: number;
  tiltDeg: number;
  fovDeg: number;
  rangeM: number;
}

/** A named PTZ position, recalled from the operator keypad.
 *
 *  SLOT 1 IS ALWAYS "Home" and is captured automatically the first time an
 *  operator moves a camera — it records the aim as authored, which is otherwise
 *  destroyed on first drag (operator PTZ mutates the real camera, a trade-off
 *  taken deliberately in security/ptz.ts). Without that snapshot there is no
 *  "original position" left to go back to. */
export interface CameraPreset extends PtzAim {
  id: string;
  name: string;
  /** 1–9. Recalled with Ctrl+<slot>. Slot 1 is reserved for Home. */
  slot: number;
}

export interface Building {
  /** SW origin of the local metre grid, as [lng, lat]. */
  origin: LngLat;
  /** Revision stamp for shipped demo data. When a demo's pristine building
   *  declares demoRev and a localStorage save forked from an older revision is
   *  loaded, the save is discarded and the pristine demo wins (demo edits are
   *  tour state, not user projects). Absent on user properties. Additive:
   *  persistence stays v3. */
  demoRev?: number;
  levels: Level[];
  units: Unit[];
  openings: Opening[];
  verticals: Vertical[];
  /** Placed CCTV cameras. Defaults to [] for legacy buildings (see loadBuilding). */
  cameras: Camera[];
  /** Optional raster floorplan underlays, at most one per ordinal (P11c). */
  underlays?: RasterUnderlay[];
  /** CAD linework underlays imported from DXF, one per floor per import
   *  (Phase B). Additive; defaults to [] for legacy buildings — a building
   *  with no CAD import loads unchanged, same pattern as `underlays`. */
  vectorUnderlays?: VectorUnderlay[];
  /** Incident annotation pins (P10). Additive; defaults to [] in loadBuilding. */
  incidents?: Incident[];
  /** Guard patrol paths (P10). Additive; defaults to [] in loadBuilding. */
  patrols?: PatrolPath[];
  /** Furniture/equipment for realism (tables, machines, bars…). Additive; visual. */
  fixtures?: Fixture[];
  /** Solid structural elements (columns, obstacles) — always occlude, unlike
   *  fixtures. Additive; defaults to [] in withBuildingDefaults. */
  structures?: Structure[];
  /** Per-floor building outline (floor slab + exterior wall). Additive; visual. */
  footprints?: Footprint[];
  /** Atria / light wells: holes through a floor's slab. Additive; visual. */
  voids?: Void[];
  /** Point-of-interest markers (restrooms, ATMs, exits…). Additive; visual. */
  amenities?: Amenity[];
  /** Tenant businesses linked to units (IMDF occupant). Additive; defaults to []. */
  occupants?: Occupant[];
  /** Site metadata for the operator console (photos, hours). Additive. */
  siteInfo?: SiteInfo;
  /** Operator camera presets (feed walls). Additive. */
  cameraViews?: CameraView[];
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
  structures: boolean; // columns/large obstacles
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
