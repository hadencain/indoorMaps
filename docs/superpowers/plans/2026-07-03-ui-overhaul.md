# indoorMaps UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 11-section sidebar with a contextual pro-tool UI (rail + inspector + top/status bars) on a Zustand store, at feature parity.

**Architecture:** A single `activeTool` enum drives a left icon rail and a right contextual inspector. Global state moves from `App.tsx` `useState` into one Zustand store; `MapView` and all new UI components read the store instead of drilling props. The imperative MapLibre engine in `MapView` is behaviorally untouched — only its data source changes. Build in a way that keeps the app working: migrate state first (UI unchanged), build new components unmounted, then swap the shell in one task.

**Tech Stack:** Vite + React + TypeScript, MapLibre GL, Zustand (state), lucide-react (icons), self-hosted Geist fonts (fontsource).

## Global Constraints

- **Feature parity — no new capabilities.** Every current behavior must keep working identically (see §5 of the spec). This plan re-houses and restyles; it does not add features.
- **Stack stays Vite + React.** No Next.js.
- **No runtime network requests.** Fonts self-hosted via fontsource; map style stays empty. Verifiable in the Network tab.
- **Verification pattern:** each task ends build-passing (`npm run build` = `tsc -b && vite build`) and, where behavior changes, a manual check against the running app (`npm run dev`, localhost:5173). No automated test harness exists; do not add one.
- **Commit style:** author `hadencain <hadencain@users.noreply.github.com>`; message body only; no Co-Authored-By/AI trailers.
- **Existing pure modules are frozen:** `geo.ts`, `graph.ts`, `astar.ts`, `render.ts`, `format.ts`, `svgImport.ts`, `imdf.ts`, `building.ts`, `types.ts` — reuse, do not rewrite. `MapView`'s map logic is reused; only its state source changes.
- **Colors/type from spec §3:** canvas `#0b0d10`, panels `#0d1116`, border `#1e2733`, text `#e8e8e8`, dim `#8a96a5`, accent `#00d7cd`, danger `#ff5c5c`; category fills room `#171f2b` / corridor `#1a2230` / elevator `#0e3b3a` / stairs `#3a2e14`. Geist Sans (UI) + Geist Mono (data), tabular figures on metrics.

---

## File structure

**Create:**
- `src/store.ts` — Zustand store: all domain + UI state, actions, persistence.
- `src/ui/tokens.css` — CSS custom properties (color/space/type tokens).
- `src/ui/AppShell.tsx` — five-zone CSS-grid layout.
- `src/ui/TopBar.tsx` — wordmark + `FloorPills` + `DataMenu`.
- `src/ui/ToolRail.tsx` — tool buttons bound to `activeTool`.
- `src/ui/ViewControls.tsx` — floating grid/dims/units cluster.
- `src/ui/StatusBar.tsx` — active tool + route summary + grid state + hint.
- `src/ui/Inspector.tsx` — switches panel by `activeTool`/selection.
- `src/ui/panels/FloorContentsPanel.tsx`
- `src/ui/panels/PropertiesPanel.tsx`
- `src/ui/panels/DrawPanel.tsx`
- `src/ui/panels/LinkPanel.tsx`
- `src/ui/panels/RoutePanel.tsx`
- `src/ui/route.ts` — shared `useRoute()` hook (memoized graph+route+geometry from store).
- `deps.md` — dependency log.

**Modify:**
- `src/App.tsx` — collapses to `<AppShell/>`; all state removed (moved to store).
- `src/MapView.tsx` — reads store instead of props; derives internal `drawTool`/`linkMode`/`vertexEdit` from `activeTool`; calls store actions.
- `src/main.tsx` — import Geist fonts + `tokens.css`.
- `src/styles.css` — trimmed to component styles that survive; layout rules replaced.
- `package.json` — new deps.

---

## Task 1: Dependencies + deps log

**Files:**
- Modify: `package.json`
- Create: `deps.md`

**Interfaces:**
- Produces: `zustand`, `lucide-react`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` available to import.

- [ ] **Step 1: Install deps**

Run:
```bash
cd src/indoorMaps
npm install zustand lucide-react @fontsource-variable/geist @fontsource-variable/geist-mono
```
Expected: added packages, no errors.

- [ ] **Step 2: Create `deps.md`**

```markdown
# indoorMaps dependencies

## Runtime
- react, react-dom — UI
- maplibre-gl — WebGL indoor map rendering (empty style, offline)
- zustand — app state store
- lucide-react — icon set (tool rail, menus)
- @fontsource-variable/geist, @fontsource-variable/geist-mono — self-hosted Geist fonts (CSP-safe, offline)

## Dev
- vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom

