import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Building } from "./types";
import type { FC, RoutePoint } from "./render";
import { unitsToGeoJSON } from "./render";

const EMPTY: FC = { type: "FeatureCollection", features: [] };

interface Props {
  building: Building;
  ordinal: number;
  routeLines: FC;
  routePoints: RoutePoint[];
}

/** Renders the building + route in MapLibre, filtered to the active floor. */
export default function MapView({ building, ordinal, routeLines, routePoints }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      // No basemap: a self-contained empty style — no tiles, glyphs, or fonts,
      // so nothing leaves the machine and there are no external requests.
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
            /* room */ "#171f2b",
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

      // Fit to the building footprint.
      const b = new maplibregl.LngLatBounds();
      for (const f of unitsToGeoJSON(building).features) {
        const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
        for (const c of ring) b.extend(c as [number, number]);
      }
      map.fitBounds(b, { padding: 60, duration: 0 });

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // building is static for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to floor / route changes: filter layers and rebuild HTML markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const floorFilter: maplibregl.FilterSpecification = [
      "==",
      ["get", "ordinal"],
      ordinal,
    ];
    map.setFilter("unit-fill", floorFilter);
    map.setFilter("unit-outline", floorFilter);
    map.setFilter("route-line", floorFilter);

    (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(routeLines);

    // Clear old markers.
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    // Unit labels for the active floor.
    for (const f of unitsToGeoJSON(building).features) {
      const props = f.properties as { ordinal: number; name: string; category: string };
      if (props.ordinal !== ordinal || props.category === "corridor") continue;
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      const c = ringCentroid(ring as [number, number][]);
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(props.name, "label") }).setLngLat(c).addTo(map),
      );
    }

    // Route markers for the active floor.
    for (const p of routePoints) {
      if (p.ordinal !== ordinal) continue;
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(p.label, `pin pin-${p.kind}`) })
          .setLngLat(p.lnglat)
          .addTo(map),
      );
    }
  }, [ready, ordinal, routeLines, routePoints, building]);

  return <div ref={containerRef} className="map" />;
}

function ringCentroid(ring: [number, number][]): [number, number] {
  // Average of the 4 distinct corners (ring is closed, so drop the last).
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
