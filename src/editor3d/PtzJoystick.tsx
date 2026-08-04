// PTZ VIRTUAL JOYSTICK — the control a real VMS operator already knows.
//
// A crosshair marks the viewport centre. Press and hold anywhere and the camera
// slews in the direction of the pointer, at a speed set by how far from the
// crosshair it is: near the middle is a crawl, out at the edge is a fast swing.
// The cursor becomes an arrow that points the way the camera is about to move,
// rotating around the crosshair like a clock hand. Wheel zooms.
//
// WHY THE POSE IS PUSHED STRAIGHT AT THE RENDERER: build3dScene is memoized on
// the whole `building`, so writing heading to the store on every frame would
// rebuild the entire scene 60x a second (the casino floor is ~370 KB of authored
// geometry). Instead the gesture drives setFeedPose directly — which only moves
// the three.js camera, touching no geometry — and commits ONCE on release, so
// the sweep is also a single undo step rather than several hundred.

import { useCallback, useEffect, useRef, useState } from "react";
import { deriveVfovDeg, type SceneCameraPose } from "../scene/scene-build";
import { FOV_MAX, FOV_MIN, ZOOM_FACTOR } from "../security/ptz";

/** Degrees per second at full deflection. */
const MAX_PAN_DPS = 75;
const MAX_TILT_DPS = 38;
/** Pointer offset (px) inside which nothing moves — a still hand must not drift. */
const DEADBAND_PX = 16;
/** Tilt limits, matching the Camera panel's own input range (0 = flat wedge). */
const TILT_MIN = 0;
const TILT_MAX = 85;
/** Hold before slewing starts. Long enough that neither press of a double-click
 *  (which exits fullscreen) drags the camera off aim, short enough to feel
 *  immediate on a real drag. */
const HOLD_MS = 120;
/** Wheel ticks inside this window coalesce into one undo entry. */
const ZOOM_IDLE_MS = 350;

interface Props {
  /** Base pose from the scene — the authored aim this gesture starts from. */
  pose: SceneCameraPose;
  /** Push a live pose at the renderer. No store write, no scene rebuild. */
  onLive: (pose: SceneCameraPose) => void;
  /** Persist the final aim. Called ONCE per gesture — on release for a slew,
   *  after the wheel goes quiet for a zoom. `updateCamera` takes no coalesce
   *  key, so one call is exactly one undo entry: a whole sweep undoes in one
   *  press rather than several hundred. There is deliberately no
   *  beginCameraGesture here — that snapshots history for callers whose live
   *  ticks go through the store, and ours do not. */
  onCommit: (patch: { heading: number; tiltDeg: number; fovDeg: number; rangeM: number }) => void;
}

