import { useEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { useStore } from "../store";
import { m2ll } from "../geo";
import { rankCamerasForPoint } from "../coverage";
import { useVisibility } from "./visibility";
import FeedPlaceholder from "./panels/FeedPlaceholder";

/** Session-remembered window width (px) — survives re-spawns, never persisted. */
let lastWidth = 360;

const MIN_W = 260;
const MAX_W = 640;
const SPAWN_OFFSET = 16;
const EDGE_PAD = 8;

interface Px {
  x: number;
  y: number;
}

/** Clamp a window origin so the window stays inside the map container. */
function clampPos(p: Px, width: number, map: maplibregl.Map): Px {
  const box = map.getContainer();
  const maxX = Math.max(EDGE_PAD, box.clientWidth - width - EDGE_PAD);
  const maxY = Math.max(EDGE_PAD, box.clientHeight - 160);
  return {
    x: Math.min(Math.max(p.x, EDGE_PAD), maxX),
    y: Math.min(Math.max(p.y, EDGE_PAD), maxY),
  };
}

/**
 * Floating camera window (display-mode probe). Screen-space overlay in
 * .map-wrap — spawns near the click, stays put while the map pans beneath it.
 * Absorbs everything the sidebar InspectPanel showed: feed, best-view badge,
 * camera switcher, stream ref. Mounted only while `probe` is non-null.
 */
export default function CameraWindow({ map }: { map: maplibregl.Map }) {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const probe = useStore((s) => s.probe);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const setProbe = useStore((s) => s.setProbe);
  const { polys } = useVisibility();

  const [pos, setPos] = useState<Px | null>(null);
  const [width, setWidth] = useState(lastWidth);
  // Bumped on map move/resize so screen projections re-derive (leader, Task 4).
  const [, setTick] = useState(0);
  const winRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  // Holds the teardown for whichever gesture (drag/resize) is currently live,
  // so unmount or a new gesture can force-remove stale window listeners.
  const gestureCleanup = useRef<(() => void) | null>(null);

  // Best-view-first ranking, derived live (same derivation InspectPanel used) —
  // never a stored snapshot, so PTZ / edits / undo can't leave it stale.
  const ranked = useMemo(() => {
    if (!probe) return [];
    const ringById = new Map(polys.map((p) => [p.cameraId, p.ring]));
    const cams = building.cameras.filter((c) => c.ordinal === ordinal);
    return rankCamerasForPoint(probe.point, cams, ringById);
  }, [probe, polys, building.cameras, ordinal]);

  const ids = ranked.map((r) => r.cameraId);
  // Anchor = the selected camera while it still covers the point, else best view.
  const anchorId =
    selectedCameraId && ids.includes(selectedCameraId) ? selectedCameraId : (ids[0] ?? null);
  const anchor = building.cameras.find((c) => c.id === anchorId) ?? null;

  // Spawn near the click; keyed to the probe ONLY (drag must not re-trigger).
  useEffect(() => {
    if (!probe) return;
    const p = map.project(m2ll(building.origin, probe.point[0], probe.point[1]));
    setPos(clampPos({ x: p.x + SPAWN_OFFSET, y: p.y + SPAWN_OFFSET }, widthRef.current, map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe]);

  // Re-render on map move/resize so projected positions track the map.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    map.on("move", bump);
    map.on("resize", bump);
    return () => {
      map.off("move", bump);
      map.off("resize", bump);
    };
  }, [map]);

  // Tear down an in-flight drag/resize if the window unmounts mid-gesture
  // (e.g. Esc clears the probe while dragging).
  useEffect(() => () => gestureCleanup.current?.(), []);

  function startDrag(e: React.PointerEvent) {
    if (!pos) return;
    // Header buttons handle their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    gestureCleanup.current?.();
    const start = { ...pos };
    const sx = e.clientX;
    const sy = e.clientY;
    // Blind state renders at a fixed 260px, not widthRef's remembered width —
    // clamp against what's actually on screen.
    const w = winRef.current?.offsetWidth ?? widthRef.current;
    const onMove = (ev: PointerEvent) => {
      setPos(
        clampPos(
          { x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) },
          w,
          map,
        ),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      gestureCleanup.current = null;
    };
    gestureCleanup.current = end;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    // pointercancel fires on alt-tab / native dialogs — must tear down the
    // same as pointerup or the listeners leak.
    window.addEventListener("pointercancel", end);
  }

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    gestureCleanup.current?.();
    const sw = widthRef.current;
    const sx = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, sw + (ev.clientX - sx)));
      setWidth(w);
      lastWidth = w;
      // Widening near the container's right edge can push the window past
      // the map bounds — re-clamp position against the new width too.
      setPos((p) => (p ? clampPos(p, w, map) : p));
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      gestureCleanup.current = null;
    };
    gestureCleanup.current = end;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function close() {
    // Clear both: leaving selectedCameraId set would swap the sidebar to
    // CameraView the instant the probe clears.
    setProbe(null);
    setSelectedCamera(null);
  }

  if (!probe || !pos) return null;

  const [px, py] = probe.point;
  const coordText = `${px.toFixed(1)}, ${py.toFixed(1)} m`;

  // Blind: nothing on this floor sees the clicked point.
  if (!anchor) {
    return (
      <div ref={winRef} className="camwin" style={{ left: pos.x, top: pos.y, width: 260 }}>
        <div className="camwin-head" onPointerDown={startDrag}>
          <span className="camwin-title">No coverage</span>
          <button className="del" title="Close" onClick={close}>
            ✕
          </button>
        </div>
        <div className="camwin-body">
          <div className="camwin-blind">No camera covers this point.</div>
          <div className="camwin-foot-line">point {coordText}</div>
        </div>
      </div>
    );
  }

  const scoreById = new Map(ranked.map((r) => [r.cameraId, r.score]));
  const pct = (id: string) => `${Math.round((scoreById.get(id) ?? 0) * 100)}%`;
  const isBest = anchorId === ids[0];
  const others = ids.filter((id) => id !== anchorId);
  const camById = new Map(building.cameras.map((c) => [c.id, c]));

  return (
    <div ref={winRef} className="camwin" style={{ left: pos.x, top: pos.y, width }}>
      <div className="camwin-head" onPointerDown={startDrag}>
        <span className="camwin-title">{anchor.name}</span>
        <span className="camwin-badge">
          {isBest ? "BEST VIEW · " : ""}
          {pct(anchor.id)}
        </span>
        <button className="del" title="Close (Esc)" onClick={close}>
          ✕
        </button>
      </div>

      <div className="camwin-body">
        <FeedPlaceholder camera={anchor} />

        {others.length > 0 && (
          <div className="roomlist camwin-switch">
            {others.map((id) => {
              const c = camById.get(id);
              if (!c) return null;
              return (
                <div className="roomrow" key={id}>
                  <button
                    className="camrow-select"
                    onClick={() => setSelectedCamera(id)}
                    title="Switch to this camera"
                  >
                    <span className="vlabel">{c.name}</span>
                    <span className="camrow-kind">{pct(id)}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="camwin-foot">
        <div className="camwin-foot-line">{anchor.streamRef ? anchor.streamRef : "no stream set"}</div>
        <div className="camwin-foot-line">point {coordText}</div>
      </div>

      <div className="camwin-resize" onPointerDown={startResize} title="Resize" />
    </div>
  );
}
