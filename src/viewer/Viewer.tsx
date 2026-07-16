import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Building, MetreXY, Occupant } from "../types";
import type { FC } from "../render";
import { unitsToGeoJSON, fixturesToGeoJSON, footprintsToGeoJSON } from "../render";
import { m2ll, bbox } from "../geo";
import { functionFillExpression } from "../categories";
import { occupantAnchor } from "../occupants";
import { amenityIconSvg, amenityBadgeStyle } from "../ui/amenity-icons";
import { selectableUnits } from "../building";
import type { Unit as LengthUnit } from "../format";
import { useViewerRoute } from "./route";
import Directory from "./Directory";
import RouteFinder from "./RouteFinder";

const EMPTY: FC = { type: "FeatureCollection", features: [] };

/**
 * Self-contained read-only viewer (Phase C). Own React state — NO store, NO
 * mutations, NO draw/edit tools. Renders the visitor-relevant subset of what
 * MapView shows: units/footprints/fixtures + wayfinding, no cameras/coverage/
 * patrols/incidents/secure layers (the embedded building is already stripped
 * of that data by `toVisitorBuilding` before export, but the map init here
 * doesn't even wire up the layers/sources for it — structurally absent).
 */
export default function Viewer({ building, propertyName }: { building: Building; propertyName: string }) {
  const levels = useMemo(() => [...building.levels].sort((a, b) => a.ordinal - b.ordinal), [building.levels]);
  const rooms = useMemo(() => selectableUnits(building), [building]);
  const unitsFC = useMemo(() => unitsToGeoJSON(building), [building]);
  const footprintFC = useMemo(() => footprintsToGeoJSON(building), [building]);
  const fixturesFC = useMemo(() => fixturesToGeoJSON(building), [building]);

  const [ordinal, setOrdinal] = useState<number>(levels[0]?.ordinal ?? 0);
  const [startId, setStartId] = useState<string>(rooms[0]?.id ?? "");
  const [goalId, setGoalId] = useState<string>(rooms[rooms.length - 1]?.id ?? "");
  const [query, setQuery] = useState("");
  const [view3d, setView3d] = useState(false);
  const [lengthUnit, setLengthUnit] = useState<LengthUnit>("m");
  const [panel, setPanel] = useState<"directory" | "route">("directory");
  const [flyTarget, setFlyTarget] = useState<{ ordinal: number; center: MetreXY } | null>(null);
  const [bearingDeg, setBearingDeg] = useState(0);
  const [ready, setReady] = useState(false);
  const [stepFree, setStepFree] = useState(false);

  const route = useViewerRoute(building, startId, goalId, stepFree);
  const routeLines = route.geom?.lines ?? EMPTY;
  const routePoints = route.geom?.points ?? [];

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Init the map once. Blank style (no glyphs/sprite/tiles — the file://
  // requirement: zero external fetches), sources/layers for the
  // visitor-relevant subset only.
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
      dragRotate: false, // enabled only in 3D (see the view3d effect)
    });
    mapRef.current = map;
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
    containerRef.current.addEventListener("contextmenu", (e) => e.preventDefault());

    map.on("load", () => {
      map.addSource("footprint", { type: "geojson", data: footprintFC });
      map.addSource("fixtures", { type: "geojson", data: fixturesFC });
      map.addSource("units", { type: "geojson", data: unitsFC });
      map.addSource("route", { type: "geojson", data: EMPTY });

      // Building footprint (floor slab + exterior wall) — beneath everything.
      map.addLayer({
        id: "footprint-fill",
        type: "fill",
        source: "footprint",
        paint: { "fill-color": "#191411", "fill-opacity": 1 },
      });
      map.addLayer({
        id: "footprint-wall-casing",
        type: "line",
        source: "footprint",
        paint: { "line-color": "#05070a", "line-width": 9, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "footprint-wall",
        type: "line",
        source: "footprint",
        paint: { "line-color": "#7c8898", "line-width": 2.4 },
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

      // Fixtures (tables/machines/bars) above unit fills.
      map.addLayer({
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
            "craps", "#256e52",
            "wheel", "#7a5a2a",
            "#3a3f47",
          ] as maplibregl.ExpressionSpecification,
          "fill-opacity": 0.95,
        },
      });
      map.addLayer({
        id: "fixture-line",
        type: "line",
        source: "fixtures",
        paint: { "line-color": "#0b0d10", "line-width": 0.5 },
      });

      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#00d7cd", "line-width": 4 },
      });

      // 3D extrusions (Phase A recipe): hidden until view3d. Heights already
      // synthesized into the units/fixtures GeoJSON (`heightM` property).
      map.addLayer({
        id: "unit-extrude",
        type: "fill-extrusion",
        source: "units",
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": functionFillExpression() as maplibregl.ExpressionSpecification,
          "fill-extrusion-height": ["get", "heightM"],
          "fill-extrusion-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "fixture-extrude",
        type: "fill-extrusion",
        source: "fixtures",
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": "#39424d",
          "fill-extrusion-height": ["get", "heightM"],
          "fill-extrusion-opacity": 0.85,
        },
      });

      frameBuilding(map, building);
      map.on("rotate", () => setBearingDeg(Math.round(map.getBearing())));
      map.on("zoom", () => updateZoomDeclutter(map, containerRef.current));
      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3D toggle: tilt + enable drag-rotate, matching the Phase A recipe.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (map.getLayer("unit-extrude"))
      map.setLayoutProperty("unit-extrude", "visibility", view3d ? "visible" : "none");
    if (map.getLayer("fixture-extrude"))
      map.setLayoutProperty("fixture-extrude", "visibility", view3d ? "visible" : "none");
    if (view3d) {
      map.dragRotate.enable();
      map.easeTo({ pitch: 55, duration: 600 });
    } else {
      map.dragRotate.disable();
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }, [ready, view3d]);

  // Search dim: non-matching units fade on the active floor. Same expression
  // MapView uses for the authoring canvas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("unit-fill")) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      map.setPaintProperty("unit-fill", "fill-opacity", 0.9);
      if (map.getLayer("unit-extrude")) {
        map.setPaintProperty(
          "unit-extrude",
          "fill-extrusion-color",
          functionFillExpression() as maplibregl.ExpressionSpecification,
        );
      }
      return;
    }
    const match: maplibregl.ExpressionSpecification = [
      "any",
      [">=", ["index-of", q, ["downcase", ["get", "name"]]], 0],
      [">=", ["index-of", q, ["downcase", ["get", "category"]]], 0],
      [">=", ["index-of", q, ["downcase", ["get", "occupant"]]], 0],
    ];
    map.setPaintProperty("unit-fill", "fill-opacity", ["case", match, 0.9, 0.12] as maplibregl.ExpressionSpecification);
    if (map.getLayer("unit-extrude")) {
      const fillExpr = functionFillExpression() as maplibregl.ExpressionSpecification;
      map.setPaintProperty("unit-extrude", "fill-extrusion-color", [
        "case",
        match,
        fillExpr,
        "#131a22",
      ] as maplibregl.ExpressionSpecification);
    }
  }, [ready, query]);

  // Floor filter + route line + imperative markers (labels, amenity badges,
  // route pins). Rebuilt whenever the floor or route changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const floorFilter: maplibregl.FilterSpecification = ["==", ["get", "ordinal"], ordinal];
    map.setFilter("unit-fill", floorFilter);
    map.setFilter("unit-outline", floorFilter);
    map.setFilter("unit-extrude", floorFilter);
    map.setFilter("footprint-fill", floorFilter);
    map.setFilter("footprint-wall-casing", floorFilter);
    map.setFilter("footprint-wall", floorFilter);
    map.setFilter("fixture-fill", floorFilter);
    map.setFilter("fixture-line", floorFilter);
    map.setFilter("fixture-extrude", floorFilter);
    map.setFilter("route-line", floorFilter);

    (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(routeLines);

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    // Room / occupant labels for the active floor (skip circulation — their
    // labels only collide, same call as MapView).
    const unitById = new Map(building.units.map((u) => [u.id, u]));
    const occByUnit = new Map<string, Occupant[]>();
    for (const o of building.occupants ?? []) {
      const arr = occByUnit.get(o.unitId);
      if (arr) arr.push(o);
      else occByUnit.set(o.unitId, [o]);
    }
    for (const f of unitsFC.features) {
      const props = f.properties as { id: string; ordinal: number; name: string; category: string };
      if (
        props.ordinal !== ordinal ||
        props.category === "corridor" ||
        props.category === "stairs" ||
        props.category === "elevator"
      )
        continue;
      const occs = unitById.get(props.id) ? occByUnit.get(props.id) ?? [] : [];
      if (occs.length > 0) {
        // Occupied: the business name is the label, one per occupant, at its anchor.
        const uu = unitById.get(props.id)!;
        const [bx0, , bx1] = bbox(uu.polygon);
        for (const o of occs) {
          const at = occupantAnchor(building, o);
          const el = labelEl(o.name, "label");
          el.dataset.wm = String(Math.max(1, bx1 - bx0));
          markersRef.current.push(
            new maplibregl.Marker({ element: el }).setLngLat(m2ll(building.origin, at[0], at[1])).addTo(map),
          );
        }
        continue;
      }
      const c = ringCentroid((f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]);
      const el = labelEl(props.name, "label");
      const u = unitById.get(props.id);
      if (u) {
        const [x0, , x1] = bbox(u.polygon);
        el.dataset.wm = String(Math.max(1, x1 - x0));
      }
      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map));
    }

    // Amenity POI badges (custom pictograms) for the active floor.
    for (const am of building.amenities ?? []) {
      if (am.ordinal !== ordinal) continue;
      const el = document.createElement("div");
      el.className = `amenity amenity-${am.kind}`;
      el.innerHTML = amenityIconSvg(am.kind, 12);
      const badge = amenityBadgeStyle(am.kind);
      el.style.background = badge.background;
      el.style.color = badge.color;
      el.title = am.name || am.kind;
      markersRef.current.push(
        new maplibregl.Marker({ element: el }).setLngLat(m2ll(building.origin, am.at[0], am.at[1])).addTo(map),
      );
    }

    // Route start / end / transition pins for the active floor.
    for (const p of routePoints) {
      if (p.ordinal !== ordinal) continue;
      markersRef.current.push(
        new maplibregl.Marker({ element: labelEl(p.label, `pin pin-${p.kind}`) }).setLngLat(p.lnglat).addTo(map),
      );
    }

    updateZoomDeclutter(map, containerRef.current);
  }, [ready, ordinal, building, unitsFC, routeLines, routePoints]);

  // Directory-initiated "show on map": switch floor first if needed, then
  // ease once the floor-filter effect above has run for that ordinal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTarget) return;
    if (flyTarget.ordinal === ordinal) {
      map.easeTo({ center: m2ll(building.origin, flyTarget.center[0], flyTarget.center[1]), duration: 450 });
      setFlyTarget(null);
    } else if (levels.some((l) => l.ordinal === flyTarget.ordinal)) {
      setOrdinal(flyTarget.ordinal);
      // keep flyTarget — this effect re-runs once ordinal catches up, then eases
    } else {
      setFlyTarget(null);
    }
  }, [ready, flyTarget, ordinal, building.origin, levels]);

  return (
    <div className="viewer-shell">
      <header className="viewer-topbar">
        <div className="wordmark">{propertyName}</div>
        <div className="floorpills">
          {levels.map((lv) => (
            <button
              key={lv.ordinal}
              className={lv.ordinal === ordinal ? "active" : ""}
              onClick={() => setOrdinal(lv.ordinal)}
            >
              {lv.name}
            </button>
          ))}
        </div>
        <div className="viewer-topbar-spacer" />
        <div className="unittoggle">
          <button className={lengthUnit === "m" ? "active" : ""} onClick={() => setLengthUnit("m")}>
            m
          </button>
          <button className={lengthUnit === "ft" ? "active" : ""} onClick={() => setLengthUnit("ft")}>
            ft
          </button>
        </div>
        <button
          className={`viewer-3d-btn ${view3d ? "active" : ""}`}
          title="3D view (tilt & rotate)"
          onClick={() => setView3d((v) => !v)}
        >
          3D
        </button>
      </header>
      <div className="viewer-body">
        <div className="canvas-zone">
          <div ref={containerRef} className="map" />
          {(view3d || bearingDeg !== 0) && (
            <button
              className="compass"
              title="Reset to north-up"
              onClick={() =>
                mapRef.current?.easeTo({
                  bearing: 0,
                  ...(view3d ? {} : { pitch: 0 }),
                  duration: 400,
                })
              }
            >
              <span className="compass-arrow" style={{ transform: `rotate(${-bearingDeg}deg)` }}>
                ▲
              </span>
              <span className="compass-n">N</span>
            </button>
          )}
        </div>
        <aside className="viewer-inspector">
          <div className="searchbox">
            <input
              value={query}
              placeholder="Search name, tenant, or type…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="searchclear" title="Clear search" onClick={() => setQuery("")}>
                ✕
              </button>
            )}
          </div>
          <div className="modetoggle" role="group" aria-label="Panel">
            <button className={panel === "directory" ? "active" : ""} onClick={() => setPanel("directory")}>
              Directory
            </button>
            <button className={panel === "route" ? "active" : ""} onClick={() => setPanel("route")}>
              Directions
            </button>
          </div>
          {panel === "directory" ? (
            <Directory
              building={building}
              onGo={(_unitId, targetOrdinal, center) => setFlyTarget({ ordinal: targetOrdinal, center })}
            />
          ) : (
            <RouteFinder
              building={building}
              startId={startId}
              goalId={goalId}
              setStartId={setStartId}
              setGoalId={setGoalId}
              route={route}
              lengthUnit={lengthUnit}
              stepFree={stepFree}
              setStepFree={setStepFree}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** Frame the viewport on the building. Bounds come from the units; a building
 *  with no unit geometry falls back to a fixed zoom on the local-metre origin. */
function frameBuilding(map: maplibregl.Map, building: Building): void {
  const b = new maplibregl.LngLatBounds();
  for (const f of unitsToGeoJSON(building).features)
    for (const c of (f.geometry as GeoJSON.Polygon).coordinates[0]) b.extend(c as [number, number]);
  if (!b.isEmpty()) map.fitBounds(b, { padding: 60, duration: 0 });
  else map.jumpTo({ center: m2ll(building.origin, 20, 15), zoom: 16 });
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

/** Zoom declutter (labels + amenity badges only — no camera markers in the
 *  visitor viewer): a label wider than its room on screen at the current
 *  zoom is culled; amenity badges collapse to identity-colored dots at
 *  plan-wide zooms. Mirrors MapView's updateZoomDeclutter, trimmed to what
 *  the viewer renders. */
function updateZoomDeclutter(map: maplibregl.Map, container: HTMLDivElement | null): void {
  if (!container) return;
  const lat = map.getCenter().lat;
  const ppm = (512 * Math.pow(2, map.getZoom())) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  container.classList.toggle("amenities-compact", ppm < 4.5);
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".label[data-wm]"))) {
    if (!el.dataset.lw && el.offsetWidth > 0) el.dataset.lw = String(el.offsetWidth);
    const need = (el.dataset.lw ? parseFloat(el.dataset.lw) : el.offsetWidth) + 4;
    const roomPx = parseFloat(el.dataset.wm!) * ppm;
    el.classList.toggle("label-hidden", roomPx < need);
  }
}
