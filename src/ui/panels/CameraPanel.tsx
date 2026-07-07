import { useMemo } from "react";
import { useStore } from "../../store";
import { useVisibility } from "../visibility";
import { polygonArea } from "../../geo";
import { formatArea } from "../../format";
import { unitsCoveredByCamera } from "../../security/coverage-link";
import type { CameraKind } from "../../types";

const M_TO_FT = 3.280839895;
/** Inert placeholder timestamp — the feed never streams (no network, ever). */
const FEED_TIME = "00:00:00";
const KINDS: ReadonlyArray<CameraKind> = ["fixed", "dome", "ptz"];
const KIND_LABELS: Record<CameraKind, string> = {
  fixed: "Fixed",
  dome: "Dome (360°)",
  ptz: "PTZ (sweeps)",
};

export default function CameraPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const unit = useStore((s) => s.unit);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const showCoverage = useStore((s) => s.layers.coverage);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const setSelected = useStore((s) => s.setSelected);
  const updateCamera = useStore((s) => s.updateCamera);
  const rotateCamera = useStore((s) => s.rotateCamera);
  const deleteCamera = useStore((s) => s.deleteCamera);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const { polys: visPolys, coverage } = useVisibility();

  // Derived spaces this camera sees (same-ordinal, from occlusion geometry).
  const covered = useMemo(
    () => (selectedCameraId ? unitsCoveredByCamera(building, selectedCameraId) : []),
    [building, selectedCameraId],
  );

  const level = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const floorCams = building.cameras.filter((c) => c.ordinal === ordinal);
  const selected = building.cameras.find((c) => c.id === selectedCameraId) ?? null;

  // ---- No camera selected: place hint + coverage stub + camera list ----
  if (!selected) {
    return (
      <div className="panel">
        <div className="panel-title">Cameras</div>
        <p className="hint">Click the canvas to place a camera on {level}.</p>

        <div className="readout" style={{ marginTop: 12 }}>
          <button
            className={`wide ${showCoverage ? "active" : ""}`}
            onClick={() => toggleLayer("coverage")}
          >
            {showCoverage ? "◼ Showing coverage" : "Show coverage"}
          </button>
          {showCoverage && coverage && (
            <p className="mono" style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
              coverage {(coverage.coveragePct * 100).toFixed(0)}% · covered{" "}
              {formatArea(coverage.coveredAreaM2, unit)} · blind{" "}
              {formatArea(Math.max(0, coverage.floorAreaM2 - coverage.coveredAreaM2), unit)}
            </p>
          )}
        </div>

        {floorCams.length > 0 && (
          <div className="roomlist" style={{ marginTop: 12 }}>
            {floorCams.map((c) => (
              <div className="roomrow" key={c.id}>
                <button
                  className="camrow-select"
                  onClick={() => setSelectedCamera(c.id)}
                  title="Select camera"
                >
                  <span className="vlabel">{c.name}</span>
                  <span className="camrow-kind">{c.kind}</span>
                </button>
                <button className="del" title="Delete" onClick={() => deleteCamera(c.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- Camera selected: property editor ----
  const isDome = selected.kind === "dome";
  const rangeDisplay =
    unit === "ft" ? +(selected.rangeM * M_TO_FT).toFixed(1) : selected.rangeM;
  // Honest coverage: area of this camera's occlusion-clipped sightline polygon.
  const visRing = visPolys.find((v) => v.cameraId === selected.id)?.ring;
  const coversArea = visRing ? polygonArea(visRing) : 0;

  return (
    <div className="panel">
      <div className="panel-title">Camera</div>

      {/* Inert feed placeholder: presents as clickable, performs NO network I/O. */}
      <div
        className="camera-feed"
        role="button"
        tabIndex={0}
        title="Live feed unavailable"
        onClick={() => {
          /* TODO: live feed — intentionally a no-op stub (no network). */
        }}
      >
        <div className="camera-feed-scan" aria-hidden />
        <div className="camera-feed-label">NO SIGNAL · OFFLINE</div>
        <div className="camera-feed-corner">
          {selected.id} · {FEED_TIME}
        </div>
      </div>

      <label>Name</label>
      <input
        value={selected.name}
        onChange={(e) => updateCamera(selected.id, { name: e.target.value })}
      />

      <label>Kind</label>
      <select
        value={selected.kind}
        onChange={(e) => updateCamera(selected.id, { kind: e.target.value as CameraKind })}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>

      {isDome ? (
        <>
          <label>Field of view</label>
          <input value="360° (dome)" disabled />
        </>
      ) : (
        <>
          <label>Heading (° from east, CCW)</label>
          <input
            type="number"
            value={Math.round(selected.heading)}
            onChange={(e) => rotateCamera(selected.id, Number(e.target.value) || 0)}
          />
          <label>Field of view (°)</label>
          <input
            type="number"
            min={1}
            max={359}
            value={Math.round(selected.fovDeg)}
            onChange={(e) =>
              updateCamera(selected.id, {
                fovDeg: Math.min(359, Math.max(1, Number(e.target.value) || 1)),
              })
            }
          />
        </>
      )}

      <label>Range ({unit})</label>
      <input
        type="number"
        min={0}
        step={0.5}
        value={rangeDisplay}
        onChange={(e) => {
          const v = Math.max(0, Number(e.target.value) || 0);
          updateCamera(selected.id, { rangeM: unit === "ft" ? v / M_TO_FT : v });
        }}
      />

      <div className="readout mono" style={{ marginTop: 12 }}>
        covers {formatArea(coversArea, unit)} · {covered.length} space
        {covered.length === 1 ? "" : "s"}
      </div>

      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Covers
      </div>
      {covered.length === 0 ? (
        <p className="hint">No spaces in view.</p>
      ) : (
        <div className="roomlist">
          {covered.map((u) => (
            <div className="roomrow" key={u.id}>
              <button
                className="camrow-select"
                onClick={() => setSelected(u.id)}
                title="Select space"
              >
                <span className="vlabel">{u.name}</span>
                <span className="camrow-kind">{u.category}</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        className="wide danger"
        style={{ marginTop: 12 }}
        onClick={() => deleteCamera(selected.id)}
      >
        Delete camera
      </button>
    </div>
  );
}
