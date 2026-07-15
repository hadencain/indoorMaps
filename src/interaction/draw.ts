import maplibregl from "maplibre-gl";
import type { Building, MetreXY } from "../types";
import {
  ll2m,
  m2ll,
  distM,
  polygonRing,
  pointsToLL,
  polygonArea,
} from "../geo";
import { rectFromDrag } from "../building";
import { formatLength, formatArea } from "../format";
import { snapDrawPoint, metresPerPixel, type SnapResult } from "./snapping";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** Screen-space snap tolerance in pixels (converted to metres per event). */
export const SNAP_PX = 10;

export type DrawTool = "none" | "rect" | "polygon";

/** The slice of MapView's live snapshot the draw controller reads. */
export interface DrawLive {
  building: Building;
  ordinal: number;
  drawTool: DrawTool;
  unit: "m" | "ft";
  showDims: boolean;
  showGrid: boolean;
  gridSize: number;
  patrolMode: boolean;
  patrolDraft: MetreXY[] | null;
  cameraMode: boolean;
  incidentMode: boolean;
  inspectMode: boolean;
  linkMode: boolean;
  vertexEdit: boolean;
  selectedId: string | null;
  selectedCameraId: string | null;
  onAddRoom: (polygon: MetreXY[], ordinal: number) => void;
  onSelect: (id: string | null) => void;
  onToggleSelected: (id: string) => void;
  onLinkUnit: (id: string) => void;
  onAddCamera: (at: MetreXY, ordinal: number) => void;
  onAddIncident: (at: MetreXY, ordinal: number) => void;
  onAddPatrolPoint: (at: MetreXY) => void;
  onCommitPatrol: () => void;
  onCancelPatrol: () => void;
  onSetProbe: (p: { point: MetreXY } | null) => void;
  onSelectCamera: (id: string | null) => void;
  visPolys: { cameraId: string; ring: MetreXY[] }[];
}

export interface DrawDeps {
  live: () => DrawLive;
  setMenu: (m: { unitId: string; x: number; y: number } | null) => void;
  /** Inspect-mode click resolution stays in MapView (needs rankCamerasForPoint). */
  onInspectClick: (pt: MetreXY) => void;
}

export interface DrawHandle {
  cancelDraft(): void;
  closePolygon(): void;
  renderPatrolDraft(cursor: MetreXY | null): void;
}

