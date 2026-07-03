import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Building, MetreXY } from "./types";
import type { FC, RoutePoint } from "./render";
import { unitsToGeoJSON } from "./render";
import { ll2m, distM, polygonRing, pointsToLL } from "./geo";
import { rectFromDrag } from "./building";

const EMPTY: FC = { type: "FeatureCollection", features: [] };
/** Click within this many metres of the first vertex to close a polygon. */
const CLOSE_SNAP_M = 2.5;

export type DrawTool = "none" | "rect" | "polygon";

interface Props {
  building: Building;
  ordinal: number;
  drawTool: DrawTool;
  routeLines: FC;
  routePoints: RoutePoint[];
  onAddRoom: (polygon: MetreXY[], ordinal: number) => void;
}

/** Renders the building + route; supports rectangle + polygon room authoring. */
export default function MapView({
  building,
  ordinal,
  drawTool,
  routeLines,
  routePoints,
  onAddRoom,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const drawRef = useRef<{ poly: MetreXY[]; rectStart: MetreXY | null }>({
    poly: [],
    rectStart: null,
  });
  const [ready, setReady] = useState(false);

  const live = useRef({ building, ordinal, drawTool, onAddRoom });
  live.current = { building, ordinal, drawTool, onAddRoom };

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
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("units", { type: "geojson", data: unitsToGeoJSON(building) });
      map.addSource("route", { type: "geojson", data: EMPTY });
      map.addSource("draft", { type: "geojson", data: EMPTY });

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

  // Floor / route changes: filter layers and rebuild HTML markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const floorFilter: maplibregl.FilterSpecification = ["==", ["get", "ordinal"], ordinal];
    map.setFilter("unit-fill", floorFilter);
    map.setFilter("unit-outline", floorFilter);
    map.setFilter("route-line", floorFilter);

    (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(routeLines);

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    for (const f of unitsToGeoJSON(building).features) {
      const props = f.properties as { ordinal: number; name: string; category: string };
      if (props.ordinal !== ordinal || props.category === "corridor") continue;
      const c = ringCentroid((f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]);
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(props.name, "label") }).setLngLat(c).addTo(map),
      );
    }

    for (const p of routePoints) {
      if (p.ordinal !== ordinal) continue;
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(p.label, `pin pin-${p.kind}`) })
          .setLngLat(p.lnglat)
          .addTo(map),
      );
    }
  }, [ready, ordinal, routeLines, routePoints, building]);

  // Draw-tool changes: cursor, dbl-click zoom, and reset any in-progress draft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = drawTool === "none" ? "" : "crosshair";
    if (drawTool === "none") {
      map.doubleClickZoom.enable();
      cancelDraft();
    } else {
      map.doubleClickZoom.disable();
    }
  }, [ready, drawTool]);

  return <div ref={containerRef} className="map" />;

  // ---- draft rendering (component scope; hoisted) ----
  function draftSource(): maplibregl.GeoJSONSource | undefined {
    return mapRef.current?.getSource("draft") as maplibregl.GeoJSONSource | undefined;
  }
  function cancelDraft() {
    drawRef.current.poly = [];
    drawRef.current.rectStart = null;
    draftSource()?.setData(EMPTY);
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

  // ---- event wiring (bound once; reads live/drawRef) ----
  function bindDrawing(map: maplibregl.Map) {
    const toMetre = (ll: maplibregl.LngLat): MetreXY =>
      ll2m(live.current.building.origin, ll.lng, ll.lat);

    map.on("mousedown", (e) => {
      if (live.current.drawTool !== "rect") return;
      e.preventDefault();
      map.dragPan.disable();
      drawRef.current.rectStart = toMetre(e.lngLat);
    });

    map.on("mousemove", (e) => {
      const tool = live.current.drawTool;
      const cur = toMetre(e.lngLat);
      if (tool === "rect" && drawRef.current.rectStart) {
        setDraft(rectFromDrag(drawRef.current.rectStart, cur), null);
      } else if (tool === "polygon" && drawRef.current.poly.length > 0) {
        setDraft(drawRef.current.poly, cur);
      }
    });

    map.on("mouseup", (e) => {
      if (live.current.drawTool !== "rect" || !drawRef.current.rectStart) return;
      const rect = rectFromDrag(drawRef.current.rectStart, toMetre(e.lngLat));
      drawRef.current.rectStart = null;
      draftSource()?.setData(EMPTY);
      map.dragPan.enable();
      const [x0, y0, x1, y1] = [rect[0][0], rect[0][1], rect[2][0], rect[2][1]];
      if (x1 - x0 >= 2 && y1 - y0 >= 2) {
        live.current.onAddRoom(rect, live.current.ordinal);
      }
    });

    map.on("click", (e) => {
      if (live.current.drawTool !== "polygon") return;
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
