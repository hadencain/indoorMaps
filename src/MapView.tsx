import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { MetreXY, Category, LngLat, RasterUnderlay } from "./types";
import type { FC } from "./render";
import { unitsToGeoJSON, patrolsToGeoJSON, fixturesToGeoJSON, footprintsToGeoJSON } from "./render";
import { INCIDENT_COLORS } from "./ui/panels/IncidentPanel";
import {
  ll2m,
  m2ll,
  distM,
  polygonRing,
  pointsToLL,
  polygonArea,
  snapPoint,
  nearestPointOnPolygon,
} from "./geo";
import { rectFromDrag } from "./building";
import { pointInRing } from "./coverage";
import type { VisibilityPolygon } from "./coverage";
import { gridToGeoJSON } from "./render";
import { formatLength, formatArea } from "./format";
import { CATEGORY_ORDER, CATEGORY_LABELS, functionFillExpression } from "./categories";
import { useStore } from "./store";
import { useRoute } from "./ui/route";
import { useVisibility } from "./ui/visibility";

const EMPTY: FC = { type: "FeatureCollection", features: [] };
/** 1×1 transparent pixel — placeholder image for the underlay source until a real one loads. */
const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Click within this many metres of the first vertex to close a polygon. */
const CLOSE_SNAP_M = 2.5;

export type DrawTool = "none" | "rect" | "polygon";

