import { useMemo } from "react";
import { useStore } from "../../store";
import { distM } from "../../geo";
import { formatLength } from "../../format";
import { rankCamerasForPoint } from "../../coverage";
import { useVisibility } from "../visibility";
import FeedPlaceholder from "./FeedPlaceholder";

/**
 * Click-to-camera preview (inspect / display). The covering-camera ranking is
 * DERIVED LIVE here from the active floor's current visibility polygons — the
 * probe stores only the clicked point, so the ranking (and its view-quality %)
 * always reflects current coverage and can never show a stale snapshot after a
 * camera is moved/aimed/added/deleted or an edit is undone.
 */
export default function InspectPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const unit = useStore((s) => s.unit);
  const probe = useStore((s) => s.probe);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const { polys } = useVisibility();

  // Best-view-first ranking (aim + proximity + depth-in-view), recomputed on any
  // coverage change via `polys`.
  const ranked = useMemo(() => {
    if (!probe) return [];
    const ringById = new Map(polys.map((p) => [p.cameraId, p.ring]));
    const cams = building.cameras.filter((c) => c.ordinal === ordinal);
    return rankCamerasForPoint(probe.point, cams, ringById);
  }, [probe, polys, building.cameras, ordinal]);

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
  if (ranked.length === 0) {
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
  const scoreById = new Map(ranked.map((r) => [r.cameraId, r.score]));
  const ids = ranked.map((r) => r.cameraId);
  // Anchor the preview to the selected camera when it covers this point;
  // otherwise the BEST-VIEW (first) camera.
  const anchorId = selectedCameraId && ids.includes(selectedCameraId) ? selectedCameraId : ids[0];
  const selected = camById.get(anchorId);
  const others = ids.filter((id) => id !== anchorId);
  const pct = (id: string) => `${Math.round((scoreById.get(id) ?? 0) * 100)}%`;

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
