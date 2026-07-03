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