## Notes
- No network at runtime: fonts bundled, map style empty.
- Pure logic modules (no deps): geo, graph, astar, render, format, svgImport, imdf.
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS (deps resolve; app still builds unchanged).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json deps.md
git commit -m "Add zustand, lucide-react, Geist fonts; deps log"
```

---

## Task 2: Zustand store

Move ALL state + mutators out of `App.tsx` into one store. Port the existing functions verbatim in behavior (they already exist in `App.tsx`). Replace the `drawTool`/`linkMode`/`vertexEdit` booleans with a single `activeTool`.

**Files:**
- Create: `src/store.ts`

**Interfaces:**
- Consumes: `Building, MetreXY, Category` from `./types`; `initialBuilding, selectableUnits, doorForRoom` from `./building`; `parseSvgShapes` from `./svgImport`; `buildingToGeoJSON, geoJSONToBuilding` from `./imdf`; `bbox` from `./geo`.
- Produces:
  - `export type Tool = "select" | "rect" | "polygon" | "vertex" | "link" | "route";`
  - `export const useStore` (Zustand hook) with the state + actions below.
  - Action signatures later tasks rely on:
    `setTool(t: Tool)`, `setOrdinal(o: number)`, `setSelected(id: string|null)`,
    `setUnit(u: "m"|"ft")`, `toggleDims()`, `toggleGrid()`, `setGridSize(n: number)`,
    `setLinkKind(k: string)`, `setStart(id: string)`, `setGoal(id: string)`, `setPlanWidth(n: number)`,
    `addRoom(polygon: MetreXY[], ordinal: number)`, `moveDoor(doorId: string, at: MetreXY)`,
    `renameUnit(id: string, name: string)`, `setCategory(id: string, c: Category)`, `deleteUnit(id: string)`,
    `moveVertex(id: string, i: number, at: MetreXY)`, `insertVertex(id: string, edge: number)`, `deleteVertex(id: string, i: number)`,
    `linkUnit(id: string)`, `deleteVertical(a: string, b: string)`,
    `importSvgText(text: string)`, `exportGeoJSON()`, `loadGeoJSONText(text: string)`, `resetBuilding()`.

- [ ] **Step 1: Write the store**

```typescript
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
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS. (Store compiles; unused until wired, which is fine for an exported module.)

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "Zustand store: all indoorMaps state + actions + persistence"
```

---

## Task 3: Shared route hook

Extract the memoized graph/route/geometry computation (currently inline in `App.tsx`) so `MapView`, `StatusBar`, and `RoutePanel` share one source.

**Files:**
- Create: `src/ui/route.ts`

**Interfaces:**
- Consumes: `useStore` (building, startId, goalId); `buildGraph` from `../graph`; `findRoute` from `../astar`; `routeToGeometry, RouteGeometry` from `../render`.
- Produces: `export function useRoute(): { geom: RouteGeometry | null }` — memoized on building/startId/goalId.

- [ ] **Step 1: Write the hook**

```typescript
import { useMemo } from "react";
import { useStore } from "../store";
import { buildGraph } from "../graph";
import { findRoute } from "../astar";
import { routeToGeometry } from "../render";
import type { RouteGeometry } from "../render";

export function useRoute(): { geom: RouteGeometry | null } {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);

  const geom = useMemo<RouteGeometry | null>(() => {
    const graph = buildGraph(building);
    const route = findRoute(graph, startId, goalId);
    return route ? routeToGeometry(graph, route.path) : null;
  }, [building, startId, goalId]);

  return { geom };
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/route.ts
git commit -m "Shared useRoute hook (memoized graph/route/geometry from store)"
```

---

## Task 4: MapView reads the store

Rewire `MapView` to source its reactive values and handlers from the store instead of props. Derive internal `drawTool`/`linkMode`/`vertexEdit` from `activeTool`. **Do not change any map/drawing logic** — only the data source. The component takes no props after this task.

**Files:**
- Modify: `src/MapView.tsx`

**Interfaces:**
- Consumes: `useStore`, `useRoute`.
- Produces: `export default function MapView()` — zero props.

- [ ] **Step 1: Replace the props interface + signature with store reads**

At the top of the component, remove the `Props` interface and destructured props. Read from the store and derive the legacy internal modes:

```typescript
import { useStore } from "./store";
import { useRoute } from "./ui/route";
// ...existing imports unchanged...

export default function MapView() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const showDims = useStore((s) => s.showDims);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const { geom } = useRoute();

  const drawTool = activeTool === "rect" ? "rect" : activeTool === "polygon" ? "polygon" : "none";
  const linkMode = activeTool === "link";
  const vertexEdit = activeTool === "vertex";
  const routeLines = geom?.lines ?? { type: "FeatureCollection", features: [] };
  const routePoints = geom?.points ?? [];

  // Handlers come straight from the store (stable references).
  const onAddRoom = useStore((s) => s.addRoom);
  const onSelect = useStore((s) => s.setSelected);
  const onMoveDoor = useStore((s) => s.moveDoor);
  const onRename = useStore((s) => s.renameUnit);
  const onSetCategory = useStore((s) => s.setCategory);
  const onDelete = useStore((s) => s.deleteUnit);
  const onLinkUnit = useStore((s) => s.linkUnit);
  const onMoveVertex = useStore((s) => s.moveVertex);
  const onInsertVertex = useStore((s) => s.insertVertex);
  const onDeleteVertex = useStore((s) => s.deleteVertex);
  // ...rest of the component body is UNCHANGED from the current file...
}
```

Everything below this point — refs, effects, `bindDrawing`, the `live` mirror, the JSX return (map-wrap, popup, shortcuts) — stays exactly as it is today. The local names (`drawTool`, `linkMode`, `vertexEdit`, `routeLines`, `routePoints`, `onAddRoom`, …) are identical to the former prop names, so the body needs no edits.

- [ ] **Step 2: Note on the `FilterSpecification` type import**

The `routeLines` fallback uses a plain object; the existing `EMPTY` const in the file already has type `FC`. Reuse `EMPTY` instead of an inline literal to keep types happy:

```typescript
  const routeLines = geom?.lines ?? EMPTY;
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: FAIL — `App.tsx` still passes props to `<MapView …/>`. That's expected; Task 5 fixes the call site. If any error is *inside* `MapView.tsx` itself, fix it before moving on.

