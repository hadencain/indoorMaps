import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { useStore } from "../../store";
import { useVisibility } from "../visibility";
import { polygonArea } from "../../geo";
import { formatArea } from "../../format";
import { unitsCoveredByCamera } from "../../security/coverage-link";
import { doriBand, doriRangeM, pxPerMetreAt } from "../../coverage";
import SearchBox from "../SearchBox";
import FeedPlaceholder from "./FeedPlaceholder";
import type { Camera, CameraKind } from "../../types";

const M_TO_FT = 3.280839895;
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
  const searchQuery = useStore((s) => s.searchQuery);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const setSelected = useStore((s) => s.setSelected);
  const updateCamera = useStore((s) => s.updateCamera);
  const rotateCamera = useStore((s) => s.rotateCamera);
  const deleteCamera = useStore((s) => s.deleteCamera);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const suggestions = useStore((s) => s.suggestions);
  const suggestStats = useStore((s) => s.suggestStats);
  const runSuggestCameras = useStore((s) => s.runSuggestCameras);
  const acceptAllSuggestions = useStore((s) => s.acceptAllSuggestions);
  const clearSuggestions = useStore((s) => s.clearSuggestions);
  const [targetPct, setTargetPct] = useState(90);
  const [maxNew, setMaxNew] = useState(40);
  const { polys: visPolys, coverage } = useVisibility();

  // Derived spaces this camera sees (same-ordinal, from occlusion geometry).
  const covered = useMemo(
    () => (selectedCameraId ? unitsCoveredByCamera(building, selectedCameraId) : []),
    [building, selectedCameraId],
  );

  const level = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const q = searchQuery.trim().toLowerCase();
  const floorCams = building.cameras.filter(
    (c) =>
      c.ordinal === ordinal &&
      (q === "" || c.name.toLowerCase().includes(q) || c.kind.toLowerCase().includes(q)),
  );
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

        <div className="suggest-sec">
          <div className="panel-subtitle">Suggest cameras</div>
          {suggestions === null ? (
            <>
              <p className="hint">
                Auto-plan this floor: corner mounts in uncovered rooms, then
                gap-fill to the coverage target. Placements appear as ghosts —
                nothing is added until you accept.
              </p>
              <div className="suggest-opts">
                <label>
                  Target
                  <input
                    type="number"
                    min={10}
                    max={99}
                    value={targetPct}
                    onChange={(e) => setTargetPct(Math.min(99, Math.max(10, Number(e.target.value) || 90)))}
                  />
                  %
                </label>
                <label>
                  Max new
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={maxNew}
                    onChange={(e) => setMaxNew(Math.min(200, Math.max(1, Number(e.target.value) || 40)))}
                  />
                </label>
              </div>
              <button className="wide suggest-run" onClick={() => runSuggestCameras(targetPct, maxNew)}>
                <Sparkles size={13} /> Suggest placements
              </button>
            </>
          ) : (
            <>
              {suggestStats && (
                <p className="mono suggest-readout">
                  {suggestions.length} ghost{suggestions.length === 1 ? "" : "s"} ·{" "}
                  {suggestStats.cornerCount} corner + {suggestStats.fillCount} gap-fill
                  <br />
                  coverage {(suggestStats.beforePct * 100).toFixed(0)}% →{" "}
                  {(suggestStats.afterPct * 100).toFixed(0)}% projected
                </p>
              )}
              {suggestions.length === 0 && (
                <p className="hint">Nothing to add — this floor already meets the target.</p>
              )}
              <p className="hint">✓ / ✕ each ghost on the map, or take the whole plan:</p>
              <div className="suggest-actions">
                <button className="wide active" onClick={acceptAllSuggestions} disabled={suggestions.length === 0}>
                  Accept all ({suggestions.length})
                </button>
                <button className="wide" onClick={clearSuggestions}>
                  Discard
                </button>
              </div>
            </>
          )}
        </div>

        {building.cameras.some((c) => c.ordinal === ordinal) && (
          <div style={{ marginTop: 12 }}>
            <SearchBox placeholder="Search cameras…" />
          </div>
        )}
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
      <FeedPlaceholder camera={selected} />

      <label>Name</label>
      <input
        value={selected.name}
        onChange={(e) => updateCamera(selected.id, { name: e.target.value })}
      />

      <label>Stream / device</label>
      <input
        value={selected.streamRef ?? ""}
        placeholder="RTSP URL, NVR channel, device id…"
        onChange={(e) => updateCamera(selected.id, { streamRef: e.target.value })}
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
          <label>Tilt (° down · blank = flat wedge)</label>
          <input
            type="number"
            min={0}
            max={85}
            placeholder="planar"
            value={selected.tiltDeg ?? ""}
            onChange={(e) => {
              // Blank clears tilt back to the legacy planar wedge; a number
              // projects the annular ground band (see tiltBand in coverage.ts).
              const raw = e.target.value;
              updateCamera(selected.id, {
                tiltDeg: raw === "" ? undefined : Math.min(85, Math.max(0, Number(raw) || 0)),
              });
            }}
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

      {/* Pixel density (DORI). "Covered" is not the same as "usable footage" —
          this is the number that says whether the far end of the range can
          identify a face or merely register that something moved. */}
      {selected.resolutionMP ? (
        <div className="readout mono">
          {pxPerMetreAt(selected, selected.rangeM).toFixed(0)} px/m at{" "}
          {selected.rangeM.toFixed(1)} m ({doriBand(pxPerMetreAt(selected, selected.rangeM)) ?? "—"})
          <br />
          identifies to {doriRangeM(selected, "identify").toFixed(1)} m · recognises to{" "}
          {doriRangeM(selected, "recognise").toFixed(1)} m · detects to{" "}
          {doriRangeM(selected, "detect").toFixed(1)} m
        </div>
      ) : (
        <p className="hint">Set resolution to rate this camera&rsquo;s usable range (DORI).</p>
      )}

      {/* Device + service record. A coverage map says what can be seen; keeping
          a plant running also needs to know which box it is, where it is on the
          network, and whether it works. */}
      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Device
      </div>

      <label>Status</label>
      <select
        value={selected.status ?? ""}
        onChange={(e) =>
          updateCamera(selected.id, {
            status: (e.target.value || undefined) as Camera["status"],
          })
        }
      >
        <option value="">— unspecified —</option>
        <option value="online">online</option>
        <option value="offline">offline</option>
        <option value="fault">fault</option>
        <option value="planned">planned</option>
      </select>

      <label>Make / model</label>
      <input
        value={selected.model ?? ""}
        placeholder="Axis P3265-LVE"
        onChange={(e) => updateCamera(selected.id, { model: e.target.value || undefined })}
      />

      <label>Resolution (MP)</label>
      <input
        type="number"
        min={0}
        step={0.1}
        value={selected.resolutionMP ?? ""}
        placeholder="e.g. 4"
        onChange={(e) => {
          const v = Number(e.target.value);
          updateCamera(selected.id, {
            resolutionMP: e.target.value === "" || !Number.isFinite(v) || v <= 0 ? undefined : v,
          });
        }}
      />

      <label>Management IP / host</label>
      <input
        value={selected.ipAddress ?? ""}
        placeholder="10.60.12.41"
        onChange={(e) => updateCamera(selected.id, { ipAddress: e.target.value || undefined })}
      />

      <label>Serial / asset tag</label>
      <input
        value={selected.serial ?? ""}
        onChange={(e) => updateCamera(selected.id, { serial: e.target.value || undefined })}
      />

      <label>Installed</label>
      <input
        type="date"
        value={selected.installedOn ?? ""}
        onChange={(e) => updateCamera(selected.id, { installedOn: e.target.value || undefined })}
      />

      <label>Last serviced</label>
      <input
        type="date"
        value={selected.lastServicedOn ?? ""}
        onChange={(e) => updateCamera(selected.id, { lastServicedOn: e.target.value || undefined })}
      />

      <label>Notes</label>
      <textarea
        rows={3}
        value={selected.notes ?? ""}
        placeholder="Glare at dusk, obstructed by signage, needs a lift to service…"
        onChange={(e) => updateCamera(selected.id, { notes: e.target.value || undefined })}
      />

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
