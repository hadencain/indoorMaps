import { useMemo } from "react";
import { useStore, ALL_AMENITY_KINDS } from "../../store";
import type { AmenityKind, LayerVisibility } from "../../types";
import FeedPlaceholder from "./FeedPlaceholder";
import { useVisibility } from "../visibility";
import { unitsSeenByCameraRing } from "../../security/coverage-link";

/**
 * Display-mode sidebar — the read-only operator console. Two states:
 *  - a camera is selected via the directory (and no probe is live) → its feed +
 *    read-only details, its coverage cone highlighted on the map,
 *  - everything else, including a live probe → operator controls: quick layers,
 *    patrol-route highlight, per-kind amenity filter, and a camera directory.
 * The click-to-camera probe surface is the floating camera window over the map
 * (rendered by MapView), not this sidebar — a probe never swaps this panel.
 * No authoring controls exist here — this is what the security team runs on.
 */

const AMENITY_LABEL: Record<AmenityKind, string> = {
  restroom: "Restrooms", atm: "ATMs", exit: "Exits", info: "Info points", firstaid: "First aid",
  ticketing: "Ticketing", dining: "Dining", bar: "Bars", coatcheck: "Coat check", smoking: "Smoking",
};
const LAYER_LABEL: Partial<Record<keyof LayerVisibility, string>> = {
  coverage: "Coverage", blindSpots: "Blind spots", cameras: "Cameras", labels: "Labels",
};