- [ ] **Step 4: Commit**

```bash
git add src/MapView.tsx
git commit -m "MapView reads Zustand store; derives draw/link/vertex modes from activeTool"
```

---

## Task 5: Migrate App.tsx onto the store (UI unchanged)

Point the **existing** sidebar UI at the store so the app is fully working on the new state layer before any visual change. This proves the store at parity. `App.tsx` keeps its current JSX but every `useState`/handler becomes a store read/action; `<MapView/>` is called with no props.

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useStore`, `useRoute`, plus existing display helpers (`selectableUnits`, `formatArea`, etc.).

- [ ] **Step 1: Replace state + handlers with store bindings**

Delete every `useState` and every local mutator in `App.tsx` (they now live in the store). Replace reads with `useStore` selectors and calls with store actions. Keep the derived display values via the store + `useRoute`:

```typescript
import { useEffect } from "react";
import MapView from "./MapView";
import { useStore } from "./store";
import { useRoute } from "./ui/route";
import { selectableUnits } from "./building";
import { bbox, polygonArea, polygonPerimeter } from "./geo";
import { formatLength, formatArea } from "./format";
// ...existing display helpers/types...

export default function App() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const showDims = useStore((s) => s.showDims);
  const linkKind = useStore((s) => s.linkKind);
  const pendingLink = useStore((s) => s.pendingLink);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const planWidth = useStore((s) => s.planWidth);
  const importMsg = useStore((s) => s.importMsg);
  const { geom } = useRoute();

  const rooms = selectableUnits(building);
  const selectedUnit = building.units.find((u) => u.id === selectedId) ?? null;
  // ...bind every onClick/onChange in the existing JSX to the matching store action:
  //   setDrawTool(x)  -> useStore.getState().setTool(x==="rect"?"rect":...)
  //   the drawTool/linkMode/vertexEdit toggles map onto setTool(...) with the tool enum.
}
```

Bind the existing controls to the store, mapping the old booleans to `activeTool`:
- Rectangle button → `setTool(activeTool === "rect" ? "select" : "rect")`.
- Polygon button → `setTool(activeTool === "polygon" ? "select" : "polygon")`.
- Link toggle → `setTool(activeTool === "link" ? "select" : "link")`.
- Edit-vertices toggle → `setTool(activeTool === "vertex" ? "select" : "vertex")`.
- All other controls → the identically-named store actions.

Keep the two existing `useEffect`s (start/goal clamping and keyboard Delete/Esc) but source their state from the store and call store actions.

- [ ] **Step 2: Call MapView with no props**

```tsx
<MapView />
```
(remove the entire prop list.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual parity check**

Run `npm run dev`. Confirm every feature still works exactly as before the refactor: draw rect/polygon, vertex edit, door drag+snap, floors, links, measure/units/dims, SVG import, GeoJSON export+load, routing, right-click properties, Delete/Esc. Refresh persists.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "App onto Zustand store at parity (UI unchanged); MapView propless"
```

---

## Task 6: Design tokens + Geist fonts

**Files:**
- Create: `src/ui/tokens.css`
- Modify: `src/main.tsx`

**Interfaces:**
- Produces: CSS variables consumed by all UI components; Geist font families active.

- [ ] **Step 1: Create `src/ui/tokens.css`**

```css
:root {
  --bg: #0b0d10;
  --panel: #0d1116;
  --panel-2: #10161e;
  --line: #1e2733;
  --line-2: #2c3a4c;
  --text: #e8e8e8;
  --dim: #8a96a5;
  --accent: #00d7cd;
  --danger: #ff5c5c;
  --select: #f2c14e;

  --font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, monospace;

  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 24px;

  --rail: 52px;
  --inspector: 280px;
  --topbar: 48px;
  --statusbar: 30px;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font-family: var(--font-sans);
  color: var(--text);
  background: var(--bg);
  font-feature-settings: "tnum" 1; /* tabular numerals for metrics */
}
.mono { font-family: var(--font-mono); }
```

- [ ] **Step 2: Import fonts + tokens in `src/main.tsx`**

```typescript
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "maplibre-gl/dist/maplibre-gl.css";
import "./ui/tokens.css";
import "./styles.css";
```
(Keep the existing React render call.)

- [ ] **Step 3: Verify build + fonts offline**

Run: `npm run build`, then `npm run dev`. In the browser Network tab, confirm no external font requests (Geist served from the bundle). UI renders in Geist.

- [ ] **Step 4: Commit**

```bash
git add src/ui/tokens.css src/main.tsx
git commit -m "Design tokens + self-hosted Geist fonts"
```

---

## Task 7: Tool rail

**Files:**
- Create: `src/ui/ToolRail.tsx`
- Modify: `src/styles.css` (append rail styles)

**Interfaces:**
- Consumes: `useStore` (activeTool, selectedId, setTool); `lucide-react` icons.
- Produces: `export default function ToolRail()`.

