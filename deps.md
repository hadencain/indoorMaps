# indoorMaps dependencies

## Runtime
- react, react-dom — UI
- maplibre-gl — WebGL indoor map rendering (empty style, offline)
- zustand — app state store
- lucide-react — icon set (tool rail, menus)
- polygon-clipping — Martinez boolean geometry (union/difference/intersection) for
  camera coverage + blind-spot analysis (P6). Runs in metre-space, no network.
- @fontsource-variable/geist, @fontsource-variable/geist-mono — self-hosted Geist fonts (CSP-safe, offline)

## Dev
- vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom

## Notes
- No network at runtime: fonts bundled, map style empty.
- Pure logic modules: geo, graph, astar, render, format, svgImport, imdf. `coverage`
  is pure but now imports `polygon-clipping` (P6 boolean geometry).
- `polygon-clipping` ships its own `.d.ts` (`declare module "polygon-clipping"` with
  named exports) but its ESM build exports only `default`. Bundler module resolution
  synthesizes a default whose namespace carries the named ops, so a plain default
  import (`import pc from "polygon-clipping"; pc.union(...)`) type-checks AND resolves
  at runtime — no local shim needed.

## Security pivot (cameras)
- Phase C1 / P4: camera placement + naive radial FOV cones (`coverage.ts` `sectorRing`,
  kept as the documented fallback). No dependency.
- Phase C2 / P5: wall occlusion — `collectWalls` + `raySegmentT` + `computeVisibility`
  (exact endpoint-casting visibility polygons). Dependency-free.
- Phase C2 / P6: coverage + blind-spot analysis — `computeCoverage` unions the
  occlusion-clipped visibility polygons and differences against the floor. Adds the
  `polygon-clipping` dependency (above).
