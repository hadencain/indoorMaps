import { create } from "zustand";
import type { Building, MetreXY, Category } from "./types";
import { initialBuilding, doorForRoom } from "./building";
import { parseSvgShapes } from "./svgImport";
import { buildingToGeoJSON, geoJSONToBuilding } from "./imdf";

export type Tool = "select" | "rect" | "polygon" | "vertex" | "link" | "route";

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
      if (ok) return b;
    }
  } catch {
    /* fall through */
  }
  return initialBuilding;
}

let roomSeq = 0;

interface State {
  building: Building;
  activeTool: Tool;
  selectedId: string | null;
  ordinal: number;
  unit: "m" | "ft";
  showDims: boolean;
  showGrid: boolean;
  gridSize: number;
  linkKind: string;
  pendingLink: { id: string; ordinal: number } | null;
  startId: string;
  goalId: string;
  planWidth: number;
  importMsg: string | null;

  setTool: (t: Tool) => void;
  setOrdinal: (o: number) => void;
  setSelected: (id: string | null) => void;
  setUnit: (u: "m" | "ft") => void;
  toggleDims: () => void;
  toggleGrid: () => void;
  setGridSize: (n: number) => void;
  setLinkKind: (k: string) => void;
  setStart: (id: string) => void;
  setGoal: (id: string) => void;
  setPlanWidth: (n: number) => void;

  addRoom: (polygon: MetreXY[], ordinal: number) => void;
  moveDoor: (doorId: string, at: MetreXY) => void;
  renameUnit: (id: string, name: string) => void;
  setCategory: (id: string, category: Category) => void;
  deleteUnit: (id: string) => void;
  moveVertex: (id: string, index: number, at: MetreXY) => void;
  insertVertex: (id: string, edgeIndex: number) => void;
  deleteVertex: (id: string, index: number) => void;
  linkUnit: (id: string) => void;
  deleteVertical: (a: string, b: string) => void;
  importSvgText: (text: string) => void;
  exportGeoJSON: () => void;
  loadGeoJSONText: (text: string) => void;
  resetBuilding: () => void;
}

export const useStore = create<State>((set, get) => ({
  building: loadBuilding(),
  activeTool: "select",
  selectedId: null,
  ordinal: 0,
  unit: "m",
  showDims: false,
  showGrid: false,
  gridSize: 1,
  linkKind: "Elevator",
  pendingLink: null,
  startId: "lobby",
  goalId: "lab",
  planWidth: 40,
  importMsg: null,

  setTool: (t) => set({ activeTool: t, pendingLink: null }),
  setOrdinal: (o) => set({ ordinal: o }),
  setSelected: (id) => set({ selectedId: id }),
  setUnit: (u) => set({ unit: u }),
  toggleDims: () => set((s) => ({ showDims: !s.showDims })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setGridSize: (n) => set({ gridSize: Math.min(20, Math.max(0.25, n || 1)) }),
  setLinkKind: (k) => set({ linkKind: k }),
  setStart: (id) => set({ startId: id }),
  setGoal: (id) => set({ goalId: id }),
  setPlanWidth: (n) => set({ planWidth: Math.max(1, n || 1) }),

  addRoom: (polygon, ord) =>
    set((s) => {
      const id = `room-${Date.now()}-${roomSeq++}`;
      const name = `Room ${s.building.units.filter((u) => u.category === "room").length + 1}`;
      const door = doorForRoom(s.building, polygon, ord);
      return {
        building: {
          ...s.building,
          units: [...s.building.units, { id, ordinal: ord, name, category: "room", polygon }],
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
    set({ building: loaded, selectedId: null, importMsg: `Loaded ${loaded.units.length} units.` });
  },

  resetBuilding: () =>
    set({
      building: initialBuilding,
      startId: "lobby",
      goalId: "lab",
      selectedId: null,
      importMsg: null,
    }),
}));

// Persist building to localStorage on change (validated shape, v3 key).
useStore.subscribe((s, prev) => {
  if (s.building !== prev.building) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.building));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }
});