- [ ] **Step 1: Write the rail**

```tsx
import { MousePointer2, Square, Hexagon, Spline, ArrowUpDown, Route } from "lucide-react";
import { useStore } from "../store";
import type { Tool } from "../store";

const TOOLS: { id: Tool; label: string; Icon: typeof Square; needsSelection?: boolean }[] = [
  { id: "select", label: "Select", Icon: MousePointer2 },
  { id: "rect", label: "Rectangle", Icon: Square },
  { id: "polygon", label: "Polygon", Icon: Hexagon },
  { id: "vertex", label: "Edit vertices", Icon: Spline, needsSelection: true },
  { id: "link", label: "Vertical link", Icon: ArrowUpDown },
  { id: "route", label: "Wayfinding", Icon: Route },
];

export default function ToolRail() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const setTool = useStore((s) => s.setTool);

  return (
    <div className="rail">
      {TOOLS.map(({ id, label, Icon, needsSelection }) => {
        const disabled = needsSelection && !selectedId;
        return (
          <button
            key={id}
            className={`rail-btn ${activeTool === id ? "active" : ""}`}
            title={label}
            disabled={disabled}
            onClick={() => setTool(id)}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Append rail styles to `src/styles.css`**

```css
.rail {
  grid-area: rail;
  display: flex;
  flex-direction: column;
  gap: var(--s1);
  padding: var(--s2) var(--s1);
  background: var(--panel);
  border-right: 1px solid var(--line);
}
.rail-btn {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  background: transparent;
  color: var(--dim);
  border: 1px solid transparent;
  border-radius: 0;
  cursor: pointer;
  transition: color 120ms, border-color 120ms, background 120ms;
}
.rail-btn:hover:not(:disabled) { color: var(--text); background: var(--panel-2); }
.rail-btn.active { color: var(--accent); border-color: var(--accent); }
.rail-btn:disabled { opacity: 0.3; cursor: default; }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS (component compiles; not yet mounted).

- [ ] **Step 4: Commit**

```bash
git add src/ui/ToolRail.tsx src/styles.css
git commit -m "Tool rail component (activeTool-bound, lucide icons)"
```

---

## Task 8: Inspector panels

Build the five contextual panels and the `Inspector` switch. Each panel is a relocation of the corresponding current sidebar JSX, reading/writing the store. Build them unmounted; Task 11 mounts the shell.

**Files:**
- Create: `src/ui/panels/FloorContentsPanel.tsx`, `PropertiesPanel.tsx`, `DrawPanel.tsx`, `LinkPanel.tsx`, `RoutePanel.tsx`
- Create: `src/ui/Inspector.tsx`
- Modify: `src/styles.css` (append panel styles: reuse existing `.readout`, `.roomrow`, `.numin`, `.hint`, `.floors`, `.filebtn` classes — they already exist and match the aesthetic)

**Interfaces:**
- Consumes: `useStore`, `useRoute`, display helpers (`selectableUnits`, `polygonArea`, `polygonPerimeter`, `bbox`, `formatArea`, `formatLength`).
- Produces: `export default` for each panel; `export default function Inspector()`.

- [ ] **Step 1: `FloorContentsPanel.tsx`** — rooms on the active floor (select/rename/delete). Uses store `building`, `ordinal`, `selectedId`, `setSelected`, `renameUnit`, `deleteUnit`.

```tsx
import { useStore } from "../../store";

export default function FloorContentsPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const renameUnit = useStore((s) => s.renameUnit);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const rooms = building.units.filter((u) => u.category === "room" && u.ordinal === ordinal);

  return (
    <div className="panel">
      <div className="panel-title">Floor contents</div>
      {rooms.length === 0 && <p className="hint">No rooms on this floor. Draw one with the ▢ or ⬡ tool.</p>}
      <div className="roomlist">
        {rooms.map((r) => (
          <div className={`roomrow ${r.id === selectedId ? "selected" : ""}`} key={r.id}>
            <input value={r.name} onFocus={() => setSelected(r.id)} onChange={(e) => renameUnit(r.id, e.target.value)} />
            <button className="del" title="Delete" onClick={() => deleteUnit(r.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `PropertiesPanel.tsx`** — the selected unit's name/category/dimensions + edit-vertices toggle + delete. Uses `selectedUnit`, `unit`, `setCategory`, `renameUnit`, `deleteUnit`, `setTool`, `activeTool`.

```tsx
import { useStore } from "../../store";
import { bbox, polygonArea, polygonPerimeter } from "../../geo";
import { formatArea, formatLength } from "../../format";
import type { Category } from "../../types";