export function bindDrawing(map: maplibregl.Map, deps: DrawDeps): DrawHandle {
  const draw: { poly: MetreXY[]; rectStart: MetreXY | null } = { poly: [], rectStart: null };
  let measure: maplibregl.Marker | null = null;
  let snapTick: maplibregl.Marker | null = null;

  // -- snapping ---------------------------------------------------------
  /** Raw lnglat → snapped metre point. `prev` enables axis-align (polygon mode). */
  function toSnapped(ll: maplibregl.LngLat, prev: MetreXY | null): SnapResult {
    const l = deps.live();
    const raw = ll2m(l.building.origin, ll.lng, ll.lat);
    const tolM = SNAP_PX * metresPerPixel(map.getZoom(), map.getCenter().lat);
    const polygons = l.building.units
      .filter((u) => u.ordinal === l.ordinal)
      .map((u) => u.polygon);
    return snapDrawPoint(raw, {
      polygons,
      prev,
      gridSize: l.showGrid ? l.gridSize : null,
      tolM,
    });
  }

  function showSnapTick(r: SnapResult) {
    const origin = deps.live().building.origin;
    if (r.kind === "vertex" || r.kind === "edge") {
      if (!snapTick) {
        snapTick = new maplibregl.Marker({ element: el("", "snap-tick") }).setLngLat(
          m2ll(origin, r.point[0], r.point[1]),
        );
        snapTick.addTo(map);
      }
      snapTick.setLngLat(m2ll(origin, r.point[0], r.point[1]));
      snapTick.getElement().dataset.kind = r.kind;
    } else {
      snapTick?.remove();
      snapTick = null;
    }
  }

  // -- draft rendering (moved verbatim from MapView, refs localized) -----
  function draftSource(): maplibregl.GeoJSONSource | undefined {
    return map.getSource("draft") as maplibregl.GeoJSONSource | undefined;
  }
  function cancelDraft() {
    draw.poly = [];
    draw.rectStart = null;
    draftSource()?.setData(EMPTY);
    clearMeasure();
    snapTick?.remove();
    snapTick = null;
  }
  function setDraft(verts: MetreXY[], cursor: MetreXY | null) {
    const origin = deps.live().building.origin;
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
    const l = deps.live();
    if (draw.poly.length >= 3) l.onAddRoom([...draw.poly], l.ordinal);
    cancelDraft();
  }
  function renderPatrolDraft(cursor: MetreXY | null) {
    const l = deps.live();
    const pts = l.patrolDraft;
    const origin = l.building.origin;
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
    const ll = m2ll(deps.live().building.origin, at[0], at[1]);
    if (!measure) {
      measure = new maplibregl.Marker({ element: el("", "measure"), anchor: "left", offset: [12, 0] })
        .setLngLat(ll)
        .addTo(map);
    }
    measure.setLngLat(ll);
    measure.getElement().textContent = text;
  }
  function clearMeasure() {
    measure?.remove();
    measure = null;
  }

  // -- event wiring -------------------------------------------------------
  map.on("mousedown", (e) => {
    const l = deps.live();
    if (l.drawTool !== "rect") return;
    e.preventDefault();
    map.dragPan.disable();
    const r = toSnapped(e.lngLat, null);
    draw.rectStart = r.point;
  });

  map.on("mousemove", (e) => {
    const l = deps.live();
    const tool = l.drawTool;
    if (tool === "rect" && draw.rectStart) {
      const r = toSnapped(e.lngLat, null);
      showSnapTick(r);
      const cur = r.point;
      const start = draw.rectStart;
      setDraft(rectFromDrag(start, cur), null);
      if (l.showDims) {
        setMeasure(
          cur,
          `${formatLength(Math.abs(cur[0] - start[0]), l.unit)} × ` +
            `${formatLength(Math.abs(cur[1] - start[1]), l.unit)}`,
        );
      } else clearMeasure();
    } else if (tool === "polygon" && draw.poly.length > 0) {
      const prev = draw.poly[draw.poly.length - 1];
      const r = toSnapped(e.lngLat, prev);
      showSnapTick(r);
      const cur = r.point;
      setDraft(draw.poly, cur);
      if (l.showDims) {
        const edge = distM(prev, cur);
        const angle =
          (Math.atan2(cur[1] - prev[1], cur[0] - prev[0]) * 180) / Math.PI;
        const area = polygonArea([...draw.poly, cur]);
        setMeasure(
          cur,
          `${formatLength(edge, l.unit)} · ${Math.round(((angle % 360) + 360) % 360)}° · ${formatArea(area, l.unit)}`,
        );
      } else clearMeasure();
    } else if (l.patrolMode && l.patrolDraft && l.patrolDraft.length > 0) {
      const r = toSnapped(e.lngLat, null);
      renderPatrolDraft(r.point);
    }
  });

  map.on("mouseup", (e) => {
    const l = deps.live();
    if (l.drawTool !== "rect" || !draw.rectStart) return;
    const r = toSnapped(e.lngLat, null);
    const rect = rectFromDrag(draw.rectStart, r.point);
    draw.rectStart = null;
    draftSource()?.setData(EMPTY);
    clearMeasure();
    snapTick?.remove();
    snapTick = null;
    map.dragPan.enable();
    const [x0, y0, x1, y1] = [rect[0][0], rect[0][1], rect[2][0], rect[2][1]];
    if (x1 - x0 >= 2 && y1 - y0 >= 2) {
      l.onAddRoom(rect, l.ordinal);
    }
  });

  map.on("dblclick", (e) => {
    const l = deps.live();
    // Polygon mode: double-click closes an in-progress draft from anywhere.
    if (l.drawTool === "polygon" && draw.poly.length >= 3) {
      e.preventDefault();
      closePolygon();
      return;
    }
    if (!l.patrolMode || l.patrolDraft === null) return;
    e.preventDefault();
    l.onCommitPatrol();
  });

  map.on("contextmenu", (e) => {
    const l = deps.live();
    if (l.drawTool === "polygon") {
      e.preventDefault();
      cancelDraft();
      return;
    }
    if (l.patrolMode && l.patrolDraft !== null) {
      e.preventDefault();
      l.onCancelPatrol();
      return;
    }
    if (l.drawTool !== "none") return;
    const hits = map.queryRenderedFeatures(e.point, { layers: ["unit-fill"] });
    const id = hits[0]?.properties?.id as string | undefined;
    if (id) {
      e.preventDefault();
      l.onSelect(id);
      deps.setMenu({ unitId: id, x: e.point.x, y: e.point.y });
    } else {
      deps.setMenu(null);
    }
  });

  map.on("click", (e) => {
    const l = deps.live();
    const tool = l.drawTool;
    if (tool === "none") {
      deps.setMenu(null);
      if (l.cameraMode) {
        const r = toSnapped(e.lngLat, null);
        l.onAddCamera(r.point, l.ordinal);
        return;
      }
      if (l.incidentMode) {
        const r = toSnapped(e.lngLat, null);
        l.onAddIncident(r.point, l.ordinal);
        return;
      }
      if (l.inspectMode) {
        // Raw point, no snap — the hit test must match the pixel clicked.
        deps.onInspectClick(ll2m(l.building.origin, e.lngLat.lng, e.lngLat.lat));
        return;
      }
      if (l.patrolMode) {
        if (e.originalEvent.detail > 1) return;
        const r = toSnapped(e.lngLat, null);
        l.onAddPatrolPoint(r.point);
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ["unit-fill"] });
      const id = hits[0]?.properties?.id as string | undefined;
      if (!id && l.selectedCameraId) l.onSelectCamera(null);
      if (l.linkMode) {
        if (id) l.onLinkUnit(id);
        return;
      }
      if (l.vertexEdit) {
        if (id) l.onSelect(id);
        return;
      }
      if (id && e.originalEvent.shiftKey) {
        l.onToggleSelected(id);
        return;
      }
      const cur = l.selectedId;
      l.onSelect(id && id === cur ? null : (id ?? null));
      return;
    }
    if (tool !== "polygon") return;
    // The 2nd click of a double-click is the close gesture — don't add its vertex
    // (mirrors the patrol-waypoint guard); the dblclick handler closes the draft.
    if (e.originalEvent.detail > 1) return;
    const prev = draw.poly.length > 0 ? draw.poly[draw.poly.length - 1] : null;
    const r = toSnapped(e.lngLat, prev);
    const p = r.point;
    // Close when the click lands within SCREEN tolerance of the first vertex
    // (replaces the old fixed CLOSE_SNAP_M metre radius).
    if (draw.poly.length >= 3) {
      const tolM = SNAP_PX * metresPerPixel(map.getZoom(), map.getCenter().lat);
      if (distM(p, draw.poly[0]) < Math.max(tolM, 0.5)) {
        closePolygon();
        return;
      }
    }
    draw.poly.push(p);
    setDraft(draw.poly, null);
  });

  return { cancelDraft, closePolygon, renderPatrolDraft };
}

function el(text: string, cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
