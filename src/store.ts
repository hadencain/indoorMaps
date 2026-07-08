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
} from "./types";
import { initialBuilding, doorForRoom } from "./building";
import { defaultNameFor, isSpace } from "./categories";
import { parseSvgShapes } from "./svgImport";
import { buildingToGeoJSON, geoJSONToBuilding } from "./imdf";
import { buildingToIMDFArchive } from "./imdfArchive";
import { zipStore } from "./zip";
import { buildSecurityReport } from "./report";
import { buildGraph } from "./graph";
import { findRoute } from "./astar";

export type Tool =
  | "select"
  | "rect"
  | "polygon"
  | "vertex"
  | "link"
  | "route"
  | "camera"
  | "incident"
  | "patrol";

// Kept at v3 deliberately: cameras are additive + defaulted (see below), so
// legacy v3 payloads — including the raster underlays added under v3 — load
// unchanged. Bumping the key would discard the persisted building. Cameras
// migrate in-place via the `cameras: []` default in loadBuilding.
//
// Undo/redo (P12) is IN-MEMORY only: `past`/`future` are never persisted, so
// the persisted shape is unchanged and the key stays v3.
const STORAGE_KEY = "indoormaps:building:v3";
// Layer-visibility prefs live under their OWN key, never folded into the
// building payload (a shared GeoJSON export must not carry operator view prefs).
const LAYERS_KEY = "indoormaps:layers:v1";

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

function loadBuilding(): Building {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const b = JSON.parse(raw) as Building;
      const ok =
        Array.isArray(b.units) &&
        Array.isArray(b.levels) &&
        Array.isArray(b.openings) &&
        b.units.every((u) => Array.isArray(u.polygon)) &&
        b.openings.every((o) => typeof o.id === "string");
      if (ok) {
        // Additive migration: legacy payloads predate these collections — default
        // them in place (persistence stays v3; same pattern as cameras/underlays).
        if (!Array.isArray(b.cameras)) b.cameras = [];
        if (!Array.isArray(b.incidents)) b.incidents = [];
        if (!Array.isArray(b.patrols)) b.patrols = [];
        return b;
      }
    }
  } catch {
    /* fall through */
  }
  return initialBuilding;
}

const CAM_DEFAULTS = { heading: 0, fovDeg: 90, rangeM: 8, kind: "fixed" as CameraKind };
let camSeq = 0;
let roomSeq = 0;
let incSeq = 0;
let patSeq = 0;

interface State {
  building: Building;
  // Undo/redo — bounded in-memory snapshot stacks of the `building` slice only.
  // NEVER persisted (session-only; reset on reload).
  past: Building[];
  future: Building[];
  activeTool: Tool;
  selectedId: string | null;
  selectedIds: string[];
  selectedCameraId: string | null;
  selectedIncidentId: string | null;
  incidentKind: IncidentKind;
  patrolDraft: MetreXY[] | null;
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

  setTool: (t: Tool) => void;
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
  moveDoor: (doorId: string, at: MetreXY) => void;
  setOpeningKind: (openingId: string, kind: "door" | "entrance") => void;
  toggleOpeningKind: (openingId: string) => void;
  renameUnit: (id: string, name: string) => void;
  setCategory: (id: string, category: Category) => void;
  setSecurity: (id: string, level: SecurityLevel) => void;
  deleteUnit: (id: string) => void;
  moveVertex: (id: string, index: number, at: MetreXY) => void;
  insertVertex: (id: string, edgeIndex: number) => void;
  deleteVertex: (id: string, index: number) => void;
  linkUnit: (id: string) => void;
  deleteVertical: (a: string, b: string) => void;
  addCamera: (at: MetreXY, ordinal: number) => void;
  moveCamera: (id: string, at: MetreXY) => void;
  rotateCamera: (id: string, heading: number) => void;
  updateCamera: (id: string, patch: Partial<Omit<Camera, "id">>) => void;
  deleteCamera: (id: string) => void;
  setSelectedCamera: (id: string | null) => void;
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
  exportIMDFArchive: () => void;
  exportSecurityReport: () => void;
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
}