export default function PropertiesPanel() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const renameUnit = useStore((s) => s.renameUnit);
  const setCategory = useStore((s) => s.setCategory);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const u = building.units.find((x) => x.id === selectedId);
  if (!u) return <div className="panel"><p className="hint">Select a unit to edit its properties.</p></div>;
  const [x0, y0, x1, y1] = bbox(u.polygon);

  return (
    <div className="panel">
      <div className="panel-title">Properties</div>
      <label>Name</label>
      <input value={u.name} onChange={(e) => renameUnit(u.id, e.target.value)} />
      <label>Category</label>
      <select value={u.category} onChange={(e) => setCategory(u.id, e.target.value as Category)}>
        <option value="room">room</option>
        <option value="corridor">corridor</option>
        <option value="elevator">elevator</option>
        <option value="stairs">stairs</option>
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        <div><span className="k">area</span> {formatArea(polygonArea(u.polygon), unit)}</div>
        <div><span className="k">size</span> {formatLength(x1 - x0, unit)} × {formatLength(y1 - y0, unit)}</div>
        <div><span className="k">perim</span> {formatLength(polygonPerimeter(u.polygon), unit)}</div>
      </div>
      <button className={`wide ${activeTool === "vertex" ? "active" : ""}`} style={{ marginTop: 8 }}
        onClick={() => setTool(activeTool === "vertex" ? "select" : "vertex")}>
        {activeTool === "vertex" ? "◼ Editing vertices" : "✎ Edit vertices"}
      </button>
      <button className="wide danger" style={{ marginTop: 8 }} onClick={() => deleteUnit(u.id)}>Delete unit</button>
    </div>
  );
}
```

- [ ] **Step 3: `DrawPanel.tsx`** — draw options (reads grid/snap view-state; shows shortcuts). Uses `activeTool`, `showGrid`, `gridSize`.

```tsx
import { useStore } from "../../store";

export default function DrawPanel() {
  const activeTool = useStore((s) => s.activeTool);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  return (
    <div className="panel">
      <div className="panel-title">{activeTool === "rect" ? "Rectangle" : "Polygon"}</div>
      {activeTool === "rect" ? (
        <p className="hint">Drag a rectangle on the canvas. Releases into a routable room.</p>
      ) : (
        <p className="hint">Click to drop vertices. Click the first point again or press Enter to close; Esc cancels.</p>
      )}
      <p className="hint">{showGrid ? `Snapping to a ${gridSize} m grid (toggle in view controls).` : "Grid snapping is off (toggle in view controls)."}</p>
    </div>
  );
}
```

- [ ] **Step 4: `LinkPanel.tsx`** — kind selector, pending state, links list. Uses `linkKind`, `setLinkKind`, `pendingLink`, `building.verticals`, `deleteVertical`, plus a `roomName` helper (inline).

```tsx
import { useStore } from "../../store";