/** Renders the building + route; supports rectangle + polygon room authoring. */
export default function MapView() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const selectedIncidentId = useStore((s) => s.selectedIncidentId);
  const patrolDraft = useStore((s) => s.patrolDraft);
  const probe = useStore((s) => s.probe);
  const searchQuery = useStore((s) => s.searchQuery);
  const unit = useStore((s) => s.unit);
  const showDims = useStore((s) => s.showDims);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const { geom } = useRoute();
  const layers = useStore((s) => s.layers);
  const amenityFilter = useStore((s) => s.amenityFilter);
  const highlightedPatrolId = useStore((s) => s.highlightedPatrolId);
  // Occlusion-clipped visibility polygons for the active floor's cameras (P5) +
  // coverage/blind analysis (P6, null unless the coverage/blind layer is on). Recomputed off
  // the render path by the hook's memo (per-camera cache) — a camera drag/param
  // change recomputes only that camera; a wall move recomputes every camera on
  // the floor; everything else reuses the cache.
  const { polys: visPolys, coverage } = useVisibility();

  // Legacy internal interaction modes, derived from the single active tool.
  const drawTool: DrawTool =
    activeTool === "rect" ? "rect" : activeTool === "polygon" ? "polygon" : "none";
  const linkMode = activeTool === "link";
  const vertexEdit = activeTool === "vertex";
  const cameraMode = activeTool === "camera";
  const incidentMode = activeTool === "incident";
  const patrolMode = activeTool === "patrol";
  const inspectMode = activeTool === "inspect";
  const routeLines = geom?.lines ?? EMPTY;
  const routePoints = geom?.points ?? [];

  // Handlers come straight from the store (stable references).
  const onAddRoom = useStore((s) => s.addRoom);
  const onSelect = useStore((s) => s.setSelected);
  const onToggleSelected = useStore((s) => s.toggleSelected);
  const onMoveDoor = useStore((s) => s.moveDoor);
  const onToggleOpeningKind = useStore((s) => s.toggleOpeningKind);
  const onRename = useStore((s) => s.renameUnit);
  const onSetCategory = useStore((s) => s.setCategory);
  const onDelete = useStore((s) => s.deleteUnit);
  const onLinkUnit = useStore((s) => s.linkUnit);
  const onMoveVertex = useStore((s) => s.moveVertex);
  const onInsertVertex = useStore((s) => s.insertVertex);
  const onDeleteVertex = useStore((s) => s.deleteVertex);
  const onAddCamera = useStore((s) => s.addCamera);
  const onMoveCamera = useStore((s) => s.moveCamera);
  const onRotateCamera = useStore((s) => s.rotateCamera);
  const onSelectCamera = useStore((s) => s.setSelectedCamera);
  const onAddIncident = useStore((s) => s.addIncident);
  const onMoveIncident = useStore((s) => s.moveIncident);
  const onSelectIncident = useStore((s) => s.setSelectedIncident);
  const onAddPatrolPoint = useStore((s) => s.addPatrolPoint);
  const onCommitPatrol = useStore((s) => s.commitPatrol);
  const onCancelPatrol = useStore((s) => s.cancelPatrol);
  const onSetProbe = useStore((s) => s.setProbe);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  // Dedicated ref for the inspect-mode probe dot, managed only by the probe
  // effect so the main marker-rebuild effect can't wipe it out of sync.
  const probeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const measureRef = useRef<maplibregl.Marker | null>(null);
  const drawRef = useRef<{ poly: MetreXY[]; rectStart: MetreXY | null }>({
    poly: [],
    rectStart: null,
  });
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<{ unitId: string; x: number; y: number } | null>(null);

  const live = useRef({
    building,
    ordinal,
    drawTool,
    onAddRoom,
    onSelect,
    onToggleSelected,
    selectedId,
    selectedIds,
    unit,
    showDims,
    showGrid,
    gridSize,
    linkMode,
    onLinkUnit,
    vertexEdit,
    onMoveVertex,
    onInsertVertex,
    onDeleteVertex,
    cameraMode,
    selectedCameraId,
    onAddCamera,
    onMoveCamera,
    onRotateCamera,
    onSelectCamera,
    incidentMode,
    patrolMode,
    patrolDraft,
    selectedIncidentId,
    onAddIncident,
    onMoveIncident,
    onSelectIncident,
    onAddPatrolPoint,
    onCommitPatrol,
    onCancelPatrol,
    inspectMode,
    visPolys,
    probe,
    onSetProbe,
    layers,
  });
  live.current = {
    building,
    ordinal,
    drawTool,
    onAddRoom,
    onSelect,
    onToggleSelected,
    selectedId,
    selectedIds,
    unit,
    showDims,
    showGrid,
    gridSize,
    linkMode,
    onLinkUnit,
    vertexEdit,
    onMoveVertex,
    onInsertVertex,
    onDeleteVertex,
    cameraMode,
    selectedCameraId,
    onAddCamera,
    onMoveCamera,
    onRotateCamera,
    onSelectCamera,
    incidentMode,
    patrolMode,
    patrolDraft,
    selectedIncidentId,
    onAddIncident,
    onMoveIncident,
    onSelectIncident,
    onAddPatrolPoint,
    onCommitPatrol,
    onCancelPatrol,
    inspectMode,
    visPolys,
    probe,
    onSetProbe,
    layers,
  };

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b0d10" } }],
      },
      center: building.origin,
      zoom: 18,
      attributionControl: false,
      dragRotate: false, // right-drag is free for the properties menu
    });
    mapRef.current = map;
    // Metric scale bar — a professional-plan staple (bearing is locked to 0 since
    // dragRotate is off, so the plan is always true north-up).
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
    // Suppress the native browser context menu over the map (we render our own).
    containerRef.current.addEventListener("contextmenu", (e) => e.preventDefault());

    map.on("load", () => {
      // Raster floorplan underlay — image source seeded with a transparent pixel
      // and a degenerate placeholder rectangle; real image swapped in per-floor.
      const o = building.origin;
      map.addSource("underlay", {
        type: "image",
        url: TRANSPARENT_PX,
        coordinates: [
          [o[0], o[1] + 1e-4],
          [o[0] + 1e-4, o[1] + 1e-4],
          [o[0] + 1e-4, o[1]],
          [o[0], o[1]],
        ],
      });
      map.addSource("grid", { type: "geojson", data: EMPTY });
      // Building footprint (floor slab + exterior wall) + fixtures (furniture).
      map.addSource("footprint", { type: "geojson", data: footprintsToGeoJSON(building) });
      map.addSource("fixtures", { type: "geojson", data: fixturesToGeoJSON(building) });
      map.addSource("units", { type: "geojson", data: unitsToGeoJSON(building) });
      // Coverage (P6): green covered union + red blind = floor − covered. Fed by
      // the coverage effect; per-overlay visibility gated by the layers effect.
      map.addSource("coverage", { type: "geojson", data: EMPTY });
      map.addSource("blindspots", { type: "geojson", data: EMPTY });
      // Camera FOV: populated by the visibility effect from useVisibility() output.
      map.addSource("camera-fov", { type: "geojson", data: EMPTY });
      map.addSource("route", { type: "geojson", data: EMPTY });
      map.addSource("patrols", { type: "geojson", data: patrolsToGeoJSON(building) });
      map.addSource("draft", { type: "geojson", data: EMPTY });
      // Inspect-mode sightline: selected camera → probed point (P-inspect).
      map.addSource("probe-line", { type: "geojson", data: EMPTY });

      map.addLayer({
        id: "grid-line",
        type: "line",
        source: "grid",
        paint: { "line-color": "#243244", "line-width": 0.6 },
      });
      map.addLayer({
        id: "unit-fill",
        type: "fill",
        source: "units",
        paint: {
          "fill-color": functionFillExpression() as maplibregl.ExpressionSpecification,
          "fill-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "unit-outline",
        type: "line",
        source: "units",
        paint: { "line-color": "#31435c", "line-width": 1.5 },
      });
      // Secure-perimeter overlay (P8): translucent tint + dashed outline for
      // secure/restricted units. Filtered to those levels; floor filter applied
      // in the floor-filter effect. Gated by layers.accessZones (P9).
      const secureFilter: maplibregl.FilterSpecification = [
        "in",
        ["get", "security"],
        ["literal", ["secure", "restricted"]],
      ];
      map.addLayer({
        id: "unit-secure-fill",
        type: "fill",
        source: "units",
        paint: {
          "fill-color": [
            "match",
            ["get", "security"],
            "restricted",
            "#ff5c5c",
            "secure",
            "#f2c14e",
            "#f2c14e",
          ],
          // Restricted (BOH money rooms) reads harder than secure.
          "fill-opacity": ["match", ["get", "security"], "restricted", 0.32, 0.15] as maplibregl.ExpressionSpecification,
        },
        filter: secureFilter,
      });
      map.addLayer({
        id: "unit-secure-outline",
        type: "line",
        source: "units",
        paint: {
          "line-color": [
            "match",
            ["get", "security"],
            "restricted",
            "#ff5c5c",
            "secure",
            "#f2c14e",
            "#f2c14e",
          ],
          "line-width": ["match", ["get", "security"], "restricted", 2.6, 1.8] as maplibregl.ExpressionSpecification,
          "line-dasharray": [2, 2],
        },
        filter: secureFilter,
      });
      map.addLayer({
        id: "unit-selected",
        type: "line",
        source: "units",
        paint: { "line-color": "#f2c14e", "line-width": 2.5 },
        filter: ["==", ["get", "id"], "__none__"],
      });
      // Camera FOV cones (P4 = naive radial wedges; they pass through walls —
      // occlusion clipping arrives in P5, swapping only the source geometry).
      map.addLayer({
        id: "camera-fov-fill",
        type: "fill",
        source: "camera-fov",
        paint: { "fill-color": "#00d7cd", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "camera-fov-line",
        type: "line",
        source: "camera-fov",
        paint: { "line-color": "#00d7cd", "line-width": 1, "line-opacity": 0.5 },
      });
      map.addLayer({
        id: "camera-fov-selected",
        type: "line",
        source: "camera-fov",
        paint: { "line-color": "#5cf6ee", "line-width": 2 },
        filter: ["==", ["get", "cameraId"], "__none__"],
      });
      // Coverage (green) + blind (red) sit BELOW the camera-fov layers and above
      // unit-fill/outline: inserting each before "camera-fov-fill" yields the
      // order unit-* → coverage-fill → blind-fill → camera-fov-*. Translucent so
      // the category fills read through. Visibility gated by the layers effect.
      map.addLayer(
        {
          id: "coverage-fill",
          type: "fill",
          source: "coverage",
          paint: { "fill-color": "#2fbf71", "fill-opacity": 0.22 },
        },
        "camera-fov-fill",
      );
      map.addLayer(
        {
          id: "blind-fill",
          type: "fill",
          source: "blindspots",
          paint: { "fill-color": "#ff5c5c", "fill-opacity": 0.22 },
        },
        "camera-fov-fill",
      );
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#00d7cd", "line-width": 4 },
      });
      // Patrol paths (P10): dashed violet open polylines, floor-filtered + gated
      // by layers.patrols. Distinct from the cyan wayfinding route.
      map.addLayer({
        id: "patrol-line",
        type: "line",
        source: "patrols",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#8b7bff", "line-width": 2.5, "line-dasharray": [3, 2] },
      });
      // Sightline from the selected camera to the probed point (inspect mode).
      // Thin dashed accent line; sits above coverage, below draft/markers.
      map.addLayer({
        id: "probe-line",
        type: "line",
        source: "probe-line",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#5cf6ee",
          "line-width": 1.25,
          "line-dasharray": [2, 2],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "draft-fill",
        type: "fill",
        source: "draft",
        paint: { "fill-color": "#00d7cd", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "draft-line",
        type: "line",
        source: "draft",
        paint: { "line-color": "#00d7cd", "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "draft-point",
        type: "circle",
        source: "draft",
        paint: {
          "circle-radius": 4,
          "circle-color": "#00d7cd",
          "circle-stroke-color": "#0b0d10",
          "circle-stroke-width": 1.5,
        },
      });

      // Insert the underlay BELOW every vector layer (beforeId = grid-line, the
      // first vector layer) so it renders under grid/units/route. Hidden until a
      // floor with an underlay is active.
      map.addLayer(
        {
          id: "underlay",
          type: "raster",
          source: "underlay",
          layout: { visibility: "none" },
          paint: { "raster-opacity": 0.5, "raster-fade-duration": 0 },
        },
        "grid-line",
      );

      // Building footprint floor slab (warm carpet) — beneath everything (above
      // the underlay, below the grid), so the plan reads as an enclosed building.
      map.addLayer(
        { id: "footprint-fill", type: "fill", source: "footprint", paint: { "fill-color": "#191411", "fill-opacity": 1 } },
        "grid-line",
      );
      // Fixtures (tables/machines/bars) ABOVE the unit fills, BELOW coverage/cameras.
      map.addLayer(
        {
          id: "fixture-fill",
          type: "fill",
          source: "fixtures",
          paint: {
            "fill-color": [
              "match",
              ["get", "kind"],
              "blackjack", "#1f6b3a",
              "baccarat", "#1f6b3a",
              "poker", "#245c37",
              "roulette", "#2a7a45",
              "slot", "#3a2c1c",
              "bar", "#5a3d22",
              "counter", "#3a4048",
              "seating", "#2a2e36",
              "stage", "#3a2a44",
              "planter", "#1e3a24",
              "parking", "#5b6672",
              "car", "#2b3038",
              "#3a3f47",
            ],
            "fill-opacity": 0.95,
          },
        },
        "coverage-fill",
      );
      map.addLayer(
        { id: "fixture-line", type: "line", source: "fixtures", paint: { "line-color": "#0b0d10", "line-width": 0.5 } },
        "coverage-fill",
      );
      // Exterior wall with poché weight: a wide dark casing under a thin light
      // core, so the perimeter reads as a solid drawn wall (real-plan grammar).
      map.addLayer(
        { id: "footprint-wall-casing", type: "line", source: "footprint", paint: { "line-color": "#05070a", "line-width": 9, "line-opacity": 0.95 } },
        "coverage-fill",
      );
      map.addLayer(
        { id: "footprint-wall", type: "line", source: "footprint", paint: { "line-color": "#7c8898", "line-width": 2.4 } },
        "coverage-fill",
      );

      const b = new maplibregl.LngLatBounds();
      for (const f of unitsToGeoJSON(building).features) {
        for (const c of (f.geometry as GeoJSON.Polygon).coordinates[0]) {
          b.extend(c as [number, number]);
        }
      }
      map.fitBounds(b, { padding: 60, duration: 0 });

      bindDrawing(map);
      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Enter closes / Escape cancels an in-progress polygon.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (live.current.drawTool !== "polygon") return;
      if (e.key === "Enter") closePolygon();
      else if (e.key === "Escape") cancelDraft();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the unit / footprint / fixture sources when the building changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("units") as maplibregl.GeoJSONSource | undefined)?.setData(
      unitsToGeoJSON(building),
    );
    (map.getSource("footprint") as maplibregl.GeoJSONSource | undefined)?.setData(
      footprintsToGeoJSON(building),
    );
    (map.getSource("fixtures") as maplibregl.GeoJSONSource | undefined)?.setData(
      fixturesToGeoJSON(building),
    );
  }, [ready, building]);

  // Rebuild the patrol source when the building changes (adds/edits/deletes).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("patrols") as maplibregl.GeoJSONSource | undefined)?.setData(
      patrolsToGeoJSON(building),
    );
  }, [ready, building]);

  // Patrol draft preview — reuses the `draft` source (line + waypoint dots, no
  // fill). Runs only in patrol mode; commit/cancel set patrolDraft = null which
  // clears the source here. In other tools the polygon/rect flow owns `draft`.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (patrolMode) renderPatrolDraft(null);
    else draftSource()?.setData(EMPTY); // leaving patrol clears its preview
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, patrolDraft, patrolMode]);

  // Feed the camera-FOV source from the occlusion-clipped visibility polygons
  // (P5). Drop-in geometry swap of the old naive-cone source — same layers,
  // same projection, same floor filter — only the ring geometry is now honest.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("camera-fov") as maplibregl.GeoJSONSource | undefined)?.setData(
      visibilityToFC(building.origin, visPolys),
    );
  }, [ready, visPolys, building.origin]);

  // Coverage/blind overlays (P6) — occlusion-clipped, never cones. Source data
  // is populated whenever the analysis exists (coverage != null, i.e. the
  // coverage or blind-spots layer is on); per-overlay *visibility* is toggled
  // independently by the layer-visibility effect below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const cov = coverage
      ? ringsToFC(building.origin, coverage.coveredRings, coverage.ordinal)
      : EMPTY;
    const blind = coverage
      ? ringsToFC(building.origin, coverage.blindRings, coverage.ordinal)
      : EMPTY;
    (map.getSource("coverage") as maplibregl.GeoJSONSource | undefined)?.setData(cov);
    (map.getSource("blindspots") as maplibregl.GeoJSONSource | undefined)?.setData(blind);
  }, [ready, coverage, building.origin]);

  // Inspect-mode probe visuals: a dot at the probed point + a sightline from the
  // SELECTED camera to it. Managed independently of the main marker rebuild.
  // Cleared when probe is null (tool switch / Esc set it null in the store). The
  // sightline only draws when the selected camera is on the active floor.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const origin = building.origin;
    probeMarkerRef.current?.remove();
    probeMarkerRef.current = null;
    const lineSrc = map.getSource("probe-line") as maplibregl.GeoJSONSource | undefined;
    if (!probe) {
      lineSrc?.setData(EMPTY);
      return;
    }
    probeMarkerRef.current = new maplibregl.Marker({ element: labelEl("", "probe-dot") })
      .setLngLat(m2ll(origin, probe.point[0], probe.point[1]))
      .addTo(map);
    const cam = building.cameras.find((c) => c.id === selectedCameraId);
    if (cam && cam.ordinal === ordinal) {
      lineSrc?.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            m2ll(origin, cam.at[0], cam.at[1]),
            m2ll(origin, probe.point[0], probe.point[1]),
          ],
        },
      });
    } else {
      lineSrc?.setData(EMPTY);
    }
  }, [ready, probe, selectedCameraId, ordinal, building]);

  // Layer-visibility (P9): toggle managed native layers on/off. Guards every id
  // with getLayer so a not-yet-built layer (e.g. incidents, Phase E) is a silent
  // no-op. Base unit-fill/outline/selected are NEVER toggled — geometry is
  // always visible; layers gate overlays only.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    // The per-camera FOV cones ARE the coverage visualization (per-camera
    // line-of-sight), so they gate with Coverage, not Cameras — turning Coverage
    // off leaves a clean map (no lingering cone outlines). The camera MARKERS
    // stay under Cameras (gated in the marker effect).
    vis("camera-fov-fill", layers.coverage);
    vis("camera-fov-line", layers.coverage);
    vis("camera-fov-selected", layers.coverage);
    vis("coverage-fill", layers.coverage);
    vis("blind-fill", layers.blindSpots);
    vis("unit-secure-fill", layers.accessZones);
    vis("unit-secure-outline", layers.accessZones);
    vis("route-line", layers.routes);
    vis("patrol-line", layers.patrols);
    vis("fixture-fill", layers.fixtures);
    vis("fixture-line", layers.fixtures);
    vis("grid-line", showGrid);
  }, [ready, layers, showGrid]);

  // Search dim (P12): when the search box is non-empty, dim units on the floor
  // whose name/category doesn't match (case-insensitive substring); matches keep
  // full opacity. Purely visual — never changes selection. Empty query restores
  // the flat 0.9 fill. `index-of` returns >= 0 on a substring hit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("unit-fill")) return;
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      map.setPaintProperty("unit-fill", "fill-opacity", 0.9);
      return;
    }
    const match: maplibregl.ExpressionSpecification = [
      "any",
      [">=", ["index-of", q, ["downcase", ["get", "name"]]], 0],
      [">=", ["index-of", q, ["downcase", ["get", "category"]]], 0],
    ];
    map.setPaintProperty("unit-fill", "fill-opacity", [
      "case",
      match,
      0.9,
      0.12,
    ] as maplibregl.ExpressionSpecification);
  }, [ready, searchQuery]);

  // Rebuild the snap grid when toggled / resized / building extent changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("grid") as maplibregl.GeoJSONSource | undefined)?.setData(
      showGrid ? gridToGeoJSON(building, gridSize) : EMPTY,
    );
  }, [ready, showGrid, gridSize, building]);

  // Show the active floor's raster underlay (if any) beneath the vector layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("underlay") as maplibregl.ImageSource | undefined;
    if (!src) return;
    // Only render an underlay that still has its image (dataUrl may be "" after a
    // quota-stripped reload — its metadata persists, but re-import is required).
    const u = (building.underlays ?? []).find((x) => x.ordinal === ordinal && x.dataUrl);
    if (u) {
      src.updateImage({ url: u.dataUrl, coordinates: underlayCoordinates(u, building.origin) });
      map.setPaintProperty("underlay", "raster-opacity", u.opacity);
      map.setLayoutProperty("underlay", "visibility", "visible");
    } else {
      map.setLayoutProperty("underlay", "visibility", "none");
    }
  }, [ready, ordinal, building]);

  // Floor / route / selection changes: filter layers and rebuild HTML markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const floorFilter: maplibregl.FilterSpecification = ["==", ["get", "ordinal"], ordinal];
    map.setFilter("unit-fill", floorFilter);
    map.setFilter("unit-outline", floorFilter);
    map.setFilter("footprint-fill", floorFilter);
    map.setFilter("footprint-wall-casing", floorFilter);
    map.setFilter("footprint-wall", floorFilter);
    map.setFilter("fixture-fill", floorFilter);
    map.setFilter("fixture-line", floorFilter);
    map.setFilter("route-line", floorFilter);
    map.setFilter("patrol-line", floorFilter);
    map.setFilter("unit-selected", [
      "all",
      floorFilter,
      ["in", ["get", "id"], ["literal", selectedIds]],
    ]);
    map.setFilter("coverage-fill", floorFilter);
    map.setFilter("blind-fill", floorFilter);
    const secureOnFloor: maplibregl.FilterSpecification = [
      "all",
      floorFilter,
      ["in", ["get", "security"], ["literal", ["secure", "restricted"]]],
    ];
    map.setFilter("unit-secure-fill", secureOnFloor);
    map.setFilter("unit-secure-outline", secureOnFloor);
    map.setFilter("camera-fov-fill", floorFilter);
    map.setFilter("camera-fov-line", floorFilter);
    map.setFilter("camera-fov-selected", [
      "all",
      floorFilter,
      ["==", ["get", "cameraId"], selectedCameraId ?? "__none__"],
    ]);

    (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(routeLines);

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    // Room labels for the active floor (+ area when dimensions are shown).
    if (layers.labels) {
      const areaById = new Map(building.units.map((u) => [u.id, polygonArea(u.polygon)]));
      for (const f of unitsToGeoJSON(building).features) {
        const props = f.properties as {
          id: string;
          ordinal: number;
          name: string;
          category: string;
        };
        if (props.ordinal !== ordinal || props.category === "corridor") continue;
        const c = ringCentroid(
          (f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][],
        );
        const el = labelEl(props.name, "label");
        if (showDims) {
          const sub = document.createElement("div");
          sub.className = "label-sub";
          sub.textContent = formatArea(areaById.get(props.id) ?? 0, unit);
          el.appendChild(sub);
        }
        markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map));
      }
    }

    // Draggable door handles for the active floor (hidden while drawing / editing verts).
    if (drawTool === "none" && !vertexEdit) {
      const unitById = new Map(building.units.map((u) => [u.id, u]));
      for (const op of building.openings) {
        const owner = unitById.get(op.unit);
        if (!owner || owner.ordinal !== ordinal) continue;
        const el = labelEl("", op.kind === "entrance" ? "door door-entrance" : "door");
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(m2ll(building.origin, op.at[0], op.at[1]))
          .addTo(map);
        marker.on("dragend", () => {
          const ll = marker.getLngLat();
          let at = ll2m(building.origin, ll.lng, ll.lat);
          if (live.current.showGrid) at = snapPoint(at, live.current.gridSize);
          // Snap onto the owning room's nearest wall so doors sit on an edge.
          const o = live.current.building.units.find((u) => u.id === op.unit);
          if (o) at = nearestPointOnPolygon(at, o.polygon);
          onMoveDoor(op.id, at);
        });
        // Right-click a door handle to toggle it between door and entrance.
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onToggleOpeningKind(op.id);
        });
        markersRef.current.push(marker);
      }
    }

    // Badge-reader markers (P8): on openings whose OWNING unit is secure or
    // restricted. Derived from unit security only (Opening.kind has no "badge"
    // value). Annotation markers — non-draggable. Gated by layers.accessZones.
    if (layers.accessZones) {
      const secById = new Map(building.units.map((u) => [u.id, u.security ?? "public"]));
      for (const op of building.openings) {
        const sec = secById.get(op.unit);
        const owner = building.units.find((u) => u.id === op.unit);
        if (!owner || owner.ordinal !== ordinal) continue;
        if (sec !== "secure" && sec !== "restricted") continue;
        const el = labelEl("", `badge-reader badge-${sec}`);
        markersRef.current.push(
          new maplibregl.Marker({ element: el, draggable: false })
            .setLngLat(m2ll(building.origin, op.at[0], op.at[1]))
            .addTo(map),
        );
      }
    }

    // Vertex-edit handles for the selected unit on the active floor.
    if (vertexEdit && selectedId) {
      const u = building.units.find((x) => x.id === selectedId);
      if (u && u.ordinal === ordinal) {
        u.polygon.forEach((v, i) => {
          const el = labelEl("", "vhandle");
          const marker = new maplibregl.Marker({ element: el, draggable: true })
            .setLngLat(m2ll(building.origin, v[0], v[1]))
            .addTo(map);
          marker.on("dragend", () => {
            const ll = marker.getLngLat();
            let at = ll2m(building.origin, ll.lng, ll.lat);
            if (live.current.showGrid) at = snapPoint(at, live.current.gridSize);
            live.current.onMoveVertex(u.id, i, at);
          });
          el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            live.current.onDeleteVertex(u.id, i);
          });
          markersRef.current.push(marker);
        });
        // Midpoint "+" handles to insert a vertex on each edge.
        u.polygon.forEach((v, i) => {
          const b2 = u.polygon[(i + 1) % u.polygon.length];
          const mid: MetreXY = [(v[0] + b2[0]) / 2, (v[1] + b2[1]) / 2];
          const el = labelEl("+", "vadd");
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            live.current.onInsertVertex(u.id, i);
          });
          markersRef.current.push(
            new maplibregl.Marker({ element: el }).setLngLat(
              m2ll(building.origin, mid[0], mid[1]),
            ).addTo(map),
          );
        });
      }
    }

    // Route start / end / transition pins.
    if (layers.routes) {
      for (const p of routePoints) {
        if (p.ordinal !== ordinal) continue;
        markersRef.current.push(
          new maplibregl.Marker({ element: labelEl(p.label, `pin pin-${p.kind}`) })
            .setLngLat(p.lnglat)
            .addTo(map),
        );
      }
    }

    // Camera body markers. Cameras + FOV are visible on ALL tools, but placement,
    // drag, and rotation are only interactive under the camera tool. Gated by
    // layers.cameras (the FOV cones are gated in the layer-visibility effect).
    for (const cam of building.cameras) {
      if (!layers.cameras) break;
      if (cam.ordinal !== ordinal) continue;
      const isSelected = cam.id === selectedCameraId;
      const el = document.createElement("div");
      el.className = `camera ${cam.kind}` + (isSelected ? " selected" : "");
      const bodyEl = document.createElement("div");
      bodyEl.className = "camera-body";
      // CSS rotation is clockwise; metre heading is CCW (atan2). Screen y-up
      // matches metre y-up here, so the visual angle is `-heading` degrees.
      // Dome has no meaningful aim — leave its body unrotated.
      if (cam.kind !== "dome") bodyEl.style.transform = `rotate(${-cam.heading}deg)`;
      el.appendChild(bodyEl);

      const marker = new maplibregl.Marker({ element: el, draggable: cameraMode })
        .setLngLat(m2ll(building.origin, cam.at[0], cam.at[1]))
        .addTo(map);

      // Selecting a camera works under ANY tool (opens CameraPanel; mutually
      // exclusive with unit selection). stopPropagation keeps the map's
      // empty-click deselect from firing. Drag/aim stay camera-tool only.
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        live.current.onSelectCamera(cam.id);
      });
      if (cameraMode) {
        marker.on("dragend", () => {
          const ll = marker.getLngLat();
          let at = ll2m(live.current.building.origin, ll.lng, ll.lat);
          if (live.current.showGrid) at = snapPoint(at, live.current.gridSize);
          live.current.onMoveCamera(cam.id, at);
        });
        el.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          onCameraActivate(cam.id);
        });
      }
      markersRef.current.push(marker);

      // Rotation handle: only for the SELECTED, non-dome camera under the camera
      // tool. Placed along the heading a short distance out (capped for reach).
      if (cameraMode && isSelected && cam.kind !== "dome") {
        const handleLen = Math.min(cam.rangeM, 4);
        const h = (cam.heading * Math.PI) / 180;
        const handleAt: MetreXY = [
          cam.at[0] + Math.cos(h) * handleLen,
          cam.at[1] + Math.sin(h) * handleLen,
        ];
        const hEl = labelEl("", "cam-handle");
        const hMarker = new maplibregl.Marker({ element: hEl, draggable: true })
          .setLngLat(m2ll(building.origin, handleAt[0], handleAt[1]))
          .addTo(map);
        // Commit on dragend only: a live `drag` handler would rotate the camera
        // each tick, rebuilding all markers (building ref changes) and dropping
        // this handle mid-drag. Matches the door/vertex dragend pattern.
        hMarker.on("dragend", () => {
          const ll = hMarker.getLngLat();
          const p = ll2m(live.current.building.origin, ll.lng, ll.lat);
          const c = live.current.building.cameras.find((x) => x.id === cam.id);
          if (!c) return;
          const deg = (Math.atan2(p[1] - c.at[1], p[0] - c.at[0]) * 180) / Math.PI;
          live.current.onRotateCamera(cam.id, deg);
        });
        markersRef.current.push(hMarker);
      }
    }

    // Incident pins (P10): HTML markers colored by kind, floor-filtered, gated by
    // layers.incidents. Draggable + selectable only under the incident tool (like
    // camera markers): drag commits on dragend, click selects for note entry.
    if (layers.incidents) {
      for (const inc of building.incidents ?? []) {
        if (inc.ordinal !== ordinal) continue;
        const el = document.createElement("div");
        el.className = "inc-pin" + (inc.id === selectedIncidentId ? " selected" : "");
        el.style.background = INCIDENT_COLORS[inc.kind];
        el.title = inc.note || inc.kind;
        const marker = new maplibregl.Marker({ element: el, draggable: incidentMode })
          .setLngLat(m2ll(building.origin, inc.at[0], inc.at[1]))
          .addTo(map);
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (live.current.incidentMode) live.current.onSelectIncident(inc.id);
        });
        if (incidentMode) {
          marker.on("dragend", () => {
            const ll = marker.getLngLat();
            let at = ll2m(live.current.building.origin, ll.lng, ll.lat);
            if (live.current.showGrid) at = snapPoint(at, live.current.gridSize);
            live.current.onMoveIncident(inc.id, at);
          });
        }
        markersRef.current.push(marker);
      }
    }

    // Amenity POI markers (restrooms / ATMs / exits / info / …), gated by layers.
    if (layers.amenities) {
      const glyph: Record<string, string> = {
        restroom: "WC", atm: "$", exit: "EXIT", info: "i", firstaid: "+",
        ticketing: "TIX", dining: "F", bar: "B", coatcheck: "C", smoking: "S",
      };
      for (const am of building.amenities ?? []) {
        if (am.ordinal !== ordinal) continue;
        if (amenityFilter[am.kind] === false) continue; // per-kind display filter
        const el = labelEl(glyph[am.kind] ?? "?", `amenity amenity-${am.kind}`);
        el.title = am.name || am.kind;
        markersRef.current.push(
          new maplibregl.Marker({ element: el }).setLngLat(m2ll(building.origin, am.at[0], am.at[1])).addTo(map),
        );
      }
    }
  }, [ready, ordinal, routeLines, routePoints, building, drawTool, selectedId, selectedIds, selectedCameraId, cameraMode, incidentMode, selectedIncidentId, onMoveDoor, onToggleOpeningKind, unit, showDims, vertexEdit, layers, amenityFilter]);

  // Patrol highlight (display mode): emphasize the selected route, dim the rest.
  // Data-driven paint keyed on the feature `id` (patrolsToGeoJSON tags each line).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("patrol-line")) return;
    const hid = highlightedPatrolId;
    map.setPaintProperty("patrol-line", "line-width", hid ? ["case", ["==", ["get", "id"], hid], 5, 1.5] : 2.5);
    map.setPaintProperty("patrol-line", "line-opacity", hid ? ["case", ["==", ["get", "id"], hid], 1, 0.22] : 1);
    map.setPaintProperty("patrol-line", "line-color", hid ? ["case", ["==", ["get", "id"], hid], "#b6acff", "#6a5db0"] : "#8b7bff");
  }, [ready, highlightedPatrolId]);

  // Draw-tool changes: cursor, dbl-click zoom, and reset any in-progress draft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor =
      drawTool !== "none" || cameraMode || incidentMode || patrolMode || inspectMode
        ? "crosshair"
        : linkMode
          ? "pointer"
          : "";
    // Patrol needs double-click free to commit, so disable dbl-click zoom in it
    // too. Only the plain "none" (non-patrol) tools clear the in-progress draft.
    if (drawTool === "none" && !patrolMode) {
      map.doubleClickZoom.enable();
      cancelDraft();
    } else {
      map.doubleClickZoom.disable();
    }
  }, [ready, drawTool, linkMode, cameraMode, incidentMode, patrolMode, inspectMode]);

  // Patrol tool keyboard: Enter commits the draft, Escape cancels it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.patrolMode || live.current.patrolDraft === null) return;
      if (e.key === "Enter") live.current.onCommitPatrol();
      else if (e.key === "Escape") live.current.onCancelPatrol();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the properties menu on Escape, floor change, or if its unit is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      if (live.current.selectedCameraId) live.current.onSelectCamera(null);
      // Clear any inspect-mode probe (dot + sightline) without leaving the tool.
      if (live.current.probe) live.current.onSetProbe(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setMenu(null), [ordinal]);
  useEffect(() => {
    if (menu && !building.units.some((u) => u.id === menu.unitId)) setMenu(null);
  }, [building, menu]);

  const menuUnit = menu ? building.units.find((u) => u.id === menu.unitId) ?? null : null;

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />

      {drawTool === "polygon" && (
        <div className="shortcuts">
          <b>Polygon</b>
          <span>
            <kbd>Click</kbd> add vertex
          </span>
          <span>
            <kbd>Click first pt</kbd> / <kbd>Enter</kbd> close
          </span>
          <span>
            <kbd>Esc</kbd> / <kbd>Right-click</kbd> cancel
          </span>
          {live.current.showGrid && <span>snapping to {live.current.gridSize} m grid</span>}
        </div>
      )}
      {drawTool === "rect" && (
        <div className="shortcuts">
          <b>Rectangle</b>
          <span>
            <kbd>Drag</kbd> to draw
          </span>
          {showGrid && <span>snapping to {gridSize} m grid</span>}
        </div>
      )}
      {linkMode && drawTool === "none" && (
        <div className="shortcuts">
          <b>Link floors</b>
          <span>click a unit, switch floor, click its counterpart</span>
          <span>
            <kbd>Esc</kbd> deselect
          </span>
        </div>
      )}
      {vertexEdit && drawTool === "none" && (
        <div className="shortcuts">
          <b>Edit vertices</b>
          <span>
            <kbd>Drag</kbd> a handle to move
          </span>
          <span>
            <kbd>+</kbd> insert on edge
          </span>
          <span>
            <kbd>Right-click</kbd> a handle to delete
          </span>
          {showGrid && <span>snapping to {gridSize} m grid</span>}
        </div>
      )}
      {menu && menuUnit && (
        <div className="props-popup" style={{ left: menu.x, top: menu.y }}>
          <div className="props-head">
            <span>Properties</span>
            <button className="del" title="Close" onClick={() => setMenu(null)}>
              ✕
            </button>
          </div>
          <label>Name</label>
          <input
            autoFocus
            value={menuUnit.name}
            onChange={(e) => onRename(menuUnit.id, e.target.value)}
          />
          <label>Category</label>
          <select
            value={menuUnit.category}
            onChange={(e) => onSetCategory(menuUnit.id, e.target.value as Category)}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <button
            className="wide ghost danger"
            onClick={() => {
              onDelete(menuUnit.id);
              setMenu(null);
            }}
          >
            Delete unit
          </button>
        </div>
      )}
    </div>
  );

  // ---- draft rendering (component scope; hoisted) ----
  function draftSource(): maplibregl.GeoJSONSource | undefined {
    return mapRef.current?.getSource("draft") as maplibregl.GeoJSONSource | undefined;
  }
  function cancelDraft() {
    drawRef.current.poly = [];
    drawRef.current.rectStart = null;
    draftSource()?.setData(EMPTY);
    clearMeasure();
  }
  function setDraft(verts: MetreXY[], cursor: MetreXY | null) {
    const origin = live.current.building.origin;
    const features: GeoJSON.Feature[] = [];
    if (verts.length >= 3) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [polygonRing(origin, verts)] },
      });
    }
    const linePts = cursor ? [...verts, cursor] : verts;
    if (linePts.length >= 2) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: pointsToLL(origin, linePts) },
      });
    }
    for (const v of verts) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: pointsToLL(origin, [v])[0] },
      });
    }
    draftSource()?.setData({ type: "FeatureCollection", features });
  }
  function closePolygon() {
    const { poly } = drawRef.current;
    if (poly.length >= 3) live.current.onAddRoom([...poly], live.current.ordinal);
    cancelDraft();
  }
  // Patrol draft preview into the shared `draft` source: an OPEN polyline (no
  // fill) through committed waypoints, optionally rubber-banding to `cursor`.
  // A null/empty draft clears the preview.
  function renderPatrolDraft(cursor: MetreXY | null) {
    const pts = live.current.patrolDraft;
    const origin = live.current.building.origin;
    if (!pts || pts.length === 0) {
      draftSource()?.setData(EMPTY);
      return;
    }
    const features: GeoJSON.Feature[] = [];
    const linePts = cursor ? [...pts, cursor] : pts;
    if (linePts.length >= 2) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: pointsToLL(origin, linePts) },
      });
    }
    for (const v of pts) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: pointsToLL(origin, [v])[0] },
      });
    }
    draftSource()?.setData({ type: "FeatureCollection", features });
  }
  function setMeasure(at: MetreXY, text: string) {
    const map = mapRef.current;
    if (!map) return;
    const ll = m2ll(live.current.building.origin, at[0], at[1]);
    if (!measureRef.current) {
      measureRef.current = new maplibregl.Marker({
        element: labelEl("", "measure"),
        anchor: "left",
        offset: [12, 0],
      })
        .setLngLat(ll)
        .addTo(map);
    }
    measureRef.current.setLngLat(ll);
    measureRef.current.getElement().textContent = text;
  }
  function clearMeasure() {
    measureRef.current?.remove();
    measureRef.current = null;
  }

  // Deeper camera click-through (open live feed / incident timeline) is a wired
  // no-op stub in P4. A later phase fills this in; the double-click seam exists
  // so the wiring is present but currently does nothing.
  function onCameraActivate(_id: string) {
    /* stub — intentionally no-op in P4 */
  }

  // ---- event wiring (bound once; reads live/drawRef) ----
  function bindDrawing(map: maplibregl.Map) {
    const toMetre = (ll: maplibregl.LngLat): MetreXY => {
      const p = ll2m(live.current.building.origin, ll.lng, ll.lat);
      return live.current.showGrid ? snapPoint(p, live.current.gridSize) : p;
    };

    map.on("mousedown", (e) => {
      if (live.current.drawTool !== "rect") return;
      e.preventDefault();
      map.dragPan.disable();
      drawRef.current.rectStart = toMetre(e.lngLat);
    });

    map.on("mousemove", (e) => {
      const tool = live.current.drawTool;
      const cur = toMetre(e.lngLat);
      const { unit: u, showDims: dims } = live.current;
      if (tool === "rect" && drawRef.current.rectStart) {
        const start = drawRef.current.rectStart;
        setDraft(rectFromDrag(start, cur), null);
        if (dims) {
          setMeasure(
            cur,
            `${formatLength(Math.abs(cur[0] - start[0]), u)} × ` +
              `${formatLength(Math.abs(cur[1] - start[1]), u)}`,
          );
        } else clearMeasure();
      } else if (tool === "polygon" && drawRef.current.poly.length > 0) {
        const poly = drawRef.current.poly;
        setDraft(poly, cur);
        if (dims) {
          const edge = distM(poly[poly.length - 1], cur);
          const area = polygonArea([...poly, cur]);
          setMeasure(cur, `${formatLength(edge, u)} · ${formatArea(area, u)}`);
        } else clearMeasure();
      } else if (
        live.current.patrolMode &&
        live.current.patrolDraft &&
        live.current.patrolDraft.length > 0
      ) {
        renderPatrolDraft(cur);
      }
    });

    map.on("mouseup", (e) => {
      if (live.current.drawTool !== "rect" || !drawRef.current.rectStart) return;
      const rect = rectFromDrag(drawRef.current.rectStart, toMetre(e.lngLat));
      drawRef.current.rectStart = null;
      draftSource()?.setData(EMPTY);
      clearMeasure();
      map.dragPan.enable();
      const [x0, y0, x1, y1] = [rect[0][0], rect[0][1], rect[2][0], rect[2][1]];
      if (x1 - x0 >= 2 && y1 - y0 >= 2) {
        live.current.onAddRoom(rect, live.current.ordinal);
      }
    });

    // Patrol mode: double-click commits the draft (needs >= 2 points).
    map.on("dblclick", (e) => {
      if (!live.current.patrolMode || live.current.patrolDraft === null) return;
      e.preventDefault();
      live.current.onCommitPatrol();
    });

    map.on("contextmenu", (e) => {
      const tool = live.current.drawTool;
      if (tool === "polygon") {
        e.preventDefault();
        cancelDraft();
        return;
      }
      // Patrol mode: right-click cancels the in-progress draft.
      if (live.current.patrolMode && live.current.patrolDraft !== null) {
        e.preventDefault();
        live.current.onCancelPatrol();
        return;
      }
      if (tool !== "none") return;
      const hits = map.queryRenderedFeatures(e.point, { layers: ["unit-fill"] });
      const id = hits[0]?.properties?.id as string | undefined;
      if (id) {
        e.preventDefault();
        live.current.onSelect(id);
        setMenu({ unitId: id, x: e.point.x, y: e.point.y });
      } else {
        setMenu(null);
      }
    });

    map.on("click", (e) => {
      const tool = live.current.drawTool;
      if (tool === "none") {
        setMenu(null);
        // Camera mode: an empty-canvas click places a new camera. (Clicks on a
        // camera marker are consumed by the marker's own listener and never
        // reach the map.)
        if (live.current.cameraMode) {
          const at = toMetre(e.lngLat);
          live.current.onAddCamera(at, live.current.ordinal);
          return;
        }
        // Incident mode: empty-canvas click drops a pin (existing pins consume
        // their own click). New pin is auto-selected for note entry.
        if (live.current.incidentMode) {
          live.current.onAddIncident(toMetre(e.lngLat), live.current.ordinal);
          return;
        }
        // Inspect mode: resolve which cameras actually SEE the clicked point via
        // the occlusion-clipped visibility rings (P5, NOT radial cones), ranked
        // nearest-camera-first, and stash the transient probe. The raw click
        // point is used (no grid snap) so the hit test matches the pixel clicked.
        if (live.current.inspectMode) {
          const origin = live.current.building.origin;
          const pt = ll2m(origin, e.lngLat.lng, e.lngLat.lat);
          const ord = live.current.ordinal;
          const ringById = new Map(
            live.current.visPolys.map((v) => [v.cameraId, v.ring]),
          );
          const hits = live.current.building.cameras.filter((c) => {
            if (c.ordinal !== ord) return false;
            const ring = ringById.get(c.id);
            return !!ring && ring.length >= 3 && pointInRing(pt, ring);
          });
          hits.sort((a, b) => distM(a.at, pt) - distM(b.at, pt));
          const rankedIds = hits.map((c) => c.id);
          live.current.onSetProbe({ point: pt, cameraIds: rankedIds });
          live.current.onSelectCamera(rankedIds[0] ?? null);
          return;
        }
        // Patrol mode: click adds a waypoint (the draft is auto-armed on entering
        // the tool). The 2nd click of a double-click (detail > 1) is the commit
        // gesture — skip it so double-clicking to finish doesn't dump spurious
        // waypoints at the end; the dblclick handler commits.
        if (live.current.patrolMode) {
          if (e.originalEvent.detail > 1) return;
          // addPatrolPoint treats a null draft as [] — so clicks auto-start a
          // fresh patrol on entering the tool and again after each commit.
          live.current.onAddPatrolPoint(toMetre(e.lngLat));
          return;
        }
        const hits = map.queryRenderedFeatures(e.point, { layers: ["unit-fill"] });
        const id = hits[0]?.properties?.id as string | undefined;
        // Any empty-canvas click clears a selected camera (mutually exclusive
        // with unit selection). Unit hits below clear it via setSelected.
        if (!id && live.current.selectedCameraId) live.current.onSelectCamera(null);
        // Link mode: feed the click to the vertical-connection flow instead.
        if (live.current.linkMode) {
          if (id) live.current.onLinkUnit(id);
          return;
        }
        // Vertex-edit: switch the edited room on a hit, but keep it on empty clicks.
        if (live.current.vertexEdit) {
          if (id) live.current.onSelect(id);
          return;
        }
        // Shift-click a unit adds/removes it from the multi-selection (bulk edit).
        if (id && e.originalEvent.shiftKey) {
          live.current.onToggleSelected(id);
          return;
        }
        // Plain select: clicking the currently-selected unit toggles it off.
        const cur = live.current.selectedId;
        live.current.onSelect(id && id === cur ? null : (id ?? null));
        return;
      }
      if (tool !== "polygon") return;
      const p = toMetre(e.lngLat);
      const poly = drawRef.current.poly;
      if (poly.length >= 3 && distM(p, poly[0]) < CLOSE_SNAP_M) {
        closePolygon();
        return;
      }
      poly.push(p);
      setDraft(poly, null);
    });
  }
}

