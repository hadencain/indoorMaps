import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { MetreXY, Category } from "./types";
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
import { gridToGeoJSON } from "./render";
import { formatLength, formatArea } from "./format";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "./categories";
import { useStore } from "./store";
import { useRoute } from "./ui/route";

const EMPTY: FC = { type: "FeatureCollection", features: [] };
/** Click within this many metres of the first vertex to close a polygon. */
const CLOSE_SNAP_M = 2.5;

export type DrawTool = "none" | "rect" | "polygon";

/** Renders the building + route; supports rectangle + polygon room authoring. */
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

  // Legacy internal interaction modes, derived from the single active tool.
  const drawTool: DrawTool =
    activeTool === "rect" ? "rect" : activeTool === "polygon" ? "polygon" : "none";
  const linkMode = activeTool === "link";
  const vertexEdit = activeTool === "vertex";
  const routeLines = geom?.lines ?? EMPTY;
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
  });
  live.current = {
    building,
    ordinal,
    drawTool,
    onAddRoom,
    onSelect,
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
      map.addSource("grid", { type: "geojson", data: EMPTY });
      map.addSource("units", { type: "geojson", data: unitsToGeoJSON(building) });
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
          "fill-color": [
            "match",
            ["get", "category"],
            "corridor", "#1a2230",
            "elevator", "#0e3b3a",
            "stairs", "#3a2e14",
            "#171f2b",
          ],
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

  // Rebuild the snap grid when toggled / resized / building extent changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("grid") as maplibregl.GeoJSONSource | undefined)?.setData(
      showGrid ? gridToGeoJSON(building, gridSize) : EMPTY,
    );
  }, [ready, showGrid, gridSize, building]);

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
        const el = labelEl("", "door");
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
  }, [ready, ordinal, routeLines, routePoints, building, drawTool, selectedId, onMoveDoor, unit, showDims, vertexEdit]);

  // Draw-tool changes: cursor, dbl-click zoom, and reset any in-progress draft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor =
      drawTool !== "none" ? "crosshair" : linkMode ? "pointer" : "";
    if (drawTool === "none") {
      map.doubleClickZoom.enable();
      cancelDraft();
    } else {
      map.doubleClickZoom.disable();
    }
  }, [ready, drawTool, linkMode]);

  // Close the properties menu on Escape, floor change, or if its unit is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
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
        live.current.onSelect(id ?? null);
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