export default function LinkPanel() {
  const building = useStore((s) => s.building);
  const linkKind = useStore((s) => s.linkKind);
  const setLinkKind = useStore((s) => s.setLinkKind);
  const pendingLink = useStore((s) => s.pendingLink);
  const deleteVertical = useStore((s) => s.deleteVertical);
  const name = (id: string) => building.units.find((u) => u.id === id)?.name ?? id;
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  return (
    <div className="panel">
      <div className="panel-title">Vertical links</div>
      <label>Kind</label>
      <select value={linkKind} onChange={(e) => setLinkKind(e.target.value)}>
        <option>Elevator</option><option>Stairs</option><option>Ramp</option><option>Escalator</option>
      </select>
      <p className="hint">
        {pendingLink
          ? `Picked ${name(pendingLink.id)} on ${level(pendingLink.ordinal)}. Switch floor and click its counterpart.`
          : "Click a unit, switch floor, then click the unit to connect it to."}
      </p>
      {building.verticals.length > 0 && (
        <div className="roomlist" style={{ marginTop: 8 }}>
          {building.verticals.map((v) => (
            <div className="roomrow" key={`${v.a}-${v.b}`}>
              <span className="vlabel">{name(v.a)} ⭥ {name(v.b)}</span>
              <button className="del" onClick={() => deleteVertical(v.a, v.b)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: `RoutePanel.tsx`** — From/To pickers + full readout. Uses `selectableUnits`, `startId`, `goalId`, `setStart`, `setGoal`, `useRoute`, `unit`.

```tsx
import { useStore } from "../../store";
import { useRoute } from "../route";
import { selectableUnits } from "../../building";

export default function RoutePanel() {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const { geom } = useRoute();
  const rooms = selectableUnits(building);
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  return (
    <div className="panel">
      <div className="panel-title">Wayfinding</div>
      <label>From</label>
      <select value={startId} onChange={(e) => setStart(e.target.value)}>
        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} · {level(r.ordinal)}</option>)}
      </select>
      <label>To</label>
      <select value={goalId} onChange={(e) => setGoal(e.target.value)}>
        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} · {level(r.ordinal)}</option>)}
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        {geom ? (
          <>
            <div><span className="k">floors</span> {geom.floors.map(level).join(" → ") || "—"}</div>
            <div><span className="k">walk</span> ~{geom.metres.toFixed(0)} m{geom.floors.length > 1 && " + elevator"}</div>
          </>
        ) : <div className="warn">no route found</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: `Inspector.tsx`** — pick the panel by `activeTool` + selection.

```tsx
import { useStore } from "../store";
import FloorContentsPanel from "./panels/FloorContentsPanel";
import PropertiesPanel from "./panels/PropertiesPanel";
import DrawPanel from "./panels/DrawPanel";
import LinkPanel from "./panels/LinkPanel";
import RoutePanel from "./panels/RoutePanel";

export default function Inspector() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);

  let body: React.ReactNode;
  if (activeTool === "rect" || activeTool === "polygon") body = <DrawPanel />;
  else if (activeTool === "link") body = <LinkPanel />;
  else if (activeTool === "route") body = <RoutePanel />;
  else if (activeTool === "vertex" || selectedId) body = <PropertiesPanel />;
  else body = <FloorContentsPanel />;

  return <aside className="inspector" key={activeTool + (selectedId ?? "")}>{body}</aside>;
}
```

(The `key` forces a remount → CSS cross-fade in Task 12.)

- [ ] **Step 7: Append panel styles to `src/styles.css`**

```css
.inspector {
  grid-area: inspector;
  width: var(--inspector);
  background: var(--panel);
  border-left: 1px solid var(--line);
  overflow-y: auto;
  animation: fade 150ms ease;
}
.panel { padding: var(--s4); }
.panel-title {
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim); margin-bottom: var(--s3);
}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
```

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: PASS (compiles; not yet mounted).

- [ ] **Step 9: Commit**

```bash
git add src/ui/Inspector.tsx src/ui/panels src/styles.css
git commit -m "Inspector + 5 contextual panels (store-bound)"
```

---

## Task 9: Top bar (floor pills + data menu)

**Files:**
- Create: `src/ui/TopBar.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `useStore` (building.levels, ordinal, setOrdinal, planWidth, setPlanWidth, importSvgText, exportGeoJSON, loadGeoJSONText, resetBuilding, importMsg).
- Produces: `export default function TopBar()`.

- [ ] **Step 1: Write TopBar** (wordmark, floor pills, a Data dropdown with Import SVG + plan width, Export, Load, Reset). Import/Load use hidden `<input type="file">` reading `.text()` → `importSvgText`/`loadGeoJSONText`.

```tsx
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useStore } from "../store";

export default function TopBar() {
  const levels = useStore((s) => s.building.levels);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const planWidth = useStore((s) => s.planWidth);
  const setPlanWidth = useStore((s) => s.setPlanWidth);
  const importSvgText = useStore((s) => s.importSvgText);
  const exportGeoJSON = useStore((s) => s.exportGeoJSON);
  const loadGeoJSONText = useStore((s) => s.loadGeoJSONText);
  const resetBuilding = useStore((s) => s.resetBuilding);
  const importMsg = useStore((s) => s.importMsg);
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="wordmark">indoorMaps</div>
      <div className="floorpills">
        {levels.map((lv) => (
          <button key={lv.ordinal} className={lv.ordinal === ordinal ? "active" : ""}
            onClick={() => setOrdinal(lv.ordinal)}>{lv.name}</button>
        ))}
      </div>
      <div className="datamenu">
        <button className="datamenu-trigger" onClick={() => setOpen((v) => !v)}>Data <ChevronDown size={14} /></button>
        {open && (
          <div className="datamenu-pop" onMouseLeave={() => setOpen(false)}>
            <div className="dm-row">
              <span>Plan width</span>
              <input type="number" className="numin" min={1} value={planWidth}
                onChange={(e) => setPlanWidth(Number(e.target.value))} /> m
            </div>
            <label className="dm-item">Import SVG…
              <input type="file" accept=".svg,image/svg+xml" hidden
                onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importSvgText(await f.text()); }} />
            </label>
            <button className="dm-item" onClick={exportGeoJSON}>Export GeoJSON</button>
            <label className="dm-item">Load GeoJSON…
              <input type="file" accept=".geojson,.json" hidden
                onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadGeoJSONText(await f.text()); }} />
            </label>
            <button className="dm-item danger" onClick={resetBuilding}>Reset building</button>
            {importMsg && <div className="dm-msg">{importMsg}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Append styles** (topbar grid row, wordmark, floorpills segmented, datamenu dropdown). Add to `src/styles.css`:

```css
.topbar {
  grid-area: topbar;
  display: flex; align-items: center; gap: var(--s4);
  padding: 0 var(--s4);
  background: var(--panel); border-bottom: 1px solid var(--line);
}
.wordmark { font-size: 14px; letter-spacing: 0.02em; }
.floorpills { display: flex; gap: var(--s1); margin: 0 auto; }
.floorpills button {
  background: var(--panel-2); color: var(--dim);
  border: 1px solid var(--line); padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.floorpills button.active { color: var(--accent); border-color: var(--accent); }
.datamenu { position: relative; }
.datamenu-trigger { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); padding: 5px 10px; font-size: 12px; display: flex; align-items: center; gap: 4px; cursor: pointer; }
.datamenu-pop { position: absolute; right: 0; top: 100%; margin-top: 4px; width: 210px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.5); z-index: 10; padding: var(--s2); }
.dm-item { display: block; width: 100%; text-align: left; background: transparent; color: var(--text); border: 0; padding: 8px 6px; font-size: 13px; cursor: pointer; }
.dm-item:hover { background: var(--panel-2); }
.dm-item.danger:hover { color: var(--danger); }
.dm-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); padding: 4px 6px; }
.dm-msg { font-size: 11px; color: var(--dim); padding: 6px; border-top: 1px solid var(--line); margin-top: 4px; }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/TopBar.tsx src/styles.css
git commit -m "Top bar: wordmark, floor pills, Data menu (import/export/load/reset)"
```

---

## Task 10: View controls + status bar

**Files:**
- Create: `src/ui/ViewControls.tsx`, `src/ui/StatusBar.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- ViewControls consumes: `showGrid, toggleGrid, gridSize, setGridSize, showDims, toggleDims, unit, setUnit`.
- StatusBar consumes: `activeTool, showGrid, gridSize` + `useRoute` + building for names.

- [ ] **Step 1: `ViewControls.tsx`** (floating cluster over the canvas)

```tsx
import { Grid3x3, Ruler } from "lucide-react";
import { useStore } from "../store";

export default function ViewControls() {
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const gridSize = useStore((s) => s.gridSize);
  const setGridSize = useStore((s) => s.setGridSize);
  const showDims = useStore((s) => s.showDims);
  const toggleDims = useStore((s) => s.toggleDims);
  const unit = useStore((s) => s.unit);
  const setUnit = useStore((s) => s.setUnit);

  return (
    <div className="viewctl">
      <button className={showGrid ? "active" : ""} title="Grid & snap" onClick={toggleGrid}><Grid3x3 size={15} /></button>
      {showGrid && (
        <input type="number" className="numin sm" min={0.25} max={20} step={0.25} value={gridSize}
          onChange={(e) => setGridSize(Number(e.target.value))} title="Grid size (m)" />
      )}
      <button className={showDims ? "active" : ""} title="Dimensions" onClick={toggleDims}><Ruler size={15} /></button>
      <div className="unittoggle">
        <button className={unit === "m" ? "active" : ""} onClick={() => setUnit("m")}>m</button>
        <button className={unit === "ft" ? "active" : ""} onClick={() => setUnit("ft")}>ft</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `StatusBar.tsx`**

```tsx
import { useStore } from "../store";
import { useRoute } from "./route";

const HINTS: Record<string, string> = {
  select: "Click a unit to select · drag door dots · right-click for properties",
  rect: "Drag a rectangle to add a room",
  polygon: "Click to add vertices · Enter/first-point to close · Esc to cancel",
  vertex: "Drag handles · + to insert · right-click a handle to delete",
  link: "Click a unit, switch floor, click its counterpart",
  route: "Pick From and To in the inspector",
};

export default function StatusBar() {
  const activeTool = useStore((s) => s.activeTool);
  const building = useStore((s) => s.building);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const { geom } = useRoute();
  const name = (id: string) => building.units.find((u) => u.id === id)?.name ?? id;

  return (
    <footer className="statusbar mono">
      <span className="st-tool">{activeTool}</span>
      <span className="st-sep">·</span>
      {geom ? (
        <span>{name(startId)} → {name(goalId)} · {geom.metres.toFixed(0)} m · {geom.floors.length} floor{geom.floors.length === 1 ? "" : "s"}</span>
      ) : <span className="warn">no route</span>}
      <span className="st-hint">{HINTS[activeTool]}</span>
      <span className="st-grid">{showGrid ? `grid ${gridSize} m` : "grid off"}</span>
    </footer>
  );
}
```

- [ ] **Step 3: Append styles**

```css
.viewctl { position: absolute; top: var(--s3); right: var(--s3); z-index: 5; display: flex; gap: var(--s1); align-items: center; background: rgba(13,17,22,.9); border: 1px solid var(--line); padding: var(--s1); }
.viewctl button { width: 28px; height: 28px; display: grid; place-items: center; background: transparent; color: var(--dim); border: 1px solid transparent; cursor: pointer; }
.viewctl button.active { color: var(--accent); border-color: var(--accent); }
.numin.sm { width: 52px; padding: 4px 6px; }
.unittoggle { display: flex; }
.unittoggle button { width: 26px; font-size: 11px; }
.statusbar { grid-area: statusbar; display: flex; align-items: center; gap: var(--s3); padding: 0 var(--s4); font-size: 11px; color: var(--dim); background: var(--panel); border-top: 1px solid var(--line); }
.st-tool { color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; }
.st-hint { margin-left: auto; }
.st-grid { color: var(--dim); }
```

- [ ] **Step 4: Verify build + Commit**

Run: `npm run build` (PASS).
```bash
git add src/ui/ViewControls.tsx src/ui/StatusBar.tsx src/styles.css
git commit -m "View controls cluster + status bar"
```

---

## Task 11: Assemble the shell + swap App

Mount everything. Replace the old sidebar in `App.tsx` with `<AppShell/>`. This task delivers the full new UI at parity.

**Files:**
- Create: `src/ui/AppShell.tsx`
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: all components above + `MapView`.

- [ ] **Step 1: `AppShell.tsx`**

```tsx
import { useEffect } from "react";
import MapView from "../MapView";
import TopBar from "./TopBar";
import ToolRail from "./ToolRail";
import Inspector from "./Inspector";
import ViewControls from "./ViewControls";
import StatusBar from "./StatusBar";
import { useStore } from "../store";
import { selectableUnits } from "../building";

export default function AppShell() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const setSelected = useStore((s) => s.setSelected);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const setTool = useStore((s) => s.setTool);

  // Keep start/goal valid as rooms come and go.
  useEffect(() => {
    const rooms = selectableUnits(building);
    if (rooms.length === 0) return;
    if (!rooms.some((r) => r.id === startId)) setStart(rooms[0].id);
    if (!rooms.some((r) => r.id === goalId)) setGoal(rooms[rooms.length - 1].id);
  }, [building, startId, goalId, setStart, setGoal]);

  // Delete/Backspace removes selected room (unless typing); Esc handled in MapView.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (selectedId && building.units.some((u) => u.id === selectedId && u.category === "room")) {
        deleteUnit(selectedId);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, building, deleteUnit, setTool]);

  return (
    <div className="shell">
      <TopBar />
      <ToolRail />
      <div className="canvas-zone">
        <MapView />
        <ViewControls />
      </div>
      <Inspector />
      <StatusBar />
    </div>
  );
}
```

- [ ] **Step 2: Replace `App.tsx` body entirely**

```tsx
import AppShell from "./ui/AppShell";
export default function App() {
  return <AppShell />;
}
```

- [ ] **Step 3: Shell grid + canvas-zone styles; remove obsolete `.app`/`.sidebar` rules**

```css
.shell {
  display: grid;
  height: 100%;
  grid-template-columns: var(--rail) 1fr var(--inspector);
  grid-template-rows: var(--topbar) 1fr var(--statusbar);
  grid-template-areas:
    "topbar topbar topbar"
    "rail   canvas inspector"
    "statusbar statusbar statusbar";
}
.canvas-zone { grid-area: canvas; position: relative; }
.map-wrap { position: absolute; inset: 0; }
```
Delete the old `.app`, `.sidebar`, `.sidebar h1`, `.sub`, and `.sidebar section` layout rules from `styles.css` (the reusable atoms `.readout`, `.roomrow`, `.hint`, `.numin`, `.floors` buttons, `.props-popup`, `.door`, `.vhandle`, `.shortcuts`, `.measure`, `.label`, `.pin` stay — they're used by panels and MapView).

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Full manual parity + layout check**

Run `npm run dev`. Walk the entire success-criteria list from the spec:
1. Select tool: floor contents lists rooms; click a room → Properties panel with area/size/perimeter; rename/delete work; right-click popup still works.
2. Rectangle/Polygon tools draw; Draw panel + status hint show; grid snap via view controls.
3. Vertex tool (with a room selected): handles, +, right-click delete.
4. Link tool: kind select, cross-floor link auto-colors endpoints, list + delete.
5. Route tool: From/To, readout; route line renders on the map regardless of active tool.
6. Floor pills switch floors; door drag+snap; measurement units/dims via view controls; live draw dims.
7. Data menu: Import SVG (sample in `scratch/`), Export GeoJSON, Load round-trip, Reset.
8. Delete/Esc; refresh persists; no external network requests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/AppShell.tsx src/App.tsx src/styles.css
git commit -m "Assemble pro-tool shell; swap App to AppShell (full new UI at parity)"
```

