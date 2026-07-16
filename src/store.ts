import { create } from "zustand";
import type {
  Building,
  MetreXY,
  Category,
  RasterUnderlay,
  Camera,
  CameraKind,
  SecurityLevel,
  LayerVisibility,
  Incident,
  IncidentKind,
  PatrolPath,
  Unit,
  AmenityKind,
  SiteInfo,
  Occupant,
} from "./types";
import { autoDoorsForRooms, doorForRoom, selectableUnits } from "./building";
import { defaultNameFor, isSpace } from "./categories";
import { parseSvgShapes } from "./svgImport";
import { buildingToGeoJSON, geoJSONToBuilding } from "./imdf";
import { buildingToIMDFArchive } from "./imdfArchive";
import { zipStore } from "./zip";
import { buildSecurityReport } from "./report";
import { buildCameraIndex, indexStats } from "./security/coverage-link";
import { suggestCameras, type Suggestion, type SuggestStats } from "./security/suggest";
import { buildGraph } from "./graph";
import { findRoute } from "./astar";
import {
  buildingFileText,
  buildingKey,
  isValidBuildingShape,
  migrateLegacyBuilding,
  parseBuildingFileText,
  withBuildingDefaults,
} from "./persistence";
import { DEMOS, DEFAULT_PROPERTY_ID, demoById } from "./demos";
import {
  loadUserProperties,
  newPropertyId,
  pristineBuildingKey,
  saveUserProperties,
  starterBuilding,
  type UserProperty,
} from "./properties";

// One-time migration: pre-gallery saves lived at the un-suffixed key and were
// always the casino. Must run before loadBuilding() reads the casino key.
migrateLegacyBuilding(localStorage);

export type Tool =
  | "select"
  | "rect"
  | "polygon"
  | "vertex"
  | "link"
  | "route"
  | "camera"
  | "incident"
  | "patrol"
  | "inspect"
  | "review";

/** The two top-level surfaces. `edit` is the authoring tool (draw/place/wire);
 *  `display` is the read-only operator console the security team runs on routine
 *  — no editing chrome, click-to-camera as the default interaction. */
export type Mode = "edit" | "display";

export const ALL_AMENITY_KINDS: AmenityKind[] = [
  "restroom", "atm", "exit", "info", "firstaid",
  "ticketing", "dining", "bar", "coatcheck", "smoking",
];

// Kept at v3 deliberately: cameras are additive + defaulted (see below), so
// legacy v3 payloads — including the raster underlays added under v3 — load
// unchanged. Bumping the key would discard the persisted building. Cameras
// migrate in-place via the `cameras: []` default in loadBuilding.
//
// Undo/redo (P12) is IN-MEMORY only: `past`/`future` are never persisted, so
// the persisted shape is unchanged and the key stays v3.
//
// Per-property key scheme + legacy migration live in persistence.ts (pure,
// storage-injected so they're node-testable without jsdom).
// Layer-visibility prefs live under their OWN key, never folded into the
// building payload (a shared GeoJSON export must not carry operator view prefs).
const LAYERS_KEY = "indoormaps:layers:v1";
// Operator/display prefs (current mode + which amenity kinds are shown). Own key
// so the display filter never rides along with a shared building export.
const DISPLAY_KEY = "indoormaps:display:v1";
// Setup-guide dismissal, per property. Own key — dismissal is a per-browser
// UI preference, never part of a shared building/GeoJSON export.
const GUIDE_KEY = "indoormaps:guide:v1";

type AmenityFilter = Record<AmenityKind, boolean>;
const allAmenities = (on: boolean): AmenityFilter => {
  const o = {} as AmenityFilter;
  for (const k of ALL_AMENITY_KINDS) o[k] = on;
  return o;
};
function loadDisplay(): { mode: Mode; amenityFilter: AmenityFilter; propertyId: string } {
  const base = { mode: "edit" as Mode, amenityFilter: allAmenities(true), propertyId: DEFAULT_PROPERTY_ID };
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { mode?: unknown; amenityFilter?: Record<string, unknown>; propertyId?: unknown };
      if (p.mode === "display" || p.mode === "edit") base.mode = p.mode;
      if (p.amenityFilter && typeof p.amenityFilter === "object")
        for (const k of ALL_AMENITY_KINDS)
          if (typeof p.amenityFilter[k] === "boolean") base.amenityFilter[k] = p.amenityFilter[k] as boolean;
      if (
        typeof p.propertyId === "string" &&
        (DEMOS.some((d) => d.id === p.propertyId) ||
          loadUserProperties(localStorage).some((u) => u.id === p.propertyId))
      )
        base.propertyId = p.propertyId;
    }
  } catch {
    /* fall through */
  }
  return base;
}
const DISPLAY0 = loadDisplay();

// Bounded snapshot history: cap the number of retained past/future buildings.
const HISTORY_LIMIT = 50;

export const DEFAULT_LAYERS: LayerVisibility = {
  cameras: true,
  coverage: true,
  blindSpots: false,
  accessZones: true,
  labels: true,
  routes: true,
  incidents: true,
  patrols: true,
  fixtures: true,
  amenities: true,
};

function loadLayers(): LayerVisibility {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (p && typeof p === "object") {
        const out = { ...DEFAULT_LAYERS };
        for (const k of Object.keys(DEFAULT_LAYERS) as (keyof LayerVisibility)[]) {
          if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
        }
        return out;
      }
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_LAYERS };
}

function loadGuideDismissed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GUIDE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (p && typeof p === "object") {
        const out: Record<string, boolean> = {};
        for (const k of Object.keys(p)) {
          if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
        }
        return out;
      }
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** The pristine building a property resets/falls back to: a demo's shipped
 *  data, or a user property's creation-time snapshot (pristineBuildingKey).
 *  A user property whose snapshot is missing/corrupt degrades to a blank
 *  starter — never another property's data. */
function pristineFor(propertyId: string): Building {
  if (DEMOS.some((d) => d.id === propertyId)) return demoById(propertyId).building;
  try {
    const raw = localStorage.getItem(pristineBuildingKey(propertyId));
    if (raw) {
      const b = JSON.parse(raw) as Building;
      if (isValidBuildingShape(b)) return withBuildingDefaults(b);
    }
  } catch {
    /* fall through */
  }
  return starterBuilding(null);
}

function loadBuilding(propertyId: string): Building {
  try {
    const raw = localStorage.getItem(buildingKey(propertyId));
    if (raw) {
      const b = JSON.parse(raw) as Building;
      // Validation is a pure predicate (isValidBuildingShape, persistence.ts) so
      // it's node-testable without jsdom. localStorage is user-controlled startup
      // input (hand-edited, quota-truncated, or from an older/incompatible build)
      // — a structurally-plausible but truncated blob must degrade to the
      // pristine demo, never brick startup.
      if (isValidBuildingShape(b)) {
        // Additive migration: legacy payloads predate some collections — default
        // them in place (persistence stays v3; shared with file import).
        return withBuildingDefaults(b);
      }
    }
  } catch {
    /* fall through */
  }
  return pristineFor(propertyId);
}

/** Default route endpoints for a building: first/last selectable unit (the
 *  same choice AppShell's self-heal effect makes). "" when the building has
 *  none — findRoute treats an unknown node id as "no route" (returns null),
 *  so an empty id renders as no route rather than crashing. */
function routeEndpointsFor(b: Building): { startId: string; goalId: string } {
  const rooms = selectableUnits(b);
  return {
    startId: rooms[0]?.id ?? "",
    goalId: rooms[rooms.length - 1]?.id ?? "",
  };
}