export default function PtzJoystick({ pose, onLive, onCommit }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Live aim for the gesture in flight. Refs, not state: the rAF loop reads them
  // every frame and re-rendering React at 60 Hz to move a camera would be absurd.
  const aim = useRef({ heading: pose.headingDeg, tilt: pose.tiltDeg, fov: pose.fovDeg, range: pose.rangeM });
  const ptr = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  const lastT = useRef(0);
  const startedAt = useRef(0);
  const zoomTimer = useRef(0);
  const zooming = useRef(false);
  /** Did this gesture actually move the camera? Guards the commit. */
  const dirty = useRef(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; deg: number } | null>(null);
  const [slewing, setSlewing] = useState(false);

  // A new camera (or an aim edited elsewhere) resets the gesture baseline.
  useEffect(() => {
    aim.current = { heading: pose.headingDeg, tilt: pose.tiltDeg, fov: pose.fovDeg, range: pose.rangeM };
  }, [pose.id, pose.headingDeg, pose.tiltDeg, pose.fovDeg, pose.rangeM]);

  // Preserve whatever relationship the pose has between h-fov and v-fov: exactly
  // 1 when vfov is derived, the authored ratio when it is not.
  const vfovRatio = pose.vfovDeg / Math.max(0.001, deriveVfovDeg(pose.fovDeg));
  const emit = useCallback(() => {
    const a = aim.current;
    onLive({
      ...pose,
      headingDeg: ((a.heading % 360) + 360) % 360,
      tiltDeg: a.tilt,
      fovDeg: a.fov,
      vfovDeg: Math.min(179, Math.max(1, deriveVfovDeg(a.fov) * vfovRatio)),
      rangeM: a.range,
    });
  }, [onLive, pose, vfovRatio]);

  const commit = useCallback(() => {
    // A press that moved nothing is not an edit. Without this, every stray click
    // on the picture — including each half of the double-click that leaves
    // fullscreen — would push an undo entry that reverses nothing.
    if (!dirty.current) return;
    dirty.current = false;
    const a = aim.current;
    onCommit({
      heading: ((a.heading % 360) + 360) % 360,
      tiltDeg: a.tilt,
      fovDeg: a.fov,
      rangeM: a.range,
    });
  }, [onCommit]);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const tick = useCallback(
    (t: number) => {
      rafRef.current = requestAnimationFrame(tick);
      const box = boxRef.current;
      const p = ptr.current;
      if (!box || !p) return;
      const dt = lastT.current ? Math.min(0.05, (t - lastT.current) / 1000) : 0;
      lastT.current = t;
      if (t - startedAt.current < HOLD_MS) return;

      const r = box.getBoundingClientRect();
      const dx = p.x - (r.left + r.width / 2);
      const dy = p.y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist <= DEADBAND_PX) return;
      const maxR = Math.max(1, Math.min(r.width, r.height) / 2 - DEADBAND_PX);
      // Squared response: fine framing near the crosshair, fast slew at the edge.
      // A linear ramp makes the first pixel of travel too fast to aim with.
      const speed = Math.min(1, (dist - DEADBAND_PX) / maxR) ** 2;
      const ux = dx / dist;
      const uy = dy / dist;
      const a = aim.current;
      // Drag right = pan right. `heading` is CCW-from-east, so panning right
      // DECREASES it — the sign here is the difference between a control that
      // feels like a camera and one that fights the operator.
      a.heading -= ux * speed * MAX_PAN_DPS * dt;
      // Drag down = tilt down. tiltDeg is degrees BELOW horizontal, so down is +.
      a.tilt = Math.min(TILT_MAX, Math.max(TILT_MIN, a.tilt + uy * speed * MAX_TILT_DPS * dt));
      dirty.current = true;
      emit();
    },
    [emit],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ptr.current = { x: e.clientX, y: e.clientY };
    startedAt.current = performance.now();
    lastT.current = 0;
    setSlewing(true);
    stopLoop();
    rafRef.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    // The arrow points AWAY from the crosshair — straight up when the pointer is
    // above it — and swings round like a clock hand. The SVG is drawn pointing
    // up, so the rotation is the vector's angle plus a quarter turn.
    setCursor({
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      deg: (Math.atan2(dy, dx) * 180) / Math.PI + 90,
    });
    if (ptr.current) ptr.current = { x: e.clientX, y: e.clientY };
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ptr.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone if the pointer left the window */
    }
    ptr.current = null;
    stopLoop();
    setSlewing(false);
    commit();
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const a = aim.current;
    const before = a.fov;
    const target = e.deltaY < 0 ? before / ZOOM_FACTOR : before * ZOOM_FACTOR;
    const next = Math.min(FOV_MAX, Math.max(FOV_MIN, target));
    if (next === before) return;
    zooming.current = true;
    dirty.current = true;
    a.fov = next;
    // Narrower view reaches further, by the same sqrt rule the button pad uses,
    // so zooming does not quietly rewrite how far the camera can actually see.
    //
    // Scale from the CLAMPED previous fov, not the raw one. Demo pole PTZs are
    // authored at fovDeg 360 meaning "can point anywhere", not "sees a full
    // circle at once"; scaling 360 -> 120 as if it were a real optical zoom
    // would inflate range by 1.7x on the very first wheel tick. Normalising an
    // omnidirectional aim into a viewable one is not zooming, so it costs no
    // range; every tick after that is a genuine zoom and scales normally.
    const beforeEff = Math.min(FOV_MAX, Math.max(FOV_MIN, before));
    a.range = a.range * Math.sqrt(beforeEff / next);
    emit();
    window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => {
      zooming.current = false;
      commit();
    }, ZOOM_IDLE_MS);
  };

  useEffect(() => () => {
    stopLoop();
    window.clearTimeout(zoomTimer.current);
  }, [stopLoop]);

  // Zoom factor against the widest view the optics offer. Clamped so a 360°
  // "points anywhere" PTZ reads 1.0x at rest rather than a nonsense 0.3x.
  const zoomPct =
    Math.round((FOV_MAX / Math.min(FOV_MAX, Math.max(FOV_MIN, aim.current.fov))) * 10) / 10;

  return (
    <div
      ref={boxRef}
      className={`ptzjoy${slewing ? " slewing" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onWheel={onWheel}
      onMouseLeave={() => setCursor(null)}
    >
      <svg className="ptzjoy-cross" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="50" y1="43" x2="50" y2="57" />
        <line x1="43" y1="50" x2="57" y2="50" />
        <circle cx="50" cy="50" r="0.9" />
      </svg>
      {cursor && (
        <svg
          className="ptzjoy-arrow"
          width="34"
          height="34"
          viewBox="0 0 34 34"
          style={{ left: cursor.x, top: cursor.y, transform: `translate(-50%, -50%) rotate(${cursor.deg}deg)` }}
        >
          <path d="M17 3 L26 21 L17 16 L8 21 Z" />
        </svg>
      )}
      <span className="ptzjoy-hint">PTZ · drag to slew · wheel to zoom · {zoomPct}x</span>
    </div>
  );
}
