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
- Pure logic modules (no deps): geo, graph, astar, render, format, svgImport, imdf, coverage.

## Security pivot (cameras)
- Phase C1 / P4 adds camera placement + naive radial FOV cones (`coverage.ts` `sectorRing`).
  No new npm dependency in P4 — cones are computed from local geometry only.
- `polygon-clipping` (coverage union/difference for blind-spot analysis) is a **next-phase**
  (P6) addition, NOT installed yet. P5 (occlusion ray-casting) also stays dependency-free.