const CAM_DEFAULTS = { heading: 0, fovDeg: 90, rangeM: 8, kind: "fixed" as CameraKind };
let camSeq = 0;
let roomSeq = 0;
let incSeq = 0;
let patSeq = 0;
let viewSeq = 0;
let occSeq = 0;

/** Transient click-to-camera probe result. NOT persisted, NOT routed through
 *  `commit`/undo — pure session UI state. `cameraIds` are the cameras whose
 *  occlusion-clipped view contains `point`, ranked nearest-camera-first. */
export interface Probe {
  /** The clicked point (metres). The covering-camera ranking is DERIVED LIVE in
   *  InspectPanel from the current occlusion coverage — never stored, so it can
   *  never go stale after a camera/wall edit or undo. */
  point: MetreXY;
}

interface State {
  propertyId: string;
  /** User-created properties ("New property from image"). Registry only —
   *  buildings live under the normal per-property keys. */
  userProperties: UserProperty[];
  building: Building;
  // Undo/redo — bounded in-memory snapshot stacks of the `building` slice only.
  // NEVER persisted (session-only; reset on reload).
  past: Building[];
  future: Building[];
  activeTool: Tool;
  // Top-level surface: authoring vs read-only operator display.
  mode: Mode;
  // Which amenity kinds are shown (display-mode POI filter; also gates markers in edit).
  amenityFilter: AmenityFilter;
  // The patrol route currently emphasized on the map (others dimmed). Session-only.
  highlightedPatrolId: string | null;
  selectedId: string | null;
  selectedIds: string[];
  selectedCameraId: string | null;
  selectedIncidentId: string | null;
  incidentKind: IncidentKind;
  patrolDraft: MetreXY[] | null;
  // Transient click-to-camera probe (inspect tool). Session-only; never persisted.
  probe: Probe | null;
  // One-shot camera request from a sidebar panel (no map ref exists outside
  // MapView). MapView consumes it: eases to the point, then clears it.
  flyTarget: { center: MetreXY; ordinal: number } | null;
  // Ghost camera placements from "Suggest cameras" (camera tool). Session-only,
  // never persisted, never in undo history — only ACCEPTING one commits a
  // camera. Cleared on any context change (tool/floor/property/mode).
  suggestions: Suggestion[] | null;
  suggestStats: SuggestStats | null;
  // Patrol playback (display mode): a guard dot walks the route while the
  // floating camera window follows via probe updates. Session-only. The
  // ANIMATED position lives in the PatrolPlayback component (rAF + marker),
  // not here — only identity/paused/speed are state.
  patrolPlayback: { patrolId: string; playing: boolean; speed: number } | null;
  layers: LayerVisibility;
  ordinal: number;
  unit: "m" | "ft";
  showDims: boolean;
  showGrid: boolean;
  gridSize: number;
  linkKind: string;
  pendingLink: { id: string; ordinal: number } | null;
  startId: string;
  goalId: string;
  routeMode: "direct" | "egress";
  planWidth: number;
  importMsg: string | null;
  draftCategory: Category;
  searchQuery: string;
  /** Per-property setup-guide dismissal (propertyId -> dismissed), persisted. */
  guideDismissed: Record<string, boolean>;

  setTool: (t: Tool) => void;
  setMode: (m: Mode) => void;
  setProperty: (id: string) => void;
  createProperty: (name: string, underlay: RasterUnderlay | null) => void;
  deleteProperty: (id: string) => void;
  dismissGuide: (propertyId: string) => void;
  reopenGuide: (propertyId: string) => void;
  toggleAmenityKind: (k: AmenityKind) => void;
  setAllAmenityKinds: (on: boolean) => void;
  setHighlightedPatrol: (id: string | null) => void;
  setDraftCategory: (c: Category) => void;
  setOrdinal: (o: number) => void;
  setSelected: (id: string | null) => void;
  setUnit: (u: "m" | "ft") => void;
  toggleDims: () => void;
  toggleGrid: () => void;
  setGridSize: (n: number) => void;
  setLinkKind: (k: string) => void;
  setStart: (id: string) => void;
  setGoal: (id: string) => void;
  setRouteMode: (m: "direct" | "egress") => void;
  setPlanWidth: (n: number) => void;

  addRoom: (polygon: MetreXY[], ordinal: number) => void;
  /** Append a new level (next ordinal, default name), then switch to it. */
  addLevel: () => void;
  moveDoor: (doorId: string, at: MetreXY) => void;
  setOpeningKind: (openingId: string, kind: "door" | "entrance") => void;
  toggleOpeningKind: (openingId: string) => void;
  renameUnit: (id: string, name: string) => void;
  setCategory: (id: string, category: Category) => void;
  setSecurity: (id: string, level: SecurityLevel) => void;
  deleteUnit: (id: string) => void;
  moveVertex: (id: string, index: number, at: MetreXY) => void;
  deleteVertex: (id: string, index: number) => void;
  /** Replace a unit's whole polygon (edge drag commits through this). */
  setUnitPolygon: (id: string, polygon: MetreXY[]) => void;
  /** Insert a vertex on edge `edgeIndex` at an exact point (dbl-click an edge). */
  insertVertexAt: (id: string, edgeIndex: number, at: MetreXY) => void;
  /** Occupant CRUD (P2 data layer; Places UI arrives in P3). */
  addOccupant: (unitId: string) => void;
  updateOccupant: (id: string, patch: Partial<Omit<Occupant, "id">>) => void;
  deleteOccupant: (id: string) => void;
  /** Tenant swap: re-point to another unit; anchor resets (it was inside the old unit). */
  moveOccupant: (id: string, unitId: string) => void;
  /** null resets to the unit-centroid fallback. */
  setOccupantAnchor: (id: string, at: MetreXY | null) => void;
  linkUnit: (id: string) => void;
  deleteVertical: (a: string, b: string) => void;
  addCamera: (at: MetreXY, ordinal: number) => void;
  moveCamera: (id: string, at: MetreXY) => void;
  rotateCamera: (id: string, heading: number) => void;
  updateCamera: (id: string, patch: Partial<Omit<Camera, "id">>) => void;
  // PTZ hold-to-repeat: one snapshot for the whole gesture (beginCameraGesture),
  // then per-tick mutations that skip history/undo entirely (updateCameraLive).
  beginCameraGesture: () => void;
  updateCameraLive: (id: string, patch: Partial<Omit<Camera, "id">>) => void;
  deleteCamera: (id: string) => void;
  setSelectedCamera: (id: string | null) => void;
  runSuggestCameras: (targetPct: number, maxNew: number) => void;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string) => void;
  acceptAllSuggestions: () => void;
  clearSuggestions: () => void;
  setProbe: (p: Probe | null) => void;
  addIncident: (at: MetreXY, ordinal: number) => void;
  moveIncident: (id: string, at: MetreXY) => void;
  updateIncident: (id: string, patch: Partial<Pick<Incident, "kind" | "note">>) => void;
  deleteIncident: (id: string) => void;
  setIncidentKind: (k: IncidentKind) => void;
  setSelectedIncident: (id: string | null) => void;
  beginPatrol: (ordinal: number) => void;
  addPatrolPoint: (p: MetreXY) => void;
  commitPatrol: () => void;
  cancelPatrol: () => void;
  autoPatrol: (ordinal: number) => void;
  renamePatrol: (id: string, name: string) => void;
  deletePatrol: (id: string) => void;
  startPatrolPlayback: (id: string) => void;
  stopPatrolPlayback: () => void;
  togglePatrolPause: () => void;
  cyclePatrolSpeed: () => void;
  updateSiteInfo: (patch: Partial<SiteInfo>) => void;
  addCameraView: (name: string) => string;
  deleteCameraView: (id: string) => void;
  addCameraToView: (viewId: string, camId: string) => void;
  removeCameraFromView: (viewId: string, camId: string) => void;
  exportIMDFArchive: () => void;
  exportSecurityReport: () => void;
  exportCameraIndex: () => void;
  setLayer: (key: keyof LayerVisibility, on: boolean) => void;
  toggleLayer: (key: keyof LayerVisibility) => void;
  importSvgText: (text: string) => void;
  importRasterFile: (file: File) => Promise<void>;
  setUnderlayOpacity: (ordinal: number, v: number) => void;
  nudgeUnderlay: (ordinal: number, d: MetreXY) => void;
  setUnderlayWidth: (ordinal: number, widthM: number) => void;
  removeUnderlay: (ordinal: number) => void;
  exportGeoJSON: () => void;
  loadGeoJSONText: (text: string) => void;
  exportBuildingFile: () => void;
  importBuildingFileText: (text: string) => void;
  resetBuilding: () => void;

  // P12 undo/redo
  undo: () => void;
  redo: () => void;
  // P12 multi-select + bulk
  toggleSelected: (id: string) => void;
  selectMany: (ids: string[]) => void;
  clearSelection: () => void;
  bulkSetCategory: (ids: string[], c: Category) => void;
  bulkSetSecurity: (ids: string[], sec: Unit["security"]) => void;
  // P12 search
  setSearch: (q: string) => void;
  // P3 places UI: one-shot fly-to request
  requestFly: (center: MetreXY, ordinal: number) => void;
}

