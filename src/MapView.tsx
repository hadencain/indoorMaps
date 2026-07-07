import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { MetreXY, Category, LngLat, RasterUnderlay } from "./types";
import type { FC } from "./render";
import { unitsToGeoJSON } from "./render";
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
import type { VisibilityPolygon } from "./coverage";
import { gridToGeoJSON } from "./render";
import { formatLength, formatArea } from "./format";
import { CATEGORY_ORDER, CATEGORY_LABELS, categoryFillExpression } from "./categories";
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
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const unit = useStore((s) => s.unit);
  const showDims = useStore((s) => s.showDims);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const { geom } = useRoute();
  // Occlusion-clipped visibility polygons for the active floor's cameras (P5).
  // Recomputed off the render path by the hook's memo (per-camera cache) — a
  // camera drag/param change recomputes only that camera; a wall move recomputes
  // every camera on the floor; everything else reuses the cache.
  const visPolys = useVisibility();

  // Legacy internal interaction modes, derived from the single active tool.
  const drawTool: DrawTool =
    activeTool === "rect" ? "rect" : activeTool === "polygon" ? "polygon" : "none";
  const linkMode = activeTool === "link";
  const vertexEdit = activeTool === "vertex";
  const cameraMode = activeTool === "camera";
  const routeLines = geom?.lines ?? EMPTY;
  const routePoints = geom?.points ?? [];

  // Handlers come straight from the store (stable references).
  const onAddRoom = useStore((s) => s.addRoom);
  const onSelect = useStore((s) => s.setSelected);
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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
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
    selectedId,
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
  });
  live.current = {
    building,
    ordinal,
    drawTool,
    onAddRoom,
    onSelect,
    selectedId,
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
      map.addSource("units", { type: "geojson", data: unitsToGeoJSON(building) });
      // Camera FOV: populated by the visibility effect from useVisibility() output.
      map.addSource("camera-fov", { type: "geojson", data: EMPTY });
      map.addSource("route", { type: "geojson", data: EMPTY });
      map.addSource("draft", { type: "geojson", data: EMPTY });

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
          "fill-color": categoryFillExpression() as maplibregl.ExpressionSpecification,
          "fill-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "unit-outline",
        type: "line",
        source: "units",
        paint: { "line-color": "#31435c", "line-width": 1.5 },
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
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#00d7cd", "line-width": 4 },
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

  // Rebuild the unit source when the building changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("units") as maplibregl.GeoJSONSource | undefined)?.setData(
      unitsToGeoJSON(building),
    );
  }, [ready, building]);

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
    map.setFilter("route-line", floorFilter);
    map.setFilter("unit-selected", [
      "all",
      floorFilter,
      ["==", ["get", "id"], selectedId ?? "__none__"],
    ]);
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
    const areaById = new Map(building.units.map((u) => [u.id, polygonArea(u.polygon)]));
    for (const f of unitsToGeoJSON(building).features) {
      const props = f.properties as {
        id: string;
        ordinal: number;
        name: string;
        category: string;
      };
      if (props.ordinal !== ordinal || props.category === "corridor") continue;
      const c = ringCentroid((f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]);
      const el = labelEl(props.name, "label");
      if (showDims) {
        const sub = document.createElement("div");
        sub.className = "label-sub";
        sub.textContent = formatArea(areaById.get(props.id) ?? 0, unit);
        el.appendChild(sub);
      }
      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map));
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
    for (const p of routePoints) {
      if (p.ordinal !== ordinal) continue;
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(p.label, `pin pin-${p.kind}`) })
          .setLngLat(p.lnglat)
          .addTo(map),
      );
    }

    // Camera body markers. Cameras + FOV are visible on ALL tools, but placement,
    // drag, and rotation are only interactive under the camera tool.
    for (const cam of building.cameras) {
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

      if (cameraMode) {
        marker.on("dragend", () => {
          const ll = marker.getLngLat();
          let at = ll2m(live.current.building.origin, ll.lng, ll.lat);
          if (live.current.showGrid) at = snapPoint(at, live.current.gridSize);
          live.current.onMoveCamera(cam.id, at);
        });
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          live.current.onSelectCamera(cam.id);
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
  }, [ready, ordinal, routeLines, routePoints, building, drawTool, selectedId, selectedCameraId, cameraMode, onMoveDoor, onToggleOpeningKind, unit, showDims, vertexEdit]);

  // Draw-tool changes: cursor, dbl-click zoom, and reset any in-progress draft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor =
      drawTool !== "none" || cameraMode ? "crosshair" : linkMode ? "pointer" : "";
    if (drawTool === "none") {
      map.doubleClickZoom.enable();
      cancelDraft();
    } else {
      map.doubleClickZoom.disable();
    }
  }, [ready, drawTool, linkMode, cameraMode]);

  // Close the properties menu on Escape, floor change, or if its unit is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      if (live.current.selectedCameraId) live.current.onSelectCamera(null);
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

    map.on("contextmenu", (e) => {
      const tool = live.current.drawTool;
      if (tool === "polygon") {
        e.preventDefault();
        cancelDraft();
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
        const hits = map.queryRenderedFeatures(e.point, { layers: ["unit-fill"] });
        const id = hits[0]?.properties?.id as string | undefined;
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
