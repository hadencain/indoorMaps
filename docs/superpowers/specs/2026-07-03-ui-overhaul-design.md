# indoorMaps — UI Overhaul Design Spec

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation plan
**Scope:** Full UI/UX overhaul + supporting architecture refactor. **Feature parity — no new capabilities.**

## Goal

Replace the single flat 11-section sidebar with an award-winning, professional spatial-tool UI that is easier to digest and use. The current UI shows every control at once with no hierarchy or sense of active mode. The overhaul makes the UI **contextual** — you only see controls relevant to what you're doing.

## Fixed decisions

- **Stack:** stay **Vite + React** (browser-only app: MapLibre WebGL + localStorage + File APIs; Next.js buys nothing here). Rejected: Next.js migration, Next.js outer shell.
- **Layout paradigm:** **pro-tool rail + contextual inspector** (Figma/Mappedin/CAD standard). Rejected: grouped collapsible sidebar (too incremental), full-bleed floating glass (fights a dense authoring canvas).
- **Aesthetic:** **refined technical dark, tied to the hadencain.com portfolio system.** Rejected: blueprint/drafting skin, high-contrast brutalism.

## 1. Shell architecture

A five-zone CSS-grid shell replaces the sidebar+map flex layout.

```
┌───────────────────────────────────────────────┐
│ TOP BAR   indoorMaps · [Ground|Level 1] · Data▾ │
├──┬──────────────────────────────────┬──────────┤
│R │                          ┌─view─┐ │ INSPECTOR│
│A │           CANVAS         │▦ ▤ m │ │ (context)│
│I │        (full height)     └──────┘ │          │
│L │                                    │          │
├──┴──────────────────────────────────┴──────────┤
│ STATUS   Select · Lobby→Lab · 42 m · grid 1 m   │
└───────────────────────────────────────────────┘
```

Zones and responsibilities:

- **Top bar** — wordmark; floor pills (center, the global floor context); a **Data ▾** menu containing Import SVG (with plan-width input), Export GeoJSON, Load GeoJSON, Reset building.
- **Tool rail** (left, ~52px wide, icon buttons) — the interaction-mode selector. Exactly one tool active at a time. Active tool shows the cyan accent.
- **Canvas** — `MapView`, full height, no baked-in chrome.
- **View controls** — a small floating segmented cluster positioned top-right *over* the canvas: grid toggle + size stepper, dimensions toggle, units (m/ft) toggle. These are **view states, not tools**, so they never enter the rail or an inspector panel.
- **Inspector** (right, ~280px) — contextual panel; contents swap based on active tool and current selection. Cross-fades on change.
- **Status bar** (bottom) — active tool name · route summary (`Lobby → Lab · 42 m · 2 floors`) · grid state · a one-line contextual hint for the active tool.

## 2. Tool + inspector model

The tool rail replaces the current drawTool/linkMode/vertexEdit boolean soup with a single `activeTool` enum. Tools and the inspector content each drives:

| Rail tool | Icon | Inspector content |
|---|---|---|
| **Select** (default) | cursor | Nothing selected → **Floor contents**: list of rooms on the active floor (click-to-select, rename, delete). Unit selected → **Properties**: name, category selector, area / size (W×H) / perimeter readout, **Edit vertices** toggle, delete. |
| **Rectangle** | square | **Draw**: reads the shared grid/snap view-state; live shortcut hint. |
| **Polygon** | polygon | **Draw**: same + polygon-specific shortcuts (click / Enter / Esc / right-click). |
| **Vertex** | pen/nodes | Enabled only when a room is selected; renders vertex + midpoint handles on canvas; inspector shows vertex-edit hints. |
| **Link** | vertical arrows | **Vertical links**: kind selector (Elevator/Stairs/Ramp/Escalator), pending-endpoint state, existing-links list with delete. |
| **Route** | route/path | **Wayfinding**: From / To pickers + full route readout (floors traversed, distance, elevator note). |

Cross-cutting behaviors preserved:

- **Right-click** on a unit still opens the quick **Properties popup** (fast path) — the inspector is the persistent surface, the popup is the shortcut. Both edit the same store.
- **Delete/Backspace** removes the selected room (guarded against text inputs).
- **Esc** cancels the in-progress draw / clears pending link / closes popup.
- Mode exclusivity is inherent: one `activeTool` at a time.

### Mapping from current sections → new home

| Current sidebar section | New home |
|---|---|
| Floor switcher | Top bar (floor pills) |
| Draw rect/polygon | Tool rail (Rectangle, Polygon) + Draw inspector |
| Measure: units + dimensions toggle | View controls cluster |
| Measure: selected-space readout | Select → Properties inspector |
| Measure: edit-vertices | Vertex tool / Properties toggle |
| Grid & snap | View controls cluster |
| Vertical links | Link tool + inspector |
| From/To routing | Route tool + Wayfinding inspector |
| Route readout | Status bar (summary) + Route inspector (detail) |
| Rooms-on-floor list | Select → Floor contents inspector |
| Import SVG | Data menu (top bar) |
| Export / Load | Data menu (top bar) |
| Reset | Data menu (top bar) |

