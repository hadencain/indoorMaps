import { useMemo } from "react";
import { useStore } from "../../store";
import { bbox, polygonArea, polygonPerimeter } from "../../geo";
import { formatArea, formatLength } from "../../format";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../../categories";
import { rankCamerasForUnitWithRings } from "../../security/coverage-link";
import { useVisibility } from "../visibility";
import { SECURITY_LEVELS, SECURITY_LABELS, SECURITY_COLORS, securityOf } from "../security";
import type { Category, SecurityLevel } from "../../types";

export default function PropertiesPanel() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const renameUnit = useStore((s) => s.renameUnit);
  const setCategory = useStore((s) => s.setCategory);
  const setSecurity = useStore((s) => s.setSecurity);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const { polys } = useVisibility();
  // Cameras that see this unit, ranked by view quality (best first). Built from
  // the SHARED active-floor visibility (useVisibility's per-camera cache) so it
  // never re-runs the full-floor ray-cast on a rename keystroke, and it recomputes
  // whenever coverage changes. Skipped for circulation / exterior.
  const seenBy = useMemo(() => {
    const u = building.units.find((x) => x.id === selectedId);
    if (!u || u.category === "outside" || u.category === "corridor") return [];
    const ringById = new Map(polys.map((p) => [p.cameraId, p.ring]));
    const cams = building.cameras.filter((c) => c.ordinal === u.ordinal);
    return rankCamerasForUnitWithRings(u, cams, ringById);
  }, [polys, selectedId, building.units, building.cameras]);
  const u = building.units.find((x) => x.id === selectedId);
  if (!u)
    return (
      <div className="panel">
        <p className="hint">Select a unit to edit its properties.</p>
      </div>
    );
  const [x0, y0, x1, y1] = bbox(u.polygon);

  return (
    <div className="panel">
      <div className="panel-title">Properties</div>
      <label>Name</label>
      <input value={u.name} onChange={(e) => renameUnit(u.id, e.target.value)} />
      <label>Category</label>
      <select value={u.category} onChange={(e) => setCategory(u.id, e.target.value as Category)}>
        {CATEGORY_ORDER.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <label>Security</label>
      <select
        className="sec-selector"
        style={{ borderColor: SECURITY_COLORS[securityOf(u)] }}
        value={securityOf(u)}
        onChange={(e) => setSecurity(u.id, e.target.value as SecurityLevel)}
      >
        {SECURITY_LEVELS.map((lvl) => (
          <option key={lvl} value={lvl}>
            {SECURITY_LABELS[lvl]}
          </option>
        ))}
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        <div>
          <span className="k">area</span> {formatArea(polygonArea(u.polygon), unit)}
        </div>
        <div>
          <span className="k">size</span> {formatLength(x1 - x0, unit)} ×{" "}
          {formatLength(y1 - y0, unit)}
        </div>
        <div>
          <span className="k">perim</span> {formatLength(polygonPerimeter(u.polygon), unit)}
        </div>
      </div>
      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Seen by
      </div>
      {seenBy.length === 0 ? (
        <p className="hint">No camera coverage.</p>
      ) : (
        <div className="roomlist">
          {seenBy.map((c) => (
            <div className="roomrow" key={c.cameraId}>
              <button
                className="camrow-select"
                onClick={() => setSelectedCamera(c.cameraId)}
                title={`Select camera · view quality ${Math.round(c.score * 100)}%`}
              >
                <span className="vlabel">{c.name}</span>
                <span className="camrow-kind">{Math.round(c.score * 100)}%</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        className={`wide ${activeTool === "vertex" ? "active" : ""}`}
        style={{ marginTop: 8 }}
        onClick={() => setTool(activeTool === "vertex" ? "select" : "vertex")}
      >
        {activeTool === "vertex" ? "◼ Editing vertices" : "✎ Edit vertices"}
      </button>
      <button className="wide danger" style={{ marginTop: 8 }} onClick={() => deleteUnit(u.id)}>
        Delete unit
      </button>
    </div>
  );
}
