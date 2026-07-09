import { useStore } from "../../store";
import { distM } from "../../geo";
import { formatLength } from "../../format";
import FeedPlaceholder from "./FeedPlaceholder";

/**
 * Click-to-camera preview panel (inspect tool). Reads the transient `probe`
 * resolved in MapView from the occlusion-clipped visibility rings:
 *  - no probe yet → hint to click,
 *  - probe with cameras → a live-preview surface for the selected camera plus
 *    an "also visible from" list of the other covering cameras (nearest-first),
 *  - probe with no cameras → an explicit blind-failure state.
 */
export default function InspectPanel() {
  const building = useStore((s) => s.building);
  const unit = useStore((s) => s.unit);
  const probe = useStore((s) => s.probe);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);

  if (!probe) {
    return (
      <div className="panel">
        <div className="panel-title">Inspect / live preview</div>
        <p className="hint">Click a point on the map to preview its cameras.</p>
      </div>
    );
  }

  const [px, py] = probe.point;
  const coordText = `${px.toFixed(1)}, ${py.toFixed(1)} m`;

  // Blind failure — nothing on this floor sees the clicked point.
  if (probe.cameraIds.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Inspect / live preview</div>
        <div className="readout mono" style={{ marginTop: 4 }}>
          point {coordText}
        </div>
        <div className="probe-blind">No camera covers this point.</div>
      </div>
    );
  }

  const camById = new Map(building.cameras.map((c) => [c.id, c]));
  // Anchor the preview to the selected camera when it's part of this probe;
  // otherwise fall back to the BEST-VIEW (first) covering camera.
  const anchorId =
    selectedCameraId && probe.cameraIds.includes(selectedCameraId)
      ? selectedCameraId
      : probe.cameraIds[0];
  const selected = camById.get(anchorId);
  const others = probe.cameraIds.filter((id) => id !== anchorId);
  const pct = (id: string) => `${Math.round((probe.scores?.[id] ?? 0) * 100)}%`;

  return (
    <div className="panel">
      <div className="panel-title">Inspect / live preview</div>

      {selected && (
        <>
          <FeedPlaceholder camera={selected} />
          <div className="readout mono" style={{ marginTop: 10 }}>
            <div>
              {selected.name} <span className="best-view">BEST VIEW · {pct(anchorId)}</span>
            </div>
            <div className="probe-stream">
              {selected.streamRef ? selected.streamRef : "no stream set"}
            </div>
            <div>point {coordText}</div>
          </div>
        </>
      )}

      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Also visible from
      </div>
      {others.length === 0 ? (
        <p className="hint">No other camera sees this point.</p>
      ) : (
        <div className="roomlist">
          {others.map((id) => {
            const c = camById.get(id);
            if (!c) return null;
            return (
              <div className="roomrow" key={id}>
                <button
                  className="camrow-select"
                  onClick={() => setSelectedCamera(id)}
                  title={`View quality ${pct(id)} · ${formatLength(distM(c.at, probe.point), unit)} away`}
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
  );
}