## 3. Visual system

- **Color:** canvas `#0b0d10`; panels `#0d1116`; hairline borders `#1e2733`; text `#e8e8e8`, dim `#8a96a5`; single accent cyan `#00d7cd` reserved for active/interactive states only; danger `#ff5c5c`. Category fills unchanged: room `#171f2b`, corridor `#1a2230`, elevator `#0e3b3a`, stairs `#3a2e14`.
- **Type:** self-hosted **Geist Sans** (UI) + **Geist Mono** (all data — measurements, coordinates, IDs, route metrics). CSP-safe / fully offline (bundled via fontsource, no external font requests). A deliberate type scale; **tabular-lining numerals** on every numeric readout.
- **Motion:** restraint over spectacle. Inspector cross-fade (~150ms) on tool/selection change; tool-rail active-state transition; route-line draw-in; honest hover/focus states. Pure CSS transitions — no animation library.
- **Icons:** `lucide-react` (tree-shakeable, line-weight matches the aesthetic).
- **Square, radius-0 borders** and wide-tracked uppercase mono micro-labels, consistent with the portfolio system.

## 4. Architecture / refactor

The current `App.tsx` holds ~15 state atoms and hand-drills them into `MapView` (17+ props). This does not scale to a 6-component shell.

- **State store — Zustand.** A single `useStore` holding:
  - Domain: `building`.
  - UI: `activeTool`, `selectedId`, `ordinal`, `unit`, `showDims`, `showGrid`, `gridSize`, `linkKind`, `pendingLink`, `vertexEdit` (folds into Select/Vertex), `importMsg`, `planWidth`.
  - Actions: all current mutators (addRoom, moveDoor, renameUnit, setCategory, deleteUnit, moveVertex/insertVertex/deleteVertex, linkUnits, deleteVertical, importSvg, exportGeoJSON, loadGeoJSON, resetBuilding) + selectors.
  - Persistence: the existing localStorage v3 load/save moves into the store (subscribe → persist).
- **Component decomposition:**
  - `AppShell` — the CSS-grid layout.
  - `TopBar` — wordmark, `FloorPills`, `DataMenu`.
  - `ToolRail` — tool buttons bound to `activeTool`.
  - `Inspector` — switches on `activeTool` + selection; renders one of `FloorContentsPanel`, `PropertiesPanel`, `DrawPanel`, `LinkPanel`, `RoutePanel`.
  - `ViewControls` — floating grid/dims/units cluster.
  - `StatusBar` — tool + route summary + grid state + hint.
  - `MapView` — **kept**; its imperative MapLibre logic is sound. It reads the store (tool, selection, view state, handlers) instead of receiving 17 props. The `live` ref pattern that mirrors props for once-bound map handlers stays, now sourced from the store.
- **Existing pure modules kept as-is:** `geo`, `graph`, `astar`, `render`, `format`, `svgImport`, `imdf`, `building`, `types`. Only the React layer and state plumbing change.
- **New deps:** `zustand`, `lucide-react`, Geist fonts via fontsource (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono` or the non-variable equivalents, resolved at build). `deps.md`/README updated per project convention.

## 5. Scope boundary

**Feature parity. No new capabilities.** Every current behavior keeps working identically: rectangle + polygon authoring, vertex editing, doors with grid+wall snapping, floor switching, vertical links (with elevator/stairs auto-category), measurement (units, dims overlay, live draw dims, selected-space readout), SVG import, GeoJSON export + round-trip load, A* routing, right-click properties, keyboard delete/esc.

The MapLibre interaction engine is untouched in behavior — only its data source (props → store) changes.

## Success criteria (behavioral)

1. Every feature listed in §5 works after the overhaul, verified against the running app.
2. At any moment the visible controls are only those relevant to the active tool/selection — no dead/irrelevant panels on screen.
3. Switching tools swaps the inspector with a visible but quick (~150ms) transition; exactly one tool is ever active.
4. The status bar always reflects: active tool, current route (if any), grid state.
5. All numeric readouts render in Geist Mono with tabular figures; no layout shift as numbers change.
6. No external network requests at runtime (fonts self-hosted, map style empty) — verifiable in the network tab.
7. `npm run build` passes (tsc + vite) and the app runs.

## Phasing (for the implementation plan)

1. **Store migration** — introduce Zustand, move all state + actions + persistence off `App.tsx`, keep the *current* UI wired to it (no visual change yet). Verify parity.
2. **Shell** — `AppShell` grid + `TopBar` (floor pills + Data menu) + `ToolRail` + empty `Inspector`/`StatusBar`. `MapView` reads store. Old sidebar removed.
3. **Inspector panels** — build the five contextual panels; wire each tool.
4. **View controls + status bar** — floating cluster, status summary.
5. **Visual system** — Geist fonts, color tokens, type scale, icons, motion/transitions, final polish.

Each phase ends build-passing and manually verifiable against the running app.