export const useStore = create<State>((set, get) => {
  // Single choke point for EVERY building-mutating action. Snapshots the current
  // building into `past`, applies the recipe, and clears `future` (any fresh edit
  // invalidates the redo stack). No-op guard: a recipe returning the same
  // reference takes no snapshot. UI-state side effects stay OUT of here — each
  // action does its own `set({...})` for those (see e.g. addCamera, deleteUnit).
  // Coalescing: keystroke-driven mutations pass a key ("rename-unit:<id>") so a
  // typing burst becomes ONE undo entry — a keyed commit within 1s of the
  // previous commit with the SAME key reuses its snapshot instead of pushing a
  // new one. Anything else (unkeyed commit, different key, undo/redo, property
  // switch) breaks the chain.
  let lastCommitKey: string | null = null;
  let lastCommitAt = 0;
  const breakCoalesce = () => {
    lastCommitKey = null;
  };
  const commit = (recipe: (b: Building) => Building, coalesceKey?: string) =>
    set((s) => {
      const next = recipe(s.building);
      if (next === s.building) return {};
      const fold =
        coalesceKey !== undefined &&
        coalesceKey === lastCommitKey &&
        // 2.5s idle window, not 1s: on large venues every keystroke rebuilds
        // ~10^3 map markers, so real inter-keystroke commit gaps exceed 1s
        // under load and a burst would fragment into several undo entries.
        Date.now() - lastCommitAt < 2500;
      lastCommitKey = coalesceKey ?? null;
      lastCommitAt = Date.now();
      if (fold) return { building: next, future: [] };
      const past = [...s.past, s.building].slice(-HISTORY_LIMIT);
      return { building: next, past, future: [] };
    });

  return {
    propertyId: DISPLAY0.propertyId,
    userProperties: loadUserProperties(localStorage),
    building: loadBuilding(DISPLAY0.propertyId),
    past: [],
    future: [],
    activeTool: DISPLAY0.mode === "display" ? "inspect" : "select",
    mode: DISPLAY0.mode,
    amenityFilter: DISPLAY0.amenityFilter,
    highlightedPatrolId: null,
    selectedId: null,
    selectedIds: [],
    selectedCameraId: null,
    selectedIncidentId: null,
    incidentKind: "trespass",
    patrolDraft: null,
    probe: null,
    suggestions: null,
    suggestStats: null,
    patrolPlayback: null,
    layers: loadLayers(),
    ordinal: 0,
    unit: "m",
    showDims: false,
    showGrid: false,
    gridSize: 1,
    linkKind: "Elevator",
    pendingLink: null,
    startId: "lobby",
    goalId: "lab",
    routeMode: "direct",
    planWidth: 40,
    importMsg: null,
    draftCategory: "room",
    searchQuery: "",
    flyTarget: null,
    guideDismissed: loadGuideDismissed(),

    setTool: (t) =>
      set((s) => ({
        activeTool: t,
        pendingLink: null,
        selectedCameraId: null,
        selectedIncidentId: null,
        // Entering the patrol tool arms an empty draft so a click starts drawing
        // immediately (no separate "Draw patrol" step); any other tool switch
        // abandons an in-progress draft.
        patrolDraft: t === "patrol" ? [] : null,
        // Any tool switch clears a transient probe (including leaving inspect).
        probe: null,
        // Ghost suggestions live only under the camera tool.
        suggestions: t === "camera" ? s.suggestions : null,
        suggestStats: t === "camera" ? s.suggestStats : null,
      })),
    // Switching surface. Entering display forces the inspect interaction
    // (click-to-camera) and drops any authoring selection/draft; returning to
    // edit resets to the select tool and clears display-only transient state.
    setMode: (m) =>
      set(() =>
        m === "display"
          ? {
              mode: m,
              activeTool: "inspect",
              selectedId: null,
              selectedIds: [],
              selectedIncidentId: null,
              patrolDraft: null,
              pendingLink: null,
              probe: null,
              suggestions: null,
              suggestStats: null,
              patrolPlayback: null,
            }
          : {
              mode: m,
              activeTool: "select",
              probe: null,
              selectedCameraId: null,
              highlightedPatrolId: null,
            },
      ),
    // Switch the demo property: flush any pending debounced persist under the
    // OLD property's key first (so the last edit actually lands), then load the
    // new property's building and reset every piece of session UI state that
    // could otherwise reference ids from the old building (selection, undo
    // history, in-progress drafts, the floor index, route endpoints). Endpoints
    // are derived from the NEW building in the SAME set() — never left stale
    // for a render waiting on AppShell's self-heal effect.
    setProperty: (id) => {
      breakCoalesce();
      const s = get();
      if (id === s.propertyId) return;
      flushPendingPersist();
      const building = loadBuilding(id);
      set({
        propertyId: id,
        building,
        ...routeEndpointsFor(building),
        ordinal: 0,
        probe: null,
        suggestions: null,
        suggestStats: null,
        patrolPlayback: null,
        selectedCameraId: null,
        selectedId: null,
        selectedIds: [],
        selectedIncidentId: null,
        patrolDraft: null,
        pendingLink: null,
        highlightedPatrolId: null,
        searchQuery: "",
        flyTarget: null,
        past: [],
        future: [],
      });
    },
    // Create a user property (New property from image). The calibrated
    // underlay — if any — is baked into BOTH the live building and the pristine
    // snapshot, so "Reset this property" restores the traced-over floorplan,
    // not a blank page. Switches to the new property in the same update.
    createProperty: (name, underlay) => {
      breakCoalesce();
      const s = get();
      flushPendingPersist();
      const trimmed = name.trim() || "Untitled property";
      const id = newPropertyId(trimmed, [
        ...DEMOS.map((d) => d.id),
        ...s.userProperties.map((u) => u.id),
      ]);
      const building = starterBuilding(underlay);
      const userProperties = [...s.userProperties, { id, name: trimmed }];
      saveUserProperties(localStorage, userProperties);
      persistBuilding(building, pristineBuildingKey(id));
      persistBuilding(building, buildingKey(id));
      set({
        userProperties,
        propertyId: id,
        building,
        ...routeEndpointsFor(building),
        // Calibration also sets the working plan width, so a follow-up SVG or
        // raster import on another floor lands at the same scale.
        planWidth: underlay ? Math.max(1, Math.round(underlay.widthM)) : s.planWidth,
        ordinal: 0,
        probe: null,
        suggestions: null,
        suggestStats: null,
        patrolPlayback: null,
        selectedCameraId: null,
        selectedId: null,
        selectedIds: [],
        selectedIncidentId: null,
        patrolDraft: null,
        pendingLink: null,
        highlightedPatrolId: null,
        searchQuery: "",
        past: [],
        future: [],
        importMsg: null,
      });
    },

    // Delete a USER property (demos are not deletable). Switch away first if
    // it's active — setProperty flushes any pending debounced persist under the
    // old key, so removal below can't be resurrected by a late write.
    deleteProperty: (id) => {
      const s = get();
      if (!s.userProperties.some((u) => u.id === id)) return;
      if (s.propertyId === id) get().setProperty(DEFAULT_PROPERTY_ID);
      try {
        localStorage.removeItem(buildingKey(id));
        localStorage.removeItem(pristineBuildingKey(id));
      } catch {
        /* storage unavailable — registry removal below still hides it */
      }
      const userProperties = get().userProperties.filter((u) => u.id !== id);
      saveUserProperties(localStorage, userProperties);
      set({ userProperties });
    },

    dismissGuide: (propertyId) =>
      set((s) => ({ guideDismissed: { ...s.guideDismissed, [propertyId]: true } })),
    reopenGuide: (propertyId) =>
      set((s) => {
        const next = { ...s.guideDismissed };
        delete next[propertyId];
        return { guideDismissed: next };
      }),

    toggleAmenityKind: (k) => set((s) => ({ amenityFilter: { ...s.amenityFilter, [k]: !s.amenityFilter[k] } })),
    setAllAmenityKinds: (on) => set({ amenityFilter: allAmenities(on) }),
    setHighlightedPatrol: (id) => set((s) => ({ highlightedPatrolId: s.highlightedPatrolId === id ? null : id })),
    setDraftCategory: (c) => set({ draftCategory: c }),
    // Floor change clears floor-scoped transient state: a probe/selected camera
    // resolved on the old floor is meaningless on the new one (stale ranking /
    // false-empty "Covers" otherwise).
    setOrdinal: (o) =>
      set({
        ordinal: o,
        probe: null,
        selectedCameraId: null,
        selectedIncidentId: null,
        // Suggestions are floor-scoped ghosts; a floor change orphans them.
        suggestions: null,
        suggestStats: null,
        patrolPlayback: null,
      }),
    setSelected: (id) =>
      set({
        selectedId: id,
        selectedIds: id ? [id] : [],
        selectedCameraId: null,
        selectedIncidentId: null,
      }),
    setUnit: (u) => set({ unit: u }),
    toggleDims: () => set((s) => ({ showDims: !s.showDims })),
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    setGridSize: (n) => set({ gridSize: Math.min(20, Math.max(0.25, n || 1)) }),
    setLinkKind: (k) => set({ linkKind: k }),
    setStart: (id) => set({ startId: id }),
    setGoal: (id) => set({ goalId: id }),
    setRouteMode: (m) => set({ routeMode: m }),
    setPlanWidth: (n) => set({ planWidth: Math.max(1, n || 1) }),

    addRoom: (polygon, ord) => {
      const id = `room-${Date.now()}-${roomSeq++}`;
      const category = get().draftCategory;
      commit((b) => {
        const name = defaultNameFor(category, b);
        const door = doorForRoom(b, polygon, ord);
        const withUnit: Building = {
          ...b,
          units: [...b.units, { id, ordinal: ord, name, category, polygon }],
          openings: door
            ? [...b.openings, { id: `d-${id}`, unit: id, at: door }]
            : b.openings,
        };
        // Adding a corridor to a floor that already has doorless rooms
        // (from-scratch authoring order) would otherwise strand them with
        // no door and no UI to add one after the fact.
        if (category !== "corridor") return withUnit;
        const retro = autoDoorsForRooms(withUnit, ord);
        if (retro.length === 0) return withUnit;
        return {
          ...withUnit,
          openings: [
            ...withUnit.openings,
            ...retro.map((r) => ({ id: `d-${r.unit}`, unit: r.unit, at: r.at })),
          ],
        };
      });
    },

    addLevel: () => {
      const next = Math.max(...get().building.levels.map((l) => l.ordinal)) + 1;
      commit((b) => ({
        ...b,
        levels: [...b.levels, { ordinal: next, name: `Floor ${b.levels.length + 1}` }],
      }));
      get().setOrdinal(next);
    },

    moveDoor: (doorId, at) =>
      commit((b) => ({
        ...b,
        openings: b.openings.map((o) => (o.id === doorId ? { ...o, at } : o)),
      })),

    setOpeningKind: (openingId, kind) =>
      commit((b) => ({
        ...b,
        openings: b.openings.map((o) => (o.id === openingId ? { ...o, kind } : o)),
      })),

    toggleOpeningKind: (openingId) =>
      commit((b) => ({
        ...b,
        openings: b.openings.map((o) =>
          o.id === openingId
            ? { ...o, kind: o.kind === "entrance" ? "door" : "entrance" }
            : o,
        ),
      })),

    renameUnit: (id, name) =>
      commit(
        (b) => ({
          ...b,
          units: b.units.map((u) => (u.id === id ? { ...u, name } : u)),
        }),
        `rename-unit:${id}`,
      ),

    setCategory: (id, category) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (u.id === id ? { ...u, category } : u)),
      })),

    setSecurity: (id, level) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (u.id === id ? { ...u, security: level } : u)),
      })),

    deleteUnit: (id) => {
      commit((b) => ({
        ...b,
        units: b.units.filter((u) => u.id !== id),
        openings: b.openings.filter((o) => o.unit !== id),
        verticals: b.verticals.filter((v) => v.a !== id && v.b !== id),
        occupants: (b.occupants ?? []).filter((o) => o.unitId !== id),
      }));
      set((s) => ({
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => x !== id),
      }));
    },

    moveVertex: (id, index, at) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) =>
          u.id === id ? { ...u, polygon: u.polygon.map((p, i) => (i === index ? at : p)) } : u,
        ),
      })),

    deleteVertex: (id, index) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) =>
          u.id === id && u.polygon.length > 3
            ? { ...u, polygon: u.polygon.filter((_, i) => i !== index) }
            : u,
        ),
      })),

    setUnitPolygon: (id, polygon) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (u.id === id ? { ...u, polygon } : u)),
      })),

    insertVertexAt: (id, edgeIndex, at) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) => {
          if (u.id !== id) return u;
          const polygon = [...u.polygon];
          polygon.splice(edgeIndex + 1, 0, at);
          return { ...u, polygon };
        }),
      })),

    addOccupant: (unitId) => {
      const id = `occ-${Date.now()}-${occSeq++}`;
      const occ: Occupant = { id, name: "New occupant", unitId, category: "retail" };
      commit((b) => ({ ...b, occupants: [...(b.occupants ?? []), occ] }));
    },

    updateOccupant: (id, patch) =>
      commit(
        (b) => ({
          ...b,
          occupants: (b.occupants ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)),
        }),
        `occ:${id}:${Object.keys(patch).sort().join(",")}`,
      ),

    deleteOccupant: (id) =>
      commit((b) => ({
        ...b,
        occupants: (b.occupants ?? []).filter((o) => o.id !== id),
      })),

    moveOccupant: (id, unitId) =>
      commit((b) => ({
        ...b,
        occupants: (b.occupants ?? []).map((o) =>
          o.id === id ? { ...o, unitId, anchor: undefined } : o,
        ),
      })),

    setOccupantAnchor: (id, at) =>
      commit((b) => ({
        ...b,
        occupants: (b.occupants ?? []).map((o) =>
          o.id === id ? { ...o, anchor: at ?? undefined } : o,
        ),
      })),

    linkUnit: (id) => {
      const s = get();
      const u = s.building.units.find((x) => x.id === id);
      if (!u) return;
      set({ selectedId: id, selectedIds: [id] });
      if (!s.pendingLink) {
        set({ pendingLink: { id, ordinal: u.ordinal } });
        return;
      }
      if (s.pendingLink.id === id || s.pendingLink.ordinal === u.ordinal) {
        set({ pendingLink: { id, ordinal: u.ordinal } });
        return;
      }
      const a = s.pendingLink.id;
      const b = id;
      const cat: Category = s.linkKind === "Stairs" ? "stairs" : "elevator";
      const linkKind = s.linkKind;
      const exists = s.building.verticals.some(
        (v) => (v.a === a && v.b === b) || (v.a === b && v.b === a),
      );
      set({ pendingLink: null });
      // Only commit an undo entry when we actually ADD a vertical; the
      // pending-link-only branches above stay plain `set` (picking the first unit
      // is not an undoable edit).
      if (exists) return;
      commit((bl) => ({
        ...bl,
        units: bl.units.map((x) =>
          x.id === a || x.id === b ? { ...x, category: cat } : x,
        ),
        verticals: [...bl.verticals, { a, b, name: linkKind }],
      }));
    },

    deleteVertical: (a, b) =>
      commit((bl) => ({
        ...bl,
        verticals: bl.verticals.filter((v) => !(v.a === a && v.b === b)),
      })),

    addCamera: (at, ord) => {
      const s = get();
      const id = `cam-${Date.now()}-${camSeq++}`;
      const n = s.building.cameras.filter((c) => c.ordinal === ord).length + 1;
      const cam: Camera = { id, ordinal: ord, at, name: `Camera ${n}`, ...CAM_DEFAULTS };
      commit((b) => ({ ...b, cameras: [...b.cameras, cam] }));
      set({ selectedCameraId: id });
    },

    moveCamera: (id, at) =>
      commit((b) => ({
        ...b,
        cameras: b.cameras.map((c) => (c.id === id ? { ...c, at } : c)),
      })),

    rotateCamera: (id, heading) =>
      commit((b) => ({
        ...b,
        cameras: b.cameras.map((c) =>
          c.id === id ? { ...c, heading: ((heading % 360) + 360) % 360 } : c,
        ),
      })),

    updateCamera: (id, patch) =>
      commit((b) => ({
        ...b,
        cameras: b.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),

    // Exists so a held PTZ sweep is one undo step: called once on gesture start
    // (pointerdown), it takes exactly the snapshot `commit` would take, without
    // touching `building` — the ticks that follow use updateCameraLive instead.
    beginCameraGesture: () =>
      set((s) => ({ past: [...s.past, s.building].slice(-HISTORY_LIMIT), future: [] })),

    // Exists so a held PTZ sweep is one undo step: per-tick mutation during a
    // gesture (after beginCameraGesture already snapshotted). Same normalization
    // as rotateCamera/updateCamera, but a plain `set` — no history push.
    updateCameraLive: (id, patch) =>
      set((s) => ({
        building: {
          ...s.building,
          cameras: s.building.cameras.map((c) =>
            c.id === id
              ? {
                  ...c,
                  ...patch,
                  ...(patch.heading !== undefined
                    ? { heading: ((patch.heading % 360) + 360) % 360 }
                    : {}),
                }
              : c,
          ),
        },
      })),

    deleteCamera: (id) => {
      commit((b) => ({ ...b, cameras: b.cameras.filter((c) => c.id !== id) }));
      set((s) => (s.selectedCameraId === id ? { selectedCameraId: null } : {}));
    },

    setSelectedCamera: (id) =>
      set(
        id
          ? { selectedCameraId: id, selectedId: null, selectedIds: [], selectedIncidentId: null }
          : { selectedCameraId: null },
      ),

    // Transient — never routed through commit/undo, never persisted.
    setProbe: (p) => set({ probe: p }),

    // ---- Suggest cameras (ghost placements) ----
    // Plans against the CURRENT building + floor, seeded with the existing
    // plant. Synchronous — the planner is grid-bounded and runs in well under
    // a second on every demo floor.
    runSuggestCameras: (targetPct, maxNew) => {
      const s = get();
      const result = suggestCameras(s.building, s.ordinal, targetPct, maxNew);
      set({
        suggestions: result.suggestions,
        suggestStats: result.stats,
        selectedCameraId: null,
      });
    },

    // Accept ONE ghost: commits that camera (undoable), keeps the rest ghosted.
    acceptSuggestion: (id) => {
      const s = get();
      const sugg = s.suggestions?.find((x) => x.cam.id === id);
      if (!sugg) return;
      commit((b) => ({ ...b, cameras: [...b.cameras, sugg.cam] }));
      const rest = (get().suggestions ?? []).filter((x) => x.cam.id !== id);
      set({ suggestions: rest.length > 0 ? rest : null, suggestStats: rest.length > 0 ? get().suggestStats : null });
    },

    rejectSuggestion: (id) => {
      const rest = (get().suggestions ?? []).filter((x) => x.cam.id !== id);
      set({ suggestions: rest.length > 0 ? rest : null, suggestStats: rest.length > 0 ? get().suggestStats : null });
    },

    // Accept the whole plan as ONE undo step.
    acceptAllSuggestions: () => {
      const suggs = get().suggestions;
      if (!suggs || suggs.length === 0) return;
      const cams = suggs.map((x) => x.cam);
      commit((b) => ({ ...b, cameras: [...b.cameras, ...cams] }));
      set({ suggestions: null, suggestStats: null });
    },

    clearSuggestions: () => set({ suggestions: null, suggestStats: null }),

    // ---- P10 incidents ----
    addIncident: (at, ordinal) => {
      const id = `inc-${Date.now()}-${incSeq++}`;
      const kind = get().incidentKind;
      const incident: Incident = { id, ordinal, at, kind, note: "" };
      commit((b) => ({ ...b, incidents: [...(b.incidents ?? []), incident] }));
      set({ selectedIncidentId: id, selectedId: null, selectedIds: [], selectedCameraId: null });
    },

    moveIncident: (id, at) =>
      commit((b) => ({
        ...b,
        incidents: (b.incidents ?? []).map((i) => (i.id === id ? { ...i, at } : i)),
      })),

    updateIncident: (id, patch) =>
      commit(
        (b) => ({
          ...b,
          incidents: (b.incidents ?? []).map((i) =>
            i.id === id ? { ...i, ...patch } : i,
          ),
        }),
        `incident:${id}:${Object.keys(patch).sort().join(",")}`,
      ),

    deleteIncident: (id) => {
      commit((b) => ({
        ...b,
        incidents: (b.incidents ?? []).filter((i) => i.id !== id),
      }));
      set((s) => (s.selectedIncidentId === id ? { selectedIncidentId: null } : {}));
    },

    setIncidentKind: (k) => set({ incidentKind: k }),
    setSelectedIncident: (id) =>
      set(
        id
          ? { selectedIncidentId: id, selectedId: null, selectedIds: [], selectedCameraId: null }
          : { selectedIncidentId: null },
      ),

    // ---- P10 patrols ----
    beginPatrol: () => set({ patrolDraft: [] }),
    addPatrolPoint: (p) =>
      set((s) => ({ patrolDraft: [...(s.patrolDraft ?? []), p] })),

    commitPatrol: () => {
      const s = get();
      const draft = s.patrolDraft;
      if (!draft || draft.length < 2) {
        set({ patrolDraft: null });
        return;
      }
      const id = `patrol-${Date.now()}-${patSeq++}`;
      const n = (s.building.patrols ?? []).length + 1;
      const patrol: PatrolPath = { id, ordinal: s.ordinal, name: `Patrol ${n}`, points: draft };
      commit((b) => ({ ...b, patrols: [...(b.patrols ?? []), patrol] }));
      set({ patrolDraft: null });
    },

    cancelPatrol: () => set({ patrolDraft: null }),

    autoPatrol: (ordinal) => {
      // Graph-following patrol: visit every room on the floor in a greedy tour
      // ordered by NAV-GRAPH cost (not straight-line distance), and materialize
      // each leg along the actual A* path (room -> door -> corridor -> door ->
      // room), so the route follows the building's circulation instead of cutting
      // through walls.
      const s = get();
      const rooms = s.building.units.filter(
        (u) => u.ordinal === ordinal && isSpace(u.category) && u.category !== "outside",
      );
      if (rooms.length < 2) return;
      // Same door-without-corridor hazard as useRoute (see src/ui/route.ts):
      // buildGraph throws if any floor has a door but no corridor. autoPatrol is
      // reachable straight from the UI (patrol tool), so guard it the same way —
      // no-op rather than crashing (and never persisting a broken commit).
      let graph;
      try {
        graph = buildGraph(s.building);
      } catch {
        return;
      }
      const ids = rooms.map((u) => u.id).filter((id) => graph.nodes.has(id));
      if (ids.length < 2) return;

      // Greedy nearest-neighbour by graph route cost (unreachable = Infinity).
      const used = new Set<string>([ids[0]]);
      const order: string[] = [ids[0]];
      let cur = ids[0];
      while (order.length < ids.length) {
        let best: string | null = null;
        let bestCost = Infinity;
        for (const id of ids) {
          if (used.has(id)) continue;
          const r = findRoute(graph, cur, id);
          if (r && r.cost < bestCost) {
            bestCost = r.cost;
            best = id;
          }
        }
        if (!best) break; // remaining rooms are unreachable on this floor
        used.add(best);
        order.push(best);
        cur = best;
      }

      // Concatenate each leg's node path into metre waypoints, keeping only nodes
      // on this floor and dropping the duplicated junction between legs.
      const points: MetreXY[] = [];
      const pushPt = (p: MetreXY) => {
        const last = points[points.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
      };
      for (let i = 0; i < order.length - 1; i++) {
        const r = findRoute(graph, order[i], order[i + 1]);
        if (!r) continue;
        for (const nid of r.path) {
          const node = graph.nodes.get(nid);
          if (node && node.ordinal === ordinal) pushPt(node.xy);
        }
      }
      if (points.length < 2) return;

      const id = `patrol-${Date.now()}-${patSeq++}`;
      const n = (s.building.patrols ?? []).length + 1;
      const patrol: PatrolPath = { id, ordinal, name: `Auto patrol ${n}`, points };
      commit((b) => ({ ...b, patrols: [...(b.patrols ?? []), patrol] }));
      set({ patrolDraft: null });
    },

    renamePatrol: (id, name) =>
      commit(
        (b) => ({
          ...b,
          patrols: (b.patrols ?? []).map((p) => (p.id === id ? { ...p, name } : p)),
        }),
        `rename-patrol:${id}`,
      ),

    deletePatrol: (id) => {
      commit((b) => ({
        ...b,
        patrols: (b.patrols ?? []).filter((p) => p.id !== id),
      }));
      set((s) => (s.patrolPlayback?.patrolId === id ? { patrolPlayback: null, probe: null } : {}));
    },

    // ---- Patrol playback (guard-tour verification) ----
    // Starting also highlights the route so the walked path is emphasized.
    // The probe (and with it the floating camera window) is driven by the
    // PatrolPlayback component as the dot moves.
    startPatrolPlayback: (id) =>
      set({
        patrolPlayback: { patrolId: id, playing: true, speed: 1 },
        highlightedPatrolId: id,
        selectedCameraId: null,
        probe: null,
      }),

    stopPatrolPlayback: () =>
      set({ patrolPlayback: null, probe: null, selectedCameraId: null }),

    togglePatrolPause: () =>
      set((s) =>
        s.patrolPlayback
          ? { patrolPlayback: { ...s.patrolPlayback, playing: !s.patrolPlayback.playing } }
          : {},
      ),

    // Guard walking speed multiplier: 1× → 2× → 4× → 1×.
    cyclePatrolSpeed: () =>
      set((s) =>
        s.patrolPlayback
          ? {
              patrolPlayback: {
                ...s.patrolPlayback,
                speed: s.patrolPlayback.speed >= 4 ? 1 : s.patrolPlayback.speed * 2,
              },
            }
          : {},
      ),

    // Site metadata (operator edge panel): photos + hours. Undoable and part of
    // the building blob, so it persists and exports with everything else.
    updateSiteInfo: (patch) =>
      commit(
        (b) => ({
          ...b,
          siteInfo: { photos: [], hours: "", ...b.siteInfo, ...patch },
        }),
        `siteinfo:${Object.keys(patch).sort().join(",")}`,
      ),

    // ---- Operator camera presets (feed walls) ----
    // Part of the building blob like siteInfo: undoable, persisted, exported.
    addCameraView: (name) => {
      const id = `view-${Date.now()}-${viewSeq++}`;
      const trimmed = name.trim() || `View ${((get().building.cameraViews ?? []).length + 1)}`;
      commit((b) => ({
        ...b,
        cameraViews: [...(b.cameraViews ?? []), { id, name: trimmed, cameraIds: [] }],
      }));
      return id;
    },

    deleteCameraView: (id) =>
      commit((b) => ({
        ...b,
        cameraViews: (b.cameraViews ?? []).filter((v) => v.id !== id),
      })),

    // Appends — cameraIds keeps the operator's insertion order (route order).
    // Adding a camera already in the view is a no-op (same reference ⇒ commit
    // takes no undo snapshot).
    addCameraToView: (viewId, camId) =>
      commit((b) => {
        const views = b.cameraViews ?? [];
        const v = views.find((x) => x.id === viewId);
        if (!v || v.cameraIds.includes(camId) || !b.cameras.some((c) => c.id === camId)) return b;
        return {
          ...b,
          cameraViews: views.map((x) =>
            x.id === viewId ? { ...x, cameraIds: [...x.cameraIds, camId] } : x,
          ),
        };
      }),

    removeCameraFromView: (viewId, camId) =>
      commit((b) => ({
        ...b,
        cameraViews: (b.cameraViews ?? []).map((x) =>
          x.id === viewId ? { ...x, cameraIds: x.cameraIds.filter((c) => c !== camId) } : x,
        ),
      })),

    // ---- P11 exports ----
    exportIMDFArchive: () => {
      const b = get().building;
      const blob = zipStore(buildingToIMDFArchive(b));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "building-imdf.zip";
      a.click();
      URL.revokeObjectURL(url);
      set({ importMsg: "Exported IMDF archive (building-imdf.zip)." });
    },

    exportSecurityReport: () => {
      const b = get().building;
      const md = buildSecurityReport(b);
      const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "security-report.md";
      a.click();
      URL.revokeObjectURL(url);
      set({ importMsg: "Exported security report (security-report.md)." });
    },

    // Space→camera index for the live VMS. Computed FRESH from the current
    // building (never a stored copy), so it always matches current coverage —
    // move/aim/add/delete a camera, re-export, and the index reflects it.
    exportCameraIndex: () => {
      const b = get().building;
      const index = buildCameraIndex(b);
      const stats = indexStats(index);
      const payload = {
        generatedFrom: "indoorMaps authoring tool",
        note: "Derived from occlusion-clipped camera coverage; regenerate on any coverage change.",
        stats,
        index,
      };
      const text = JSON.stringify(payload, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "camera-index.json";
      a.click();
      URL.revokeObjectURL(url);
      set({
        importMsg: `Exported camera index — ${stats.spaces} spaces, ${stats.gaps.length} gap(s)${stats.secureUnderCovered.length ? `, ${stats.secureUnderCovered.length} secure room(s) under 2 cams` : ""}.`,
      });
    },

    setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
    toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),

    importSvgText: (text) => {
      const shapes = parseSvgShapes(text);
      if (shapes.length === 0) {
        set({ importMsg: "No rect/polygon/path shapes found in that SVG." });
        return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const sh of shapes)
        for (const [sx, sy] of sh.points) {
          minX = Math.min(minX, sx); minY = Math.min(minY, sy);
          maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
        }
      const st0 = get();
      const ord = st0.ordinal;
      const scale = st0.planWidth / (maxX - minX || 1);
      const toMetre = ([sx, sy]: [number, number]): MetreXY => [
        (sx - minX) * scale,
        (maxY - sy) * scale,
      ];
      const stamp = Date.now();
      commit((b) => {
        const newUnits = shapes.map((sh, i) => ({
          id: `imp-${stamp}-${i}`,
          ordinal: ord,
          name: sh.name || `Imported ${i + 1}`,
          category: "room" as const,
          polygon: sh.points.map(toMetre),
        }));
        const openings = [...b.openings];
        const hasCorridor = b.units.some(
          (u) => u.category === "corridor" && u.ordinal === ord,
        );
        if (hasCorridor)
          for (const u of newUnits) {
            const d = doorForRoom(b, u.polygon, ord);
            if (d) openings.push({ id: `d-${u.id}`, unit: u.id, at: d });
          }
        return { ...b, units: [...b.units, ...newUnits], openings };
      });
      set({
        importMsg: `Imported ${shapes.length} shape${shapes.length === 1 ? "" : "s"}.`,
      });
    },

    importRasterFile: async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("bad image"));
        img.src = dataUrl;
      });
      const { ordinal: ord, planWidth } = get();
      const underlay: RasterUnderlay = {
        ordinal: ord,
        dataUrl,
        naturalW: dims.w,
        naturalH: dims.h,
        widthM: planWidth,
        offset: [0, 0],
        rotation: 0,
        opacity: 0.5,
      };
      commit((b) => {
        const rest = (b.underlays ?? []).filter((u) => u.ordinal !== ord);
        return { ...b, underlays: [...rest, underlay] };
      });
      set({ importMsg: `Imported floorplan image (${dims.w}×${dims.h}px).` });
    },

    setUnderlayOpacity: (ordinal, v) =>
      commit((b) => ({
        ...b,
        underlays: (b.underlays ?? []).map((u) =>
          u.ordinal === ordinal ? { ...u, opacity: Math.min(1, Math.max(0, v)) } : u,
        ),
      })),

    nudgeUnderlay: (ordinal, d) =>
      commit((b) => ({
        ...b,
        underlays: (b.underlays ?? []).map((u) =>
          u.ordinal === ordinal
            ? { ...u, offset: [u.offset[0] + d[0], u.offset[1] + d[1]] as MetreXY }
            : u,
        ),
      })),

    setUnderlayWidth: (ordinal, widthM) =>
      commit((b) => ({
        ...b,
        underlays: (b.underlays ?? []).map((u) =>
          u.ordinal === ordinal ? { ...u, widthM: Math.max(1, widthM || 1) } : u,
        ),
      })),

    removeUnderlay: (ordinal) =>
      commit((b) => ({
        ...b,
        underlays: (b.underlays ?? []).filter((u) => u.ordinal !== ordinal),
      })),

    exportGeoJSON: () => {
      const b = get().building;
      const text = JSON.stringify(buildingToGeoJSON(b), null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "building.geojson";
      a.click();
      URL.revokeObjectURL(url);
      set({ importMsg: `Exported ${b.units.length} units as GeoJSON.` });
    },

    loadGeoJSONText: (text) => {
      const loaded = geoJSONToBuilding(text);
      if (!loaded) {
        set({ importMsg: "Not an indoorMaps GeoJSON export (missing metadata)." });
        return;
      }
      commit(() => loaded);
      set({
        selectedId: null,
        selectedIds: [],
        selectedCameraId: null,
        selectedIncidentId: null,
        patrolDraft: null,
        importMsg: `Loaded ${loaded.units.length} units.`,
      });
    },

    // Full-fidelity save: the EXACT persisted building shape in a file envelope
    // (persistence.ts). Unlike the GeoJSON/IMDF exports, nothing is projected or
    // dropped — incidents, patrols, fixtures, amenities, security levels and
    // underlays all round-trip. "Hand someone the file and say: here it is."
    exportBuildingFile: () => {
      const s = get();
      const text = buildingFileText(s.building, s.propertyId);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${s.propertyId}.building.json`;
      a.click();
      URL.revokeObjectURL(url);
      set({ importMsg: `Saved building file (${s.propertyId}.building.json).` });
    },

    // Counterpart to exportBuildingFile: replaces the ACTIVE property's building
    // (undoable — routed through commit, and the persist subscription writes it
    // under the active property's key). Route endpoints re-derive from the new
    // building in the same update; floor resets to 0 (the file's levels may not
    // include the current ordinal).
    importBuildingFileText: (text) => {
      const parsed = parseBuildingFileText(text);
      if (!parsed) {
        set({ importMsg: "Not a valid building file (expected a Save-building-file export)." });
        return;
      }
      const building = parsed.building as unknown as Building;
      commit(() => building);
      set({
        ...routeEndpointsFor(building),
        ordinal: 0,
        selectedId: null,
        selectedIds: [],
        selectedCameraId: null,
        selectedIncidentId: null,
        patrolDraft: null,
        pendingLink: null,
        highlightedPatrolId: null,
        probe: null,
        suggestions: null,
        suggestStats: null,
        patrolPlayback: null,
        importMsg: `Loaded building file — ${building.units.length} units, ${building.cameras.length} cameras.`,
      });
    },

    // Reset the ACTIVE property to its pristine state (a demo's shipped data,
    // or a user property's creation-time snapshot). Route endpoints re-derive
    // from that building in the same update, never left stale.
    resetBuilding: () => {
      const demo = pristineFor(get().propertyId);
      commit(() => demo);
      set({
        ...routeEndpointsFor(demo),
        selectedId: null,
        selectedIds: [],
        selectedCameraId: null,
        selectedIncidentId: null,
        patrolDraft: null,
        suggestions: null,
        suggestStats: null,
        patrolPlayback: null,
        importMsg: null,
      });
    },

    // ---- P12 undo/redo ----
    // Move a snapshot between past/future and swap it in as `building`. Both
    // clear ALL selections: reverted geometry may drop ids the current selection
    // references (a deleted-then-undone unit, a redone delete, etc.).
    undo: () => {
      breakCoalesce();
      set((s) => {
        if (s.past.length === 0) return {};
        const prev = s.past[s.past.length - 1];
        const patch: any = {
          building: prev,
          past: s.past.slice(0, -1),
          future: [s.building, ...s.future].slice(0, HISTORY_LIMIT),
          selectedId: null,
          selectedIds: [],
          selectedCameraId: null,
          selectedIncidentId: null,
        };
        // Clamp ordinal to an existing level if the current one was deleted.
        if (!prev.levels.some((l) => l.ordinal === s.ordinal)) {
          patch.ordinal = prev.levels[0]?.ordinal ?? 0;
        }
        return patch;
      });
    },

    redo: () => {
      breakCoalesce();
      set((s) => {
        if (s.future.length === 0) return {};
        const next = s.future[0];
        const patch: any = {
          building: next,
          past: [...s.past, s.building].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          selectedId: null,
          selectedIds: [],
          selectedCameraId: null,
          selectedIncidentId: null,
        };
        // Clamp ordinal to an existing level if the current one was deleted.
        if (!next.levels.some((l) => l.ordinal === s.ordinal)) {
          patch.ordinal = next.levels[0]?.ordinal ?? 0;
        }
        return patch;
      });
    },

    // ---- P12 multi-select + bulk ----
    // Shift-click toggle: add/remove `id` from the multi-selection. Keeps
    // `selectedId` as the "primary" (last-toggled-on, or the remaining one).
    toggleSelected: (id) =>
      set((s) => {
        const has = s.selectedIds.includes(id);
        const selectedIds = has
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id];
        return {
          selectedIds,
          selectedId: has
            ? (s.selectedId === id ? (selectedIds[selectedIds.length - 1] ?? null) : s.selectedId)
            : id,
          selectedCameraId: null,
          selectedIncidentId: null,
        };
      }),

    selectMany: (ids) =>
      set({
        selectedIds: ids,
        selectedId: ids[ids.length - 1] ?? null,
        selectedCameraId: null,
        selectedIncidentId: null,
      }),

    clearSelection: () => set({ selectedId: null, selectedIds: [] }),

    bulkSetCategory: (ids, c) => {
      const idSet = new Set(ids);
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (idSet.has(u.id) ? { ...u, category: c } : u)),
      }));
    },

    bulkSetSecurity: (ids, sec) => {
      const idSet = new Set(ids);
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (idSet.has(u.id) ? { ...u, security: sec } : u)),
      }));
    },

    // ---- P12 search ----
    setSearch: (q) => set({ searchQuery: q }),

    // ---- P3 places UI: fly-to ----
    requestFly: (center, ordinal) => set({ flyTarget: { center, ordinal } }),
  };
});

// Persist building to localStorage on change (validated shape, per-property v3 key).
//
// Only `s.building` is persisted — `past`/`future` are session-only history and
// never written (keeps localStorage small; undo does not survive reload).
//
// Guard: a large base64 underlay `dataUrl` can exceed the localStorage quota.
// Because the whole `building` persists as one blob, an oversized image would
// otherwise silently break persistence of the ENTIRE building (units included).
// So on quota failure we retry persisting a copy with each underlay `dataUrl`
// stripped to "" (metadata kept). Net: the building always persists; oversized
// underlay images are session-only and must be re-imported after reload.
function persistBuilding(building: Building, key: string) {
  try {
    localStorage.setItem(key, JSON.stringify(building));
  } catch {
    try {
      const stripped: Building = {
        ...building,
        underlays: building.underlays?.map((u) => ({ ...u, dataUrl: "" })),
      };
      localStorage.setItem(key, JSON.stringify(stripped));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }
}

// Debounced (trailing, ~400ms): a held PTZ sweep mutates `building` every
// 150ms via updateCameraLive — without this, that's a full-building
// JSON.stringify + localStorage write ~7x/sec. Write once per burst instead.
//
// `pendingPersistKey` is captured at SCHEDULE time (the property active when the
// edit happened), not re-read at fire time — a property switch mid-debounce
// must not let a pending write land under the NEW property's key. `setProperty`
// flushes any pending write (under the OLD key) before switching; see below.
let persistTimer: number | null = null;
let pendingPersistKey: string | null = null;

function flushPendingPersist() {
  if (persistTimer === null) return;
  window.clearTimeout(persistTimer);
  persistTimer = null;
  const key = pendingPersistKey;
  pendingPersistKey = null;
  if (key !== null) persistBuilding(useStore.getState().building, key);
}

useStore.subscribe((s, prev) => {
  if (s.building === prev.building) return;
  // setProperty's set() call changes BOTH `propertyId` and `building` (to the
  // just-loaded, unedited demo) in the same update — this subscription would
  // otherwise schedule a write of that pristine demo back under the NEW
  // property's key 400ms later, merely for having viewed it (pinning every demo
  // in the gallery and shadowing future demo-data commits). Detect that case by
  // comparing propertyId across (state, prevState) and skip scheduling; a real
  // edit made AFTER the switch changes only `building` (propertyId stays equal
  // to prev), so it falls through and persists normally.
  if (s.propertyId !== prev.propertyId) return;
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  pendingPersistKey = buildingKey(s.propertyId);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const key = pendingPersistKey;
    pendingPersistKey = null;
    if (key !== null) persistBuilding(useStore.getState().building, key);
  }, 400);
});

// The debounce trades write frequency for a data-loss window at unload —
// edit-then-refresh inside 400ms would silently drop the change, and
// localStorage is the ONLY persistence. Flush any pending write on pagehide.
window.addEventListener("pagehide", flushPendingPersist);

// Layer-visibility prefs persist under their own key, separate from the building.
useStore.subscribe((s, prev) => {
  if (s.layers === prev.layers) return;
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(s.layers));
  } catch {
    /* storage unavailable — non-fatal */
  }
});

// Setup-guide dismissal persists under its own key, separate from the building.
useStore.subscribe((s, prev) => {
  if (s.guideDismissed === prev.guideDismissed) return;
  try {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(s.guideDismissed));
  } catch {
    /* storage unavailable — non-fatal */
  }
});

// Display prefs (mode + amenity-kind filter + active property) persist under
// their own key.
useStore.subscribe((s, prev) => {
  if (s.mode === prev.mode && s.amenityFilter === prev.amenityFilter && s.propertyId === prev.propertyId) return;
  try {
    localStorage.setItem(
      DISPLAY_KEY,
      JSON.stringify({ mode: s.mode, amenityFilter: s.amenityFilter, propertyId: s.propertyId }),
    );
  } catch {
    /* storage unavailable — non-fatal */
  }
});
