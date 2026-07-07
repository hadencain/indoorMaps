import { useStore } from "../../store";
import { bbox, polygonArea, polygonPerimeter } from "../../geo";
import { formatArea, formatLength } from "../../format";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../../categories";
import type { Category } from "../../types";

const SECURITY_LEVELS: ReadonlyArray<"public" | "secure" | "restricted"> = [
  "public",
  "secure",
  "restricted",
];

export default function PropertiesPanel() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const renameUnit = useStore((s) => s.renameUnit);
  const setCategory = useStore((s) => s.setCategory);
  const setSecurity = useStore((s) => s.setSecurity);
  const deleteUnit = useStore((s) => s.deleteUnit);
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
        value={u.security ?? "public"}
        onChange={(e) =>
          setSecurity(u.id, e.target.value as "public" | "secure" | "restricted")
        }
      >
        {SECURITY_LEVELS.map((lvl) => (
          <option key={lvl} value={lvl}>
            {lvl}
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
