import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Building, MetreXY } from "./types";
import type { FC, RoutePoint } from "./render";
import { unitsToGeoJSON } from "./render";
import { ll2m, rectRing } from "./geo";
import { normaliseRect } from "./building";

const EMPTY: FC = { type: "FeatureCollection", features: [] };

interface Props {
  building: Building;
  ordinal: number;
  editMode: boolean;
  routeLines: FC;
  routePoints: RoutePoint[];
  onAddRoom: (rect: [number, number, number, number], ordinal: number) => void;
}

/** Renders the building + route in MapLibre; supports drawing rooms in edit mode. */
export default function MapView({
  building,
  ordinal,
  editMode,
  routeLines,
  routePoints,
  onAddRoom,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);

  // Latest props for the once-bound draw handlers to read.
  const live = useRef({ building, ordinal, editMode, onAddRoom });
  live.current = { building, ordinal, editMode, onAddRoom };

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      // Self-contained empty style — no tiles, glyphs, or fonts, no external requests.
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

  // Rebuild the unit source whenever the building changes (rooms added/renamed).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("units") as maplibregl.GeoJSONSource | undefined)?.setData(
      unitsToGeoJSON(building),
    );
  }, [ready, building]);

  // React to floor / route changes: filter layers and rebuild HTML markers.
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

  // Toggle the draw cursor / pan behaviour with edit mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = editMode ? "crosshair" : "";
  }, [ready, editMode]);

  return <div ref={containerRef} className="map" />;

  // --- drawing (bound once; reads live.current for latest props) ---
  function bindDrawing(map: maplibregl.Map) {
    let start: MetreXY | null = null;

    const draft = () => map.getSource("draft") as maplibregl.GeoJSONSource;
    const toMetre = (ll: maplibregl.LngLat): MetreXY =>
      ll2m(live.current.building.origin, ll.lng, ll.lat);
    const draftFC = (rect: [number, number, number, number]): FC => ({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [rectRing(live.current.building.origin, rect)],
          },
        },
      ],
    });

    map.on("mousedown", (e) => {
      if (!live.current.editMode) return;
      e.preventDefault();
      map.dragPan.disable();
      start = toMetre(e.lngLat);
    });

    map.on("mousemove", (e) => {
      if (!live.current.editMode || !start) return;
      draft().setData(draftFC(normaliseRect(start, toMetre(e.lngLat))));
    });

    const finish = (e: maplibregl.MapMouseEvent) => {
      if (!start) return;
      const rect = normaliseRect(start, toMetre(e.lngLat));
      start = null;
      draft().setData(EMPTY);
      map.dragPan.enable();
      // Ignore accidental clicks / tiny drags (< ~2m on a side).
      if (rect[2] - rect[0] >= 2 && rect[3] - rect[1] >= 2) {
        live.current.onAddRoom(rect, live.current.ordinal);
      }
    };
    map.on("mouseup", finish);
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
