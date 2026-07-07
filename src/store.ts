import { create } from "zustand";
import type { Building, MetreXY, Category, RasterUnderlay, Camera, CameraKind } from "./types";
import { initialBuilding, doorForRoom } from "./building";
import { defaultNameFor } from "./categories";
import { parseSvgShapes } from "./svgImport";
import { buildingToGeoJSON, geoJSONToBuilding } from "./imdf";

export type Tool = "select" | "rect" | "polygon" | "vertex" | "link" | "route" | "camera";

// Kept at v3 deliberately: cameras are additive + defaulted (see below), so
// legacy v3 payloads — including the raster underlays added under v3 — load
// unchanged. Bumping the key would discard the persisted building. Cameras
// migrate in-place via the `cameras: []` default in loadBuilding.
const STORAGE_KEY = "indoormaps:building:v3";

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
        // Additive migration: legacy payloads predate cameras — default them.
        if (!Array.isArray(b.cameras)) b.cameras = [];
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

interface State {
  building: Building;
  activeTool: Tool;
  selectedId: string | null;
  selectedCameraId: string | null;
  showCoverage: boolean;
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
  setSecurity: (id: string, level: "public" | "secure" | "restricted") => void;
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
  toggleCoverage: () => void;
  importSvgText: (text: string) => void;
  importRasterFile: (file: File) => Promise<void>;
  setUnderlayOpacity: (ordinal: number, v: number) => void;
  nudgeUnderlay: (ordinal: number, d: MetreXY) => void;
  setUnderlayWidth: (ordinal: number, widthM: number) => void;
  removeUnderlay: (ordinal: number) => void;
  exportGeoJSON: () => void;
  loadGeoJSONText: (text: string) => void;
  resetBuilding: () => void;
}

