import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { useStore } from "../store";
import { m2ll } from "../geo";
import { rankCamerasForPoint } from "../coverage";
import { useVisibility } from "./visibility";
import Feed from "./panels/Feed";
import { panStep, zoomStep, tiltStep } from "../security/ptz";

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

/** Clamp a window origin so the window stays inside the map container.
 *  `height` should be the window's actual measured height where available —
 *  callers fall back to an estimate before winRef is attached (spawn only). */
function clampPos(p: Px, width: number, height: number, map: maplibregl.Map): Px {
  const box = map.getContainer();
  const maxX = Math.max(EDGE_PAD, box.clientWidth - width - EDGE_PAD);
  const maxY = Math.max(EDGE_PAD, box.clientHeight - height);
  return {
    x: Math.min(Math.max(p.x, EDGE_PAD), maxX),
    y: Math.min(Math.max(p.y, EDGE_PAD), maxY),
  };
}

/** Point on the window rect's border along the ray centre→target (leader
 *  start). If the target is inside the rect, returns the target itself so the
 *  leader collapses instead of overshooting. */
function edgePoint(rect: { x: number; y: number; w: number; h: number }, target: Px): Px {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Fires on press, then repeats every 150ms while held. `onBegin` (if given)
 *  fires once on pointerdown, before the first `onFire` — used to snapshot
 *  undo state before a gesture starts mutating live. Exported for reuse by the
 *  operator edge panel's PTZ pad. */
export function HoldButton({
  label,
  title,
  onFire,
  onBegin,
}: {
  label: string;
  title: string;
  onFire: () => void;
  onBegin?: () => void;
}) {
  const timer = useRef<number | null>(null);
  // Stable identity (only touches refs): PTZ ticks re-render the parent every
  // 150ms, so a per-render closure would make removeEventListener("blur", stop)
  // miss the function added at pointerdown and leak one listener per gesture.
  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    // Only relevant while a timer is armed, but harmless to call unconditionally.
    window.removeEventListener("blur", stop);
  }, []);
  useEffect(() => stop, [stop]);
  return (
    <button
      className="ptz-btn"
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        onBegin?.();
        onFire();
        stop();
        timer.current = window.setInterval(onFire, 150);
        // Alt-tab / window switch mid-hold must stop the repeat same as
        // pointerup — otherwise the camera keeps rotating unattended.
        window.addEventListener("blur", stop);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {label}
    </button>
  );
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

  // Memoized so the highlight-filter effect keys on ranking changes, not renders.
  const ids = useMemo(() => ranked.map((r) => r.cameraId), [ranked]);
  // Anchor = the selected camera while it still covers the point, else best view.
  const anchorId =
    selectedCameraId && ids.includes(selectedCameraId) ? selectedCameraId : (ids[0] ?? null);
  const anchor = building.cameras.find((c) => c.id === anchorId) ?? null;

  // Invariant: while a probe is live, selection tracks a camera that actually
  // covers the point — MapView keys the sightline + camera-fov-selected filter
  // off selectedCameraId, so if PTZ pans the selected camera off the probed
  // point and anchorId falls back to another camera, selection must follow or
  // the map shows two disagreeing highlights (old selected cone + new anchor).
  useEffect(() => {
    if (probe && anchorId && selectedCameraId && anchorId !== selectedCameraId) {
      setSelectedCamera(anchorId);
    }
  }, [probe, anchorId, selectedCameraId, setSelectedCamera]);

  // Aim the FOV-highlight layers (always-visible) at EVERY camera covering the
  // probed point, all at equal weight — the map answers "who covers this spot"
  // at a glance. Reset to __none__ on unmount so no cones linger after close.
  useEffect(() => {
    const setF = (f: maplibregl.FilterSpecification) => {
      if (map.getLayer("camera-fov-highlight-fill")) map.setFilter("camera-fov-highlight-fill", f);
      if (map.getLayer("camera-fov-highlight-line")) map.setFilter("camera-fov-highlight-line", f);
    };
    const none: maplibregl.FilterSpecification = ["==", ["get", "cameraId"], "__none__"];
    if (ids.length > 0) {
      setF(["all", ["==", ["get", "ordinal"], ordinal], ["in", ["get", "cameraId"], ["literal", ids]]]);
    } else {
      setF(none);
    }
    return () => setF(none);
  }, [map, ids, ordinal]);

  // PTZ fires read latest state per tick (getState, not the render closure):
  // hold-to-repeat must step from the CURRENT heading/fov each 150ms. Ticks go
  // through updateCameraLive (no history push) — HoldButton's onBegin takes
  // the one undo snapshot for the whole hold via beginCameraGesture.
  const ptzPan = (dir: 1 | -1) => () => {
    const s = useStore.getState();
    const cam = s.building.cameras.find((c) => c.id === anchorId);
    if (cam) s.updateCameraLive(cam.id, { heading: panStep(cam.heading, dir) });
  };
  const ptzZoom = (dir: 1 | -1) => () => {
    const s = useStore.getState();
    const cam = s.building.cameras.find((c) => c.id === anchorId);
    if (cam) s.updateCameraLive(cam.id, zoomStep(cam.fovDeg, cam.rangeM, dir));
  };
  const ptzTilt = (dir: 1 | -1) => () => {
    const s = useStore.getState();
    const cam = s.building.cameras.find((c) => c.id === anchorId);
    if (cam) s.updateCameraLive(cam.id, { tiltDeg: tiltStep(cam.tiltDeg, dir) });
  };

  // Spawn near the click; keyed to the probe ONLY (drag must not re-trigger).
  // winRef isn't attached yet at spawn — fall back to the same 240px estimate
  // the leader uses before its own first measurement.
  useEffect(() => {
    if (!probe) return;
    const p = map.project(m2ll(building.origin, probe.point[0], probe.point[1]));
    const h = winRef.current?.offsetHeight ?? 240;
    setPos(clampPos({ x: p.x + SPAWN_OFFSET, y: p.y + SPAWN_OFFSET }, widthRef.current, h, map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe]);

  // Post-commit overflow correction: spawn clamps against an ESTIMATED height
  // (winRef isn't mounted yet), and the tile grid can make the real window far
  // taller — pull it back inside the container once measurable. Idempotent
  // (clamp of a clamped pos is itself), so this converges in one extra render.
  useLayoutEffect(() => {
    const real = winRef.current?.offsetHeight;
    if (!real || !pos) return;
    const c = clampPos(pos, widthRef.current, real, map);
    if (c.x !== pos.x || c.y !== pos.y) setPos(c);
  });

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
    const h = winRef.current?.offsetHeight ?? 240;
    const onMove = (ev: PointerEvent) => {
      setPos(
        clampPos(
          { x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) },
          w,
          h,
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
      // the map bounds — re-clamp position against the new width too. Height
      // is read live: the 16:9 feed grows the window taller as width grows.
      const h = winRef.current?.offsetHeight ?? 240;
      setPos((p) => (p ? clampPos(p, w, h, map) : p));
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

  const camScreen = map.project(m2ll(building.origin, anchor.at[0], anchor.at[1]));
  const winH = winRef.current?.offsetHeight ?? 240;
  const leaderFrom = edgePoint({ x: pos.x, y: pos.y, w: width, h: winH }, camScreen);

  return (
    <>
      <svg className="camwin-leader" aria-hidden>
        <line x1={leaderFrom.x} y1={leaderFrom.y} x2={camScreen.x} y2={camScreen.y} />
        <circle cx={camScreen.x} cy={camScreen.y} r={3} />
      </svg>
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
          <Feed camera={anchor} />

          {anchor.kind === "ptz" && (
            <div className="ptz-pad">
              <span className="ptz-label">Pan</span>
              <HoldButton
                label="◀"
                title="Pan left (hold to sweep)"
                onFire={ptzPan(1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
              <HoldButton
                label="▶"
                title="Pan right (hold to sweep)"
                onFire={ptzPan(-1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
              <span className="ptz-label">Tilt</span>
              <HoldButton
                label="▲"
                title="Tilt up (see farther; opens a near blind hole)"
                onFire={ptzTilt(-1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
              <HoldButton
                label="▼"
                title="Tilt down (pull the view in close)"
                onFire={ptzTilt(1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
              <span className="ptz-label">Zoom</span>
              <HoldButton
                label="−"
                title="Zoom out (wider FOV)"
                onFire={ptzZoom(-1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
              <HoldButton
                label="+"
                title="Zoom in (narrower FOV, longer reach)"
                onFire={ptzZoom(1)}
                onBegin={() => useStore.getState().beginCameraGesture()}
              />
            </div>
          )}

          {others.length > 0 && (
            <>
              <div className="camwin-subhead">Also covering ({others.length})</div>
              <div className="camwin-tiles">
                {others.map((id) => {
                  const c = camById.get(id);
                  if (!c) return null;
                  return (
                    <div
                      className="camtile"
                      key={id}
                      role="button"
                      tabIndex={0}
                      title="Promote to main view"
                      onClick={() => setSelectedCamera(id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setSelectedCamera(id);
                      }}
                    >
                      <Feed camera={c} />
                      <div className="camtile-cap">
                        <span className="vlabel">{c.name}</span>
                        <span className="camrow-kind">{pct(id)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="camwin-foot">
          <div className="camwin-foot-line">{anchor.streamRef ? anchor.streamRef : "no stream set"}</div>
          <div className="camwin-foot-line">point {coordText}</div>
        </div>

        <div className="camwin-resize" onPointerDown={startResize} title="Resize" />
      </div>
    </>
  );
}
