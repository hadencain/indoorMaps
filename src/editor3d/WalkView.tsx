// The store-aware React shell for the first-person walk editor — the ONLY
// store-touching file in src/editor3d (walk-renderer.ts stays store-/React-free).
// It owns the WalkRenderer lifecycle, feeds it a Scene3D on building/floor
// changes, and renders a DOM HUD over the WebGL canvas. Lazily imported by
// AppShell (React.lazy) so three.js code-splits out of the initial chunk.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { build3dScene } from "../scene/scene-build";
import { levelCeilingM } from "../render";
import { MOUNT_H } from "../coverage";
import { WalkRenderer, type CoverageMode, type RenderQuality } from "./walk-renderer";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const norm360 = (v: number): number => ((v % 360) + 360) % 360;

const COVERAGE_LABEL: Record<CoverageMode, string> = {
  selected: "cones · selected",
  nearby: "cones · nearby 8",
  off: "cones · off",
};
const MOUNTS: ReadonlyArray<"ceiling" | "wall" | "column"> = ["ceiling", "wall", "column"];

export default function WalkView() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const flyTarget = useStore((s) => s.flyTarget);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const setWalkMode = useStore((s) => s.setWalkMode);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const setLevelCeiling = useStore((s) => s.setLevelCeiling);
  const updateCamera = useStore((s) => s.updateCamera);
  const beginCameraGesture = useStore((s) => s.beginCameraGesture);
  const updateCameraLive = useStore((s) => s.updateCameraLive);

  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WalkRenderer | null>(null);
  const [coverageMode, setCoverageMode] = useState<CoverageMode>("selected");
  const [quality, setQuality] = useState<RenderQuality>("high");
  const [locked, setLocked] = useState(false);

  // Create the renderer once; ResizeObserver keeps it matched to the container.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const r = new WalkRenderer(el, {
      onPickCamera: (id) => {
        useStore.getState().setSelectedCamera(id);
        // Picking a camera means the operator wants to adjust it — free the
        // cursor from pointer lock so the pose panel is reachable. Esc or the
        // panel's "back to walking" button re-locks.
        if (id) r.unlock();
      },
      // Reflect the real quality in the HUD, including the renderer's automatic
      // High→Low fallback on a slow GPU (idempotent for manual toggles).
      onQualityChange: (q) => setQuality(q),
    });
    rendererRef.current = r;
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Track pointer-lock state for the HUD (Esc exits lock natively -> HUD live).
  useEffect(() => {
    const onChange = () => setLocked(document.pointerLockElement != null);
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);

  // Esc while a camera is selected deselects it (closes the pose panel). When
  // locked, the browser fires Escape as it exits pointer lock, so this also
  // covers "aimed at a camera, hit Esc" in one keypress. Reads the store live so
  // the listener stays stable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Two-stage Esc. While pointer-locked the browser is already exiting lock
      // on this same keypress — that is the operator stepping out to reach the
      // pose panel, NOT abandoning the camera, so the selection survives. A
      // second Esc (now unlocked) clears it. Previously one keypress did both,
      // so you could never free the cursor without losing the camera.
      if (document.pointerLockElement) return;
      if (useStore.getState().selectedCameraId) {
        useStore.getState().setSelectedCamera(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Rebuild the scene on any building edit or floor change (build3dScene is pure).
  useEffect(() => {
    const scene = build3dScene(building, ordinal);
    rendererRef.current?.setScene(scene);

    // Adjacent floors, but ONLY when this one has an atrium to see them through.
    // A hole in a plate is the only way a neighbouring level becomes visible, so
    // building them unconditionally would roughly double the scene cost for a view
    // nobody can see. `voids` opens the floor downward, `ceilingVoids` opens it up.
    const hasFloorHole = scene.voids.length > 0;
    const hasCeilingHole = scene.ceilingVoids.length > 0;
    const exists = (o: number): boolean => building.levels.some((l) => l.ordinal === o);
    rendererRef.current?.setNeighbourScenes(
      hasFloorHole && exists(ordinal - 1) ? build3dScene(building, ordinal - 1) : null,
      hasCeilingHole && exists(ordinal + 1) ? build3dScene(building, ordinal + 1) : null,
    );
  }, [building, ordinal]);

  useEffect(() => {
    rendererRef.current?.setSelectedCamera(selectedCameraId);
  }, [selectedCameraId]);

  // Floor-directory click (requestFly) teleports the operator to that section so
  // they can inspect its cameras, instead of flying the length of the venue. On
  // another floor: switch floors first and keep the target — this effect re-runs
  // on the new ordinal and lands. MapView ignores flyTarget while walking, so
  // exactly one consumer handles it.
  useEffect(() => {
    if (!flyTarget) return;
    if (flyTarget.ordinal !== ordinal) {
      if (building.levels.some((l) => l.ordinal === flyTarget.ordinal)) setOrdinal(flyTarget.ordinal);
      else useStore.setState({ flyTarget: null });
      return;
    }
    rendererRef.current?.teleportTo(flyTarget.center);
    useStore.setState({ flyTarget: null });
  }, [flyTarget, ordinal, building.levels, setOrdinal]);

  useEffect(() => {
    rendererRef.current?.setCoverageMode(coverageMode);
  }, [coverageMode]);

  const ceilingM = levelCeilingM(building, ordinal);
  const sortedLevels = [...building.levels].sort((a, b) => a.ordinal - b.ordinal);
  const selectedCam =
    building.cameras.find((c) => c.id === selectedCameraId && c.ordinal === ordinal) ?? null;
  const isDome = selectedCam?.kind === "dome";

  const cycleCoverage = () =>
    setCoverageMode((m) => (m === "selected" ? "nearby" : m === "nearby" ? "off" : "selected"));

  // Toggle the render quality (bloom composer on/off). Local, not persisted; the
  // renderer may also auto-fall-back to Low, which syncs this label via onQualityChange.
  const cycleQuality = () =>
    setQuality((q) => {
      const next: RenderQuality = q === "high" ? "cinematic" : q === "cinematic" ? "low" : "high";
      rendererRef.current?.setQuality(next);
      return next;
    });

  // PHOTO MODE: render one supersampled frame and save it. The capture is a
  // still, so it is not bound by the interactive frame budget — the renderer
  // pushes to cinematic settings for that one frame and restores itself after.
  const [shooting, setShooting] = useState(false);
  const takePhoto = async () => {
    const r = rendererRef.current;
    if (!r || shooting) return;
    setShooting(true);
    try {
      const blob = await r.capturePhoto();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const floor = sortedLevels.find((l) => l.ordinal === ordinal)?.name ?? `level-${ordinal}`;
      a.href = url;
      a.download = `${floor.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-render.png`;
      a.click();
      // Revoke on the next frame: revoking synchronously can beat the download
      // in some browsers and save a zero-byte file.
      requestAnimationFrame(() => URL.revokeObjectURL(url));
    } finally {
      setShooting(false);
    }
  };

  const camId = selectedCam?.id ?? "";
  const mountVal = selectedCam
    ? clamp(selectedCam.mountM ?? Math.min(MOUNT_H, ceilingM - 0.1), 0.3, ceilingM)
    : 0;

  return (
    <div className="walk-view">
      <div className="walk-canvas" ref={mountRef} />

      <div className="walk-hud">
        <div className="walk-floors">
          {sortedLevels.map((l) => (
            <button
              key={l.ordinal}
              className={l.ordinal === ordinal ? "active" : ""}
              onClick={() => setOrdinal(l.ordinal)}
              title={l.name}
            >
              {l.name}
            </button>
          ))}
        </div>
        <label className="walk-ceil">
          ceiling
          <input
            type="number"
            className="numin sm"
            min={2.2}
            max={8}
            step={0.1}
            value={ceilingM}
            onChange={(e) => setLevelCeiling(ordinal, Number(e.target.value) || ceilingM)}
          />
          m
        </label>
        <button className="walk-cov" onClick={cycleCoverage} title="Cycle coverage cones">
          {COVERAGE_LABEL[coverageMode]}
        </button>
        <button className="walk-cov" onClick={cycleQuality} title="Cycle render quality">
          {`quality · ${quality}`}
        </button>
        <button
          className="walk-cov"
          onClick={takePhoto}
          disabled={shooting}
          title="Save a supersampled render of this view"
        >
          {shooting ? "rendering…" : "photo"}
        </button>
        <button className="walk-exit" onClick={() => setWalkMode(false)} title="Exit walk mode">
          Exit walk
        </button>
      </div>

      {selectedCam && (
        <div className="walk-pose">
          <div className="walk-pose-title">
            <span className="vlabel">{selectedCam.name}</span>
            <span className="camrow-kind">{selectedCam.kind}</span>
          </div>

          <PoseSlider
            label="Mount height (m)"
            value={mountVal}
            min={0.3}
            max={Math.max(0.3, +ceilingM.toFixed(2))}
            step={0.05}
            onGestureStart={beginCameraGesture}
            onLive={(v) => updateCameraLive(camId, { mountM: v })}
            onCommit={(v) => updateCamera(camId, { mountM: clamp(v, 0.3, ceilingM) })}
          />
          <PoseSlider
            label="Heading (°)"
            value={norm360(selectedCam.heading)}
            min={0}
            max={359}
            step={1}
            disabled={isDome}
            onGestureStart={beginCameraGesture}
            onLive={(v) => updateCameraLive(camId, { heading: v })}
            onCommit={(v) => updateCamera(camId, { heading: norm360(v) })}
          />
          <PoseSlider
            label="Tilt down (°)"
            value={selectedCam.tiltDeg ?? 0}
            min={0}
            max={85}
            step={1}
            disabled={isDome}
            onGestureStart={beginCameraGesture}
            onLive={(v) => updateCameraLive(camId, { tiltDeg: v })}
            onCommit={(v) => updateCamera(camId, { tiltDeg: clamp(v, 0, 85) })}
          />
          <PoseSlider
            label="Roll (°)"
            value={selectedCam.rollDeg ?? 0}
            min={-180}
            max={180}
            step={1}
            disabled={isDome}
            onGestureStart={beginCameraGesture}
            onLive={(v) => updateCameraLive(camId, { rollDeg: v })}
            onCommit={(v) => updateCamera(camId, { rollDeg: clamp(v, -180, 180) })}
          />

          <label className="walk-pose-label">Mount surface</label>
          <select
            value={selectedCam.mount ?? "ceiling"}
            onChange={(e) =>
              updateCamera(camId, { mount: e.target.value as "ceiling" | "wall" | "column" })
            }
          >
            {MOUNTS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {/* Resume walking WITHOUT dropping the camera: the selection and its
              lit coverage cone persist, so the operator can walk the floor and
              watch where this camera's green actually lands — which is the
              entire reason to inspect in 3D. Clearing is a separate, explicit
              act. (Previously this button deselected, so every attempt to go
              look at the coverage closed the camera you were configuring.) */}
          <button className="walk-pose-resume" onClick={() => rendererRef.current?.lock()}>
            ◀ walk while this camera stays selected
          </button>
          <button className="walk-pose-clear" onClick={() => setSelectedCamera(null)}>
            ✕ deselect camera
          </button>
        </div>
      )}

      <div className="walk-hint mono">
        {selectedCam
          ? locked
            ? "walking · this camera stays selected · Esc to adjust it · click another to switch"
            : "adjust the camera · ◀ to walk with it still selected · Esc to deselect"
          : "WASD move · Space up · Shift down · Ctrl fast · click a camera to select · Esc release"}
      </div>

      {/* The full-screen "click to walk" prompt is suppressed while a camera is
          selected, so it can't cover the pose panel or re-lock on a stray click. */}
      {!locked && !selectedCam && (
        <button className="walk-lock" onClick={() => rendererRef.current?.lock()}>
          <span className="walk-lock-inner">click to walk</span>
        </button>
      )}
      {locked && <div className="walk-crosshair" aria-hidden />}
    </div>
  );
}

// A range slider paired with a number input, both driving one camera field.
// The slider is a live gesture (one undo step per drag/keyboard-adjust: a single
// beginCameraGesture snapshot on the FIRST input, then updateCameraLive per
// input); the number input commits a single discrete undo entry. Dome disables
// aim fields (mirrors CameraPanel).
function PoseSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onGestureStart: () => void;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const { label, value, min, max, step, disabled, onGestureStart, onLive, onCommit } = props;
  // Snapshot lazily on the first input of a gesture, NOT on pointerdown. React's
  // onChange maps to the DOM `input` event, which fires continuously while
  // dragging AND on every keyboard step (arrows/Page/Home/End) — but pointerdown
  // does NOT fire for keyboard edits. A pointerdown-only snapshot therefore let
  // arrow-key edits run updateCameraLive (which skips history) with no preceding
  // beginCameraGesture, entangling/corrupting undo. Guarding on the first input
  // covers both paths with exactly one snapshot per gesture; pointerup/keyup/blur
  // end the gesture so the next interaction snapshots afresh.
  const gesturing = useRef(false);
  const live = (v: number) => {
    if (!gesturing.current) {
      gesturing.current = true;
      onGestureStart();
    }
    onLive(v);
  };
  const endGesture = () => {
    gesturing.current = false;
  };
  return (
    <div className="walk-pose-row">
      <label className="walk-pose-label">{label}</label>
      <div className="walk-pose-inputs">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => live(Number(e.target.value))}
          onPointerUp={endGesture}
          onKeyUp={endGesture}
          onBlur={endGesture}
        />
        <input
          type="number"
          className="numin sm"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onCommit(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