/** The four lng/lat corners of a raster underlay, in MapLibre image-source order
 *  [top-left, top-right, bottom-right, bottom-left]. Metre rectangle anchored at
 *  the SW corner (`offset`), sized `widthM` × `heightM` (aspect-preserved), then
 *  rotated CCW by `rotation` degrees about that SW corner. */
function underlayCoordinates(
  u: RasterUnderlay,
  origin: LngLat,
): [LngLat, LngLat, LngLat, LngLat] {
  const heightM = u.widthM * (u.naturalH / u.naturalW);
  const [ox, oy] = u.offset;
  const rad = (u.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rot = (x: number, y: number): LngLat => {
    const dx = x - ox;
    const dy = y - oy;
    return m2ll(origin, ox + dx * cos - dy * sin, oy + dx * sin + dy * cos);
  };
  // top = north (higher y); bottom = south. SW = (ox, oy).
  const nw = rot(ox, oy + heightM);
  const ne = rot(ox + u.widthM, oy + heightM);
  const se = rot(ox + u.widthM, oy);
  const sw = rot(ox, oy);
  return [nw, ne, se, sw];
}

/** Build the camera-FOV FeatureCollection from occlusion-clipped visibility
 *  polygons (P5): one Polygon per camera, tagged `{ cameraId, ordinal }` for
 *  floor-filtering + selection highlighting. Each `ring` is real line-of-sight
 *  (walls clip the sightline) — no longer the wall-piercing naive cone. */
function visibilityToFC(origin: LngLat, visPolys: VisibilityPolygon[]): FC {
  const features: GeoJSON.Feature[] = visPolys.map((vp) => ({
    type: "Feature",
    properties: { cameraId: vp.cameraId, ordinal: vp.ordinal },
    geometry: {
      type: "Polygon",
      coordinates: [polygonRing(origin, vp.ring)],
    },
  }));
  return { type: "FeatureCollection", features };
}

/** Metre rings → floor-tagged Polygon FeatureCollection (coverage / blind
 *  overlays). One feature per ring; projected to lng/lat via `polygonRing`. */
function ringsToFC(origin: LngLat, rings: MetreXY[][], ordinal: number): FC {
  const features: GeoJSON.Feature[] = rings.map((r) => ({
    type: "Feature",
    properties: { ordinal },
    geometry: { type: "Polygon", coordinates: [polygonRing(origin, r)] },
  }));
  return { type: "FeatureCollection", features };
}

function ringCentroid(ring: [number, number][]): [number, number] {
  const pts = ring.slice(0, -1);
  let x = 0;
  let y = 0;
  for (const [lng, lat] of pts) {
    x += lng;
    y += lat;
  }
  return [x / pts.length, y / pts.length];
}

function labelEl(text: string, cls: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return el;
}