export const useStore = create<State>((set, get) => {
  // Single choke point for EVERY building-mutating action. Snapshots the current
  // building into `past`, applies the recipe, and clears `future` (any fresh edit
  // invalidates the redo stack). No-op guard: a recipe returning the same
  // reference takes no snapshot. UI-state side effects stay OUT of here — each
  // action does its own `set({...})` for those (see e.g. addCamera, deleteUnit).
  const commit = (recipe: (b: Building) => Building) =>
    set((s) => {
      const next = recipe(s.building);
      if (next === s.building) return {};
      const past = [...s.past, s.building].slice(-HISTORY_LIMIT);
      return { building: next, past, future: [] };
    });

  return {
    building: loadBuilding(),
    past: [],
    future: [],
    activeTool: "select",
    selectedId: null,
    selectedIds: [],
    selectedCameraId: null,
    selectedIncidentId: null,
    incidentKind: "trespass",
    patrolDraft: null,
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

    setTool: (t) =>
      set({
        activeTool: t,
        pendingLink: null,
        selectedCameraId: null,
        selectedIncidentId: null,
        // Entering the patrol tool arms an empty draft so a click starts drawing
        // immediately (no separate "Draw patrol" step); any other tool switch
        // abandons an in-progress draft.
        patrolDraft: t === "patrol" ? [] : null,
      }),
    setDraftCategory: (c) => set({ draftCategory: c }),
    setOrdinal: (o) => set({ ordinal: o }),
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
        return {
          ...b,
          units: [...b.units, { id, ordinal: ord, name, category, polygon }],
          openings: door
            ? [...b.openings, { id: `d-${id}`, unit: id, at: door }]
            : b.openings,
        };
      });
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
      commit((b) => ({
        ...b,
        units: b.units.map((u) => (u.id === id ? { ...u, name } : u)),
      })),

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

    insertVertex: (id, edgeIndex) =>
      commit((b) => ({
        ...b,
        units: b.units.map((u) => {
          if (u.id !== id) return u;
          const a = u.polygon[edgeIndex];
          const bb = u.polygon[(edgeIndex + 1) % u.polygon.length];
          const mid: MetreXY = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2];
          const polygon = [...u.polygon];
          polygon.splice(edgeIndex + 1, 0, mid);
          return { ...u, polygon };
        }),
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
      commit((b) => ({
        ...b,
        incidents: (b.incidents ?? []).map((i) =>
          i.id === id ? { ...i, ...patch } : i,
        ),
      })),

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
      const graph = buildGraph(s.building);
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
      commit((b) => ({
        ...b,
        patrols: (b.patrols ?? []).map((p) => (p.id === id ? { ...p, name } : p)),
      })),

    deletePatrol: (id) =>
      commit((b) => ({
        ...b,
        patrols: (b.patrols ?? []).filter((p) => p.id !== id),
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

    resetBuilding: () => {
      commit(() => initialBuilding);
      set({
        startId: "lobby",
        goalId: "lab",
        selectedId: null,
        selectedIds: [],
        selectedCameraId: null,
        selectedIncidentId: null,
        patrolDraft: null,
        importMsg: null,
      });
    },

    // ---- P12 undo/redo ----
    // Move a snapshot between past/future and swap it in as `building`. Both
    // clear ALL selections: reverted geometry may drop ids the current selection
    // references (a deleted-then-undone unit, a redone delete, etc.).
    undo: () =>
      set((s) => {
        if (s.past.length === 0) return {};
        const prev = s.past[s.past.length - 1];
        return {
          building: prev,
          past: s.past.slice(0, -1),
          future: [s.building, ...s.future].slice(0, HISTORY_LIMIT),
          selectedId: null,
          selectedIds: [],
          selectedCameraId: null,
          selectedIncidentId: null,
        };
      }),

    redo: () =>
      set((s) => {
        if (s.future.length === 0) return {};
        const next = s.future[0];
        return {
          building: next,
          past: [...s.past, s.building].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          selectedId: null,
          selectedIds: [],
          selectedCameraId: null,
          selectedIncidentId: null,
        };
      }),

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
  };
});

// Persist building to localStorage on change (validated shape, v3 key).
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
function persistBuilding(building: Building) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(building));
  } catch {
    try {
      const stripped: Building = {
        ...building,
        underlays: building.underlays?.map((u) => ({ ...u, dataUrl: "" })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }
}

useStore.subscribe((s, prev) => {
  if (s.building !== prev.building) persistBuilding(s.building);
});

// Layer-visibility prefs persist under their own key, separate from the building.
useStore.subscribe((s, prev) => {
  if (s.layers === prev.layers) return;
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(s.layers));
  } catch {
    /* storage unavailable — non-fatal */
  }
});