function CameraView({ id }: { id: string }) {
  const building = useStore((s) => s.building);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const { polys } = useVisibility();
  const cam = building.cameras.find((c) => c.id === id);
  const covers = useMemo(() => {
    const c = building.cameras.find((x) => x.id === id);
    const r = polys.find((p) => p.cameraId === id)?.ring;
    return c && r ? unitsSeenByCameraRing(c, r, building.units) : [];
  }, [id, polys, building.cameras, building.units]);
  if (!cam) return null;
  const kindLabel = cam.kind === "dome" ? "Dome · 360°" : `${cam.kind} · ${cam.fovDeg}° FOV`;
  return (
    <div className="panel op-panel">
      <button className="op-back" onClick={() => setSelectedCamera(null)}>
        ← All cameras
      </button>
      <div className="panel-title">{cam.name}</div>
      <FeedPlaceholder camera={cam} />
      <div className="readout mono" style={{ marginTop: 10 }}>
        <div>{kindLabel} · {cam.rangeM} m range</div>
        <div className="probe-stream">{cam.streamRef ? cam.streamRef : "no stream set"}</div>
      </div>
      <div className="op-section">
        <div className="op-head"><span>Covers</span><span className="op-count">{covers.length}</span></div>
        {covers.length === 0 ? (
          <p className="hint">No mapped space in view.</p>
        ) : (
          <div className="roomlist scroll">
            {covers.map((u) => (
              <div className="roomrow" key={u.unitId}>
                <span className="camrow-select" style={{ cursor: "default" }}>
                  <span className="vlabel">{u.name}</span>
                  <span className="camrow-kind">{Math.round(u.score * 100)}%</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Its coverage cone is highlighted on the map. Click any point on the floor to find every
        camera that sees it.
      </p>
    </div>
  );
}

function OperatorControls() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const amenityFilter = useStore((s) => s.amenityFilter);
  const toggleAmenityKind = useStore((s) => s.toggleAmenityKind);
  const setAllAmenityKinds = useStore((s) => s.setAllAmenityKinds);
  const toggleAmenities = () => toggleLayer("amenities");
  const highlightedPatrolId = useStore((s) => s.highlightedPatrolId);
  const setHighlightedPatrol = useStore((s) => s.setHighlightedPatrol);
  const patrolPlayback = useStore((s) => s.patrolPlayback);
  const startPatrolPlayback = useStore((s) => s.startPatrolPlayback);
  const stopPatrolPlayback = useStore((s) => s.stopPatrolPlayback);
  const togglePatrolPause = useStore((s) => s.togglePatrolPause);
  const cyclePatrolSpeed = useStore((s) => s.cyclePatrolSpeed);

  const cams = building.cameras.filter((c) => c.ordinal === ordinal);
  const patrols = (building.patrols ?? []).filter((p) => p.ordinal === ordinal);
  const kindsOnFloor = ALL_AMENITY_KINDS.filter((k) =>
    (building.amenities ?? []).some((a) => a.ordinal === ordinal && a.kind === k),
  );
  const floorName = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const domeCount = cams.filter((c) => c.kind === "dome").length;

  return (
    <div className="panel op-panel">
      <div className="panel-title">Operator · {floorName}</div>
      <p className="hint">Click any point on the map to see which camera covers it — then open its feed.</p>

      <div className="op-section">
        <div className="op-head"><span>View layers</span></div>
        {(["coverage", "blindSpots", "cameras", "labels"] as (keyof LayerVisibility)[]).map((k) => (
          <label className="layers-row" key={k}>
            <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />
            <span>{LAYER_LABEL[k]}</span>
          </label>
        ))}
      </div>

      <div className="op-section">
        <div className="op-head"><span>Patrol routes</span><span className="op-count">{patrols.length}</span></div>
        {patrols.length === 0 ? (
          <p className="hint">None on this floor.</p>
        ) : (
          <div className="roomlist">
            {patrols.map((p) => {
              const playing = patrolPlayback?.patrolId === p.id;
              return (
                <div className="roomrow" key={p.id}>
                  <button
                    className={`camrow-select ${highlightedPatrolId === p.id ? "on" : ""}`}
                    onClick={() => setHighlightedPatrol(p.id)}
                    title="Highlight this route on the map"
                  >
                    <span className="vlabel">{p.name}</span>
                    {!playing && <span className="camrow-kind">{p.points.length} pts</span>}
                  </button>
                  {playing ? (
                    <span className="patrol-ctl">
                      <button
                        className="op-play on"
                        title={patrolPlayback.playing ? "Pause" : "Resume"}
                        onClick={togglePatrolPause}
                      >
                        {patrolPlayback.playing ? "❚❚" : "▶"}
                      </button>
                      <button className="op-play" title="Walking speed" onClick={cyclePatrolSpeed}>
                        {patrolPlayback.speed}×
                      </button>
                      <button className="op-play stop" title="End tour" onClick={stopPatrolPlayback}>
                        ■
                      </button>
                    </span>
                  ) : (
                    <button
                      className="op-play"
                      title="Walk this route — the camera window follows the guard"
                      onClick={() => startPatrolPlayback(p.id)}
                    >
                      ▶
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {patrolPlayback && (
          <p className="hint patrol-live">
            Guard tour running — the camera window hands off between cameras as
            the dot walks. ■ or Esc ends it.
          </p>
        )}
      </div>

      <div className="op-section">
        <div className="op-head">
          <span>Amenities</span>
          <span className="op-links">
            <button onClick={() => setAllAmenityKinds(true)}>All</button>
            <button onClick={() => setAllAmenityKinds(false)}>None</button>
          </span>
        </div>
        <label className="layers-row">
          <input type="checkbox" checked={layers.amenities} onChange={toggleAmenities} />
          <span>Show amenity markers</span>
        </label>
        {kindsOnFloor.length === 0 ? (
          <p className="hint">None on this floor.</p>
        ) : (
          kindsOnFloor.map((k) => (
            <label className="layers-row sub" key={k}>
              <input
                type="checkbox"
                checked={amenityFilter[k] !== false}
                disabled={!layers.amenities}
                onChange={() => toggleAmenityKind(k)}
              />
              <span>{AMENITY_LABEL[k]}</span>
            </label>
          ))
        )}
      </div>

      <div className="op-section">
        <div className="op-head">
          <span>Cameras</span>
          <span className="op-count">{cams.length}{domeCount ? ` · ${domeCount} dome` : ""}</span>
        </div>
        <div className="roomlist scroll">
          {cams.map((c) => (
            <div className="roomrow" key={c.id}>
              <button className="camrow-select" onClick={() => setSelectedCamera(c.id)} title="Open feed">
                <span className="vlabel">{c.name}</span>
                <span className="camrow-kind">{c.kind}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function OperatorPanel() {
  const probe = useStore((s) => s.probe);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  // A live probe anchors a camera (selectedCameraId) for the floating window —
  // that must NOT swap the sidebar to CameraView. Directory selection only.
  return (
    <aside className="inspector">
      {selectedCameraId && !probe ? <CameraView id={selectedCameraId} /> : <OperatorControls />}
    </aside>
  );
}
