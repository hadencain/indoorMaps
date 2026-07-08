# indoorMaps

**Indoor mapping & camera-coverage planning.** A browser-based tool for authoring building floorplans, placing security cameras, and analysing what they can — and cannot — actually see. It runs entirely in the browser with no backend and no network access; your floorplans never leave the machine.

> **Working name.** "indoorMaps" is a placeholder, not a committed brand.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Core concepts](#core-concepts)
3. [Getting started](#getting-started)
4. [The interface](#the-interface)
5. [Workflows](#workflows)
6. [Reference](#reference)
7. [Data, files & privacy](#data-files--privacy)
8. [Architecture](#architecture)
9. [Roadmap](#roadmap)
10. [Known limitations](#known-limitations)

---

## What it does

indoorMaps is a **security-facilities** planning tool. It lets you:

- **Author a multi-floor building** — trace rooms and corridors, set doors and vertical connections (stairs/elevators), and switch between floors.
- **Place and aim cameras** — position CCTV cameras, set their field of view, range, and type, and see their coverage rendered on the plan.
- **See truthful coverage** — camera sightlines are **clipped against walls** (line-of-sight occlusion), so covered area is what a camera can genuinely see and blind spots are genuinely blind. Cones do not pass through walls.
- **Classify access zones** — mark spaces public / secure / restricted, with a visualised secure perimeter and badge-reader markers.
- **Route through the building** — shortest-path wayfinding between spaces, including cross-floor routes and nearest-exit (egress) routing.
- **Annotate operations** — drop incident pins and draw or auto-generate patrol paths.
- **Query click → camera** — click any point on the plan and get the camera(s) that actually see it, ranked, with a live-feed placeholder (see [Inspect](#inspect--click-to-camera)).
- **Export deliverables** — an IMDF-style GeoJSON archive, a single-file GeoJSON, and a Markdown security report.

The differentiator is the **occlusion-based coverage engine**: everything else in the tool is organised around the question *"what can be seen from where?"*

---

## Core concepts

| Concept | Meaning |
|---|---|
| **Building** | The whole project: floors, spaces, doors, vertical links, cameras, zones, incidents, patrols, and any imported underlay. It is the single serializable unit. |
| **Level / floor (ordinal)** | Each floor has an integer `ordinal`. Only the active floor's content is shown and edited at a time. |
| **Unit / space** | A polygon on a floor with a **category** (room, office, corridor, …) and an optional **security level**. |
| **Opening** | A doorway on a unit's wall. A `door` connects a room to its corridor; an `entrance` connects an interior space to an outside area. |
| **Vertical link** | A stairs/elevator connection joining two spaces on different floors, enabling cross-floor routing. |
| **Camera** | A point on a floor with a heading, field-of-view angle, range, and type. Its **visibility polygon** (occlusion-clipped sightline) drives coverage. |
| **Coverage / blind spots** | The union of all cameras' visibility polygons (covered), and the floor area not in it (blind). Computed only from occlusion-clipped geometry. |
| **Security level** | An access classification (`public` / `secure` / `restricted`) — independent of a space's category. `restricted` also removes the space from routing. |

### The coverage engine (why it's trustworthy)

Each camera casts an exact visibility polygon: rays are aimed at every wall corner within its field of view and clipped to the nearest wall and to its range. Coverage (green) is the union of these polygons; blind area (red) is the floor minus coverage; the coverage percentage is measured inside the building footprint only. Because sightlines stop at walls, the tool never claims a camera sees into a room a wall is blocking.

*Current limitation:* doorways are treated as solid wall (a unit outline is a closed ring), so coverage is **conservatively under-reported** — the safe direction for security work.

---

## Getting started

**Requirements:** Node.js 18+ and npm.

```bash
npm install        # install dependencies
npm run dev        # start the dev server → http://localhost:5173
npm run build      # type-check + production build (tsc -b && vite build)
npm run preview    # serve the production build locally
```

The app opens on a **demo casino** — an irregular, two-level facility. Level 0 is a curved, no-right-angles gaming floor (a central concourse ringed by eight gaming-zone wedges, with structural columns that cast real occlusion shadows) and Level 1 is the rectangular staff back-of-house (Surveillance, Count Room, Vault, Server, Records). It's pre-fitted with 66 cameras by casino doctrine, giving ~98% gaming-floor and 100% back-of-house coverage. Switch floors and toggle **Coverage** / **Blind spots** to see the occlusion engine at work. All edits persist automatically to the browser's local storage; if you've edited a previous building, use **Data → Reset building** to load the demo.

**Stack:** Vite · React 18 · TypeScript · MapLibre GL JS (rendering) · Zustand (state) · polygon-clipping (boolean geometry) · lucide-react (icons) · self-hosted Geist fonts. No runtime network requests.

---

## The interface

The screen is a five-zone layout:

```
┌─────────────────────────────────────────────────────────┐
│  TOP BAR   wordmark · floor pills · Data ▾ · undo/redo   │
├──────┬──────────────────────────────────────┬───────────┤
│ TOOL │                                       │           │
│ RAIL │              CANVAS                    │ INSPECTOR │
│      │        (+ floating view controls)      │           │
├──────┴──────────────────────────────────────┴───────────┤
│  STATUS BAR   active tool · route/coverage · hint · grid │
└─────────────────────────────────────────────────────────┘
```

- **Top bar** — the building wordmark, **floor pills** to switch levels, the **Data** menu (import/export/reset), and **undo / redo** buttons.
- **Tool rail** (left) — one tool at a time; see the [tool reference](#tools).
- **Canvas** — the map. A floating **view-controls** cluster sits top-right (grid, dimensions, units, layers).
- **Inspector** (right) — a contextual panel whose contents depend on the active tool and selection.
- **Status bar** — the active tool, a live route/coverage summary, a context hint, and the grid state.

### View controls (top-right of the canvas)

| Control | Purpose |
|---|---|
| **Grid** | Toggle the snap grid; set its spacing in metres. |
| **Dimensions** | Toggle live measurements while drawing and on the selected space. |
| **m / ft** | Switch the unit of measurement. |
| **Layers ▾** | Show/hide each overlay independently (see [Layers](#layers)). |

---

## Workflows

### Author a floor

1. Pick a floor from the **floor pills**.
2. Select the **Rectangle** or **Polygon** tool and choose a **unit type** in the inspector.
3. **Rectangle:** drag to draw. **Polygon:** click each vertex; click the first point again or press **Enter** to close; **Esc** cancels.
4. Rename a space, change its category, or edit vertices from the **Properties** panel (select a space first). Drag the cyan **door dot** to move a doorway; **right-click** a door to make it an **entrance**.
5. **Edit vertices** tool: drag handles to reshape, click **+** to insert a vertex, right-click a handle to delete one.

### Connect floors

Use the **Vertical link** tool: click a space on one floor, switch floors, and click the space it connects to. Pick the kind (elevator / stairs) first — the endpoints are recoloured to match. Links appear in the panel and enable cross-floor routing.

### Place cameras

1. Select the **Cameras** tool and click to drop a camera on the active floor.
2. Select it to edit **name, type, heading, field of view, range**, and a **Stream / device** reference (see [Inspect](#inspect--click-to-camera)).
   - **Fixed** — a static sector. **Dome** — 360° (heading/FOV hidden). **PTZ** — a sector flagged as sweeping (coverage is shown for its current aim).
3. Drag the body to reposition; drag the rotation handle to aim.
4. Turn on **Coverage** (Layers popover, on by default) to see the green covered area and, with **Blind spots** on, the red gaps. The camera panel and status bar show the floor's coverage percentage.

### Access zones

Select a space, then set its **Security** to `secure` or `restricted` in Properties. Secure/restricted spaces render a dashed perimeter and a tint, with **badge-reader** markers on their doors. `restricted` spaces are additionally excluded from routing.

### Wayfinding & egress

Select the **Wayfinding** tool. In **Direct** mode, pick a **From** and **To** space to route between them (across floors via stairs/elevators). In **Egress** mode, pick a starting space and the tool routes to the **nearest exit**. Distance and floors are shown in the panel and status bar.

### Incidents & patrols

- **Incidents** — pick a kind and click the map to drop a pin; drag to move, select to edit its note, delete to remove.
- **Patrol paths** — with the tool active, click waypoints and **double-click** or press **Enter** to finish (**Esc** cancels). Or use **Auto-generate** to build a patrol that follows the building's circulation (it routes through corridors and doors, not straight lines through walls).

### Inspect — click-to-camera

The **Inspect** tool turns the plan into an operator preview. Click any point:

- It resolves which cameras' **occlusion-clipped** view contains that point, ranked nearest-first, and opens a **Live preview** — a feed placeholder for the best camera, its stream/device reference, the clicked coordinates, and an **"also visible from"** list (click to switch cameras).
- Click a blind spot → **"No camera covers this point."**

The feed is an inert placeholder — no video, no network. Each camera's **Stream / device** field (RTSP URL, NVR channel, device id) is where a live console would later attach real video.

### Import & export

Open the **Data** menu:

| Action | Result |
|---|---|
| **Import SVG…** | Trace an SVG floorplan's shapes into rooms, scaled to the plan width. |
| **Import floorplan image…** | Place a PNG/JPG underlay beneath the vector layers on the active floor (adjust width, opacity, and position in Floor contents). |
| **Export GeoJSON** | The whole building as a single IMDF-flavoured GeoJSON file. |
| **Export IMDF archive…** | A `.zip` with one GeoJSON FeatureCollection per feature type plus `camera.geojson` / `zone.geojson` and a manifest. |
| **Export security report…** | A Markdown report: camera inventory, coverage % per floor, and blind-spot summary. |
| **Load GeoJSON…** | Reload a previously exported single-file GeoJSON. |
| **Reset building** | Restore the sample building (undoable). |

---

## Reference

### Tools

| Tool | Purpose |
|---|---|
| **Select** | Select a space (click again to deselect); drag doors; right-click for a quick properties popup; shift-click for multi-select. |
| **Rectangle** | Drag a rectangular room. |
| **Polygon** | Click vertices; Enter / first-point to close. |
| **Edit vertices** | Reshape the selected space (drag / insert / delete handles). |
| **Vertical link** | Connect two spaces across floors (stairs/elevator). |
| **Wayfinding** | Route between spaces; Direct or nearest-exit (Egress) mode. |
| **Cameras** | Place, aim, and edit cameras. |
| **Incidents** | Drop and edit annotation pins. |
| **Patrol paths** | Draw or auto-generate guard routes. |
| **Inspect / live preview** | Click a point to get the cameras that see it. |

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` or `Ctrl + Y` | Redo |
| `Delete` / `Backspace` | Delete the selected space or camera |
| `Enter` | Close the current polygon / finish the current patrol |
| `Esc` | Cancel the current draft, deselect, or clear a probe |
| `Shift + click` | Add/remove a space from the multi-selection |
| Double-click (Patrol) | Finish the patrol path |
| Right-click (space) | Quick properties popup |
| Right-click (door / vertex) | Make entrance / delete vertex |

Undo/redo covers all building edits (spaces, doors, links, cameras, security, incidents, patrols, underlays). It is session-only and resets on reload. Shortcuts are ignored while typing in a text field.

### Layers

Toggle each overlay independently from the **Layers** popover: **Cameras** (markers), **Coverage** (green covered area + FOV cones), **Blind spots** (red gaps), **Access zones** (secure perimeters + badge readers), **Labels**, **Grid**, **Routes**, **Incidents**, **Patrol paths**. Layer preferences persist across reloads. Turning **Coverage** off removes the camera FOV cones as well, for a clean map.

### Space categories

`room`, `office`, `restroom`, `lobby`, `retail`, `storage`, `mechanical` (all selectable route endpoints) · `corridor`, `elevator`, `stairs` (circulation) · `outside` (walkable exterior). Each renders a distinct fill colour.

### Security levels

`public` (default) · `secure` (dashed amber perimeter + badge readers) · `restricted` (red perimeter, badge readers, **excluded from routing**). Security is independent of category — a "restricted office" is `{ category: office, security: restricted }`.

### Coverage colour key

Cyan = camera markers and FOV cones · Green = covered area · Red = blind spots · Amber/red dashed = secure/restricted perimeter.

---

## Data, files & privacy

- **Local-first & offline.** No backend, no telemetry, no network requests at runtime. Fonts are bundled; the map style is empty (no basemap tiles). Floorplans and camera layouts stay in the browser.
- **Persistence.** The building autosaves to `localStorage` (`indoormaps:building:v3`); layer preferences under `indoormaps:layers:v1`. Undo history is in-memory only and does not persist.
- **Imported images** are stored as data URLs; a very large image may exceed the storage quota, in which case its metadata persists but the image is session-only and must be re-imported (the underlay panel warns when this applies). The building itself always persists.
- **Data model** follows Apple's **IMDF** convention (GeoJSON FeatureCollections per feature type). Cameras and security zones are carried as additive app-extension features so standard IMDF consumers ignore them and the round-trip stays lossless.

---

## Architecture

A React UI over a single Zustand store, with the imperative MapLibre map isolated in one component and the domain logic in dependency-free pure modules:

| Module | Responsibility |
|---|---|
| `src/store.ts` | All application state, actions, undo/redo, and persistence. |
| `src/MapView.tsx` | The MapLibre map: sources, layers, HTML markers, and canvas interactions. |
| `src/ui/` | The shell (top bar, tool rail, inspector, panels, view controls, status bar). |
| `src/coverage.ts` | Camera geometry — visibility polygons (occlusion), coverage/blind-spot union. |
| `src/graph.ts`, `src/astar.ts` | Nav graph construction and shortest-path routing. |
| `src/geo.ts` | Metre ↔ lng/lat conversion and polygon math. |
| `src/imdf.ts`, `src/imdfArchive.ts`, `src/zip.ts`, `src/report.ts` | Export: single-file GeoJSON, IMDF archive, ZIP writer, security report. |
| `src/svgImport.ts` | SVG floorplan import. |
| `src/categories.ts`, `src/render.ts`, `src/format.ts` | Category taxonomy, GeoJSON projection, and formatting. |

The geometry and export modules are pure and framework-free; the map component reads store state and renders it, and never owns domain state.

---

## Roadmap

indoorMaps is the **authoring layer** of a planned live security console. The editor produces the spatial index the live system needs — camera positions, aiming, and occlusion-based coverage — and the **Inspect** tool prototypes the operator interaction end-to-end (click a point → the camera that actually sees it) on placeholder feeds. Wiring real video (via each camera's stream/device reference) is the intended next step and is plumbing over a model that already resolves click-to-camera correctly.

Other noted directions: risk-weighted blind spots (gaps ranked by the security level of the space they fall in), camera-optics presets, coverage targets / compliance flags, and camera-placement assistance.

---

## Known limitations

- **Doorways read as solid wall** for occlusion, so coverage is conservatively under-reported. Punching door-width gaps is a noted refinement.
- **PTZ cameras** show coverage for their current aim only; true swept-coverage is future work.
- **Auto-patrol** follows the nav graph but uses a greedy tour (not an optimal one).
- **Camera-ranking** in Inspect is by distance; angular-centering is a noted refinement.
- **IMDF archive re-import** is not yet implemented (single-file GeoJSON load covers reloading).
- No live video, no positioning/blue-dot, and no accounts — by design for this phase.