---

## Task 12: Motion, polish, cleanup

**Files:**
- Modify: `src/styles.css`, and any component needing focus/hover refinement.

- [ ] **Step 1: Interaction polish** — add consistent `:focus-visible` rings (accent), hover transitions on all buttons/inputs, the inspector cross-fade (already via `key`+`@keyframes fade`), and a subtle route-line consideration (visual only). Append:

```css
button, select, input { outline: none; }
button:focus-visible, select:focus-visible, input:focus-visible { border-color: var(--accent); }
.wide, .floors button, .rail-btn, .viewctl button, .floorpills button { transition: color 120ms, border-color 120ms, background 120ms; }
.panel label { display:block; font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:var(--dim); margin:10px 0 4px; }
.panel input, .panel select { width:100%; background:var(--panel-2); color:var(--text); border:1px solid var(--line); border-radius:0; padding:7px 8px; font-size:13px; }
.wide.danger { text-align:center; } .wide.danger:hover { border-color:var(--danger); color:var(--danger); }
```

- [ ] **Step 2: Dead-code sweep** — remove any now-unused imports/classes left in `styles.css` and `App.tsx`. Run the build; `noUnusedLocals` will flag stragglers.

- [ ] **Step 3: Verify build + final walk-through**

Run: `npm run build` (PASS), then `npm run dev` and re-confirm the success criteria list. Check the Network tab shows no external requests.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "UI overhaul: interaction polish + dead-code cleanup"
```

- [ ] **Step 5: Update the project map**

In `src/indoorMaps/CLAUDE.md`, note the new `src/ui/` structure + Zustand store under a short "UI" section so a fresh session finds the shell.

```bash
git add CLAUDE.md
git commit -m "Docs: note UI shell + store in project CLAUDE.md"
```

---

## Self-review notes

- **Spec coverage:** §1 shell → Tasks 7–11; §2 tool/inspector model → Tasks 7,8; §3 visual system → Tasks 6,12; §4 store+components → Tasks 2–5,7–11; §5 parity → verified in Tasks 5 and 11 manual checks; success criteria 1–7 → Task 11 step 5 + Task 12 step 3.
- **Type consistency:** action names are defined once in Task 2's Produces block and used verbatim throughout (`setTool`, `importSvgText`, `loadGeoJSONText`, `deleteUnit`, etc.). `Tool` enum defined in Task 2, consumed in Tasks 4,7,8,10. `useRoute` defined Task 3, consumed Tasks 4,8,10.
- **Working-app continuity:** app is fully functional after Task 5 (store at parity, old UI), stays functional through Tasks 6–10 (new components built unmounted), swaps to the new UI in Task 11.
- **No test harness added** (established project pattern); verification is build + manual against the running app, matching the spec's behavioral success criteria.