export const useStore = create<State>((set, get) => ({
  building: loadBuilding(),
  activeTool: "select",
  selectedId: null,
  selectedCameraId: null,
  showCoverage: false,
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

  setTool: (t) => set({ activeTool: t, pendingLink: null, selectedCameraId: null }),
  setDraftCategory: (c) => set({ draftCategory: c }),
  setOrdinal: (o) => set({ ordinal: o }),
  setSelected: (id) => set({ selectedId: id, selectedCameraId: null }),
  setUnit: (u) => set({ unit: u }),
  toggleDims: () => set((s) => ({ showDims: !s.showDims })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setGridSize: (n) => set({ gridSize: Math.min(20, Math.max(0.25, n || 1)) }),
  setLinkKind: (k) => set({ linkKind: k }),
  setStart: (id) => set({ startId: id }),
  setGoal: (id) => set({ goalId: id }),
  setRouteMode: (m) => set({ routeMode: m }),
  setPlanWidth: (n) => set({ planWidth: Math.max(1, n || 1) }),

  addRoom: (polygon, ord) =>
    set((s) => {
      const id = `room-${Date.now()}-${roomSeq++}`;
      const category = s.draftCategory;
      const name = defaultNameFor(category, s.building);
      const door = doorForRoom(s.building, polygon, ord);
      return {
        building: {
          ...s.building,
          units: [...s.building.units, { id, ordinal: ord, name, category, polygon }],
          openings: door
            ? [...s.building.openings, { id: `d-${id}`, unit: id, at: door }]
            : s.building.openings,
        },
      };
    }),

  moveDoor: (doorId, at) =>
    set((s) => ({
      building: {
        ...s.building,
        openings: s.building.openings.map((o) => (o.id === doorId ? { ...o, at } : o)),
      },
    })),

  setOpeningKind: (openingId, kind) =>
    set((s) => ({
      building: {
        ...s.building,
        openings: s.building.openings.map((o) => (o.id === openingId ? { ...o, kind } : o)),
      },
    })),

  toggleOpeningKind: (openingId) =>
    set((s) => ({
      building: {
        ...s.building,
        openings: s.building.openings.map((o) =>
          o.id === openingId
            ? { ...o, kind: o.kind === "entrance" ? "door" : "entrance" }
            : o,
        ),
      },
    })),

  renameUnit: (id, name) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) => (u.id === id ? { ...u, name } : u)),
      },
    })),

  setCategory: (id, category) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) => (u.id === id ? { ...u, category } : u)),
      },
    })),

  setSecurity: (id, level) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) => (u.id === id ? { ...u, security: level } : u)),
      },
    })),

  deleteUnit: (id) =>
    set((s) => ({
      selectedId: s.selectedId === id ? null : s.selectedId,
      building: {
        ...s.building,
        units: s.building.units.filter((u) => u.id !== id),
        openings: s.building.openings.filter((o) => o.unit !== id),
        verticals: s.building.verticals.filter((v) => v.a !== id && v.b !== id),
      },
    })),

  moveVertex: (id, index, at) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) =>
          u.id === id ? { ...u, polygon: u.polygon.map((p, i) => (i === index ? at : p)) } : u,
        ),
      },
    })),

  insertVertex: (id, edgeIndex) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) => {
          if (u.id !== id) return u;
          const a = u.polygon[edgeIndex];
          const b = u.polygon[(edgeIndex + 1) % u.polygon.length];
          const mid: MetreXY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const polygon = [...u.polygon];
          polygon.splice(edgeIndex + 1, 0, mid);
          return { ...u, polygon };
        }),
      },
    })),

  deleteVertex: (id, index) =>
    set((s) => ({
      building: {
        ...s.building,
        units: s.building.units.map((u) =>
          u.id === id && u.polygon.length > 3
            ? { ...u, polygon: u.polygon.filter((_, i) => i !== index) }
            : u,
        ),
      },
    })),

  linkUnit: (id) => {
    const s = get();
    const u = s.building.units.find((x) => x.id === id);
    if (!u) return;
    set({ selectedId: id });
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
    set((st) => {
      const exists = st.building.verticals.some(
        (v) => (v.a === a && v.b === b) || (v.a === b && v.b === a),
      );
      if (exists) return { pendingLink: null };
      return {
        pendingLink: null,
        building: {
          ...st.building,
          units: st.building.units.map((x) =>
            x.id === a || x.id === b ? { ...x, category: cat } : x,
          ),
          verticals: [...st.building.verticals, { a, b, name: st.linkKind }],
        },
      };
    });
  },

  deleteVertical: (a, b) =>
    set((s) => ({
      building: {
        ...s.building,
        verticals: s.building.verticals.filter((v) => !(v.a === a && v.b === b)),
      },
    })),

  addCamera: (at, ord) =>
    set((s) => {
      const id = `cam-${Date.now()}-${camSeq++}`;
      const n = s.building.cameras.filter((c) => c.ordinal === ord).length + 1;
      const cam: Camera = { id, ordinal: ord, at, name: `Camera ${n}`, ...CAM_DEFAULTS };
      return {
        selectedCameraId: id,
        building: { ...s.building, cameras: [...s.building.cameras, cam] },
      };
    }),

  moveCamera: (id, at) =>
    set((s) => ({
      building: {
        ...s.building,
        cameras: s.building.cameras.map((c) => (c.id === id ? { ...c, at } : c)),
      },
    })),

  rotateCamera: (id, heading) =>
    set((s) => ({
      building: {
        ...s.building,
        cameras: s.building.cameras.map((c) =>
          c.id === id ? { ...c, heading: ((heading % 360) + 360) % 360 } : c,
        ),
      },
    })),

  updateCamera: (id, patch) =>
    set((s) => ({
      building: {
        ...s.building,
        cameras: s.building.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    })),

  deleteCamera: (id) =>
    set((s) => ({
      selectedCameraId: s.selectedCameraId === id ? null : s.selectedCameraId,
      building: { ...s.building, cameras: s.building.cameras.filter((c) => c.id !== id) },
    })),

  setSelectedCamera: (id) =>
    set(id ? { selectedCameraId: id, selectedId: null } : { selectedCameraId: null }),
  toggleCoverage: () => set((s) => ({ showCoverage: !s.showCoverage })),

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
    const s = get();
    const scale = s.planWidth / (maxX - minX || 1);
    const toMetre = ([sx, sy]: [number, number]): MetreXY => [
      (sx - minX) * scale,
      (maxY - sy) * scale,
    ];
    set((st) => {
      const stamp = Date.now();
      const newUnits = shapes.map((sh, i) => ({
        id: `imp-${stamp}-${i}`,
        ordinal: st.ordinal,
        name: sh.name || `Imported ${i + 1}`,
        category: "room" as const,
        polygon: sh.points.map(toMetre),
      }));
      const openings = [...st.building.openings];
      const hasCorridor = st.building.units.some(
        (u) => u.category === "corridor" && u.ordinal === st.ordinal,
      );
      if (hasCorridor)
        for (const u of newUnits) {
          const d = doorForRoom(st.building, u.polygon, st.ordinal);
          if (d) openings.push({ id: `d-${u.id}`, unit: u.id, at: d });
        }
      return {
        building: { ...st.building, units: [...st.building.units, ...newUnits], openings },
        importMsg: `Imported ${shapes.length} shape${shapes.length === 1 ? "" : "s"}.`,
      };
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
    set((s) => {
      const ord = s.ordinal;
      const underlay: RasterUnderlay = {
        ordinal: ord,
        dataUrl,
        naturalW: dims.w,
        naturalH: dims.h,
        widthM: s.planWidth,
        offset: [0, 0],
        rotation: 0,
        opacity: 0.5,
      };
      const rest = (s.building.underlays ?? []).filter((u) => u.ordinal !== ord);
      return {
        building: { ...s.building, underlays: [...rest, underlay] },
        importMsg: `Imported floorplan image (${dims.w}×${dims.h}px).`,
      };
    });
  },

  setUnderlayOpacity: (ordinal, v) =>
    set((s) => ({
      building: {
        ...s.building,
        underlays: (s.building.underlays ?? []).map((u) =>
          u.ordinal === ordinal ? { ...u, opacity: Math.min(1, Math.max(0, v)) } : u,
        ),
      },
    })),

  nudgeUnderlay: (ordinal, d) =>
    set((s) => ({
      building: {
        ...s.building,
        underlays: (s.building.underlays ?? []).map((u) =>
          u.ordinal === ordinal
            ? { ...u, offset: [u.offset[0] + d[0], u.offset[1] + d[1]] as MetreXY }
            : u,
        ),
      },
    })),

  setUnderlayWidth: (ordinal, widthM) =>
    set((s) => ({
      building: {
        ...s.building,
        underlays: (s.building.underlays ?? []).map((u) =>
          u.ordinal === ordinal ? { ...u, widthM: Math.max(1, widthM || 1) } : u,
        ),
      },
    })),

  removeUnderlay: (ordinal) =>
    set((s) => ({
      building: {
        ...s.building,
        underlays: (s.building.underlays ?? []).filter((u) => u.ordinal !== ordinal),
      },
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
    set({
      building: loaded,
      selectedId: null,
      selectedCameraId: null,
      importMsg: `Loaded ${loaded.units.length} units.`,
    });
  },

  resetBuilding: () =>
    set({
      building: initialBuilding,
      startId: "lobby",
      goalId: "lab",
      selectedId: null,
      selectedCameraId: null,
      importMsg: null,
    }),
}));

// Persist building to localStorage on change (validated shape, v3 key).
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
