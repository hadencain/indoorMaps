import { useStore } from "../../store";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../../categories";
import type { Category } from "../../types";

export default function DrawPanel() {
  const activeTool = useStore((s) => s.activeTool);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const draftCategory = useStore((s) => s.draftCategory);
  const setDraftCategory = useStore((s) => s.setDraftCategory);
  return (
    <div className="panel">
      <div className="panel-title">{activeTool === "rect" ? "Rectangle" : "Polygon"}</div>
      {activeTool === "rect" ? (
        <p className="hint">Drag a rectangle on the canvas. Releases into a routable room.</p>
      ) : (
        <p className="hint">
          Click to drop vertices. Click the first point again or press Enter to close; Esc cancels.
        </p>
      )}
      <label>New unit type</label>
      <select
        value={draftCategory}
        onChange={(e) => setDraftCategory(e.target.value as Category)}
      >
        {CATEGORY_ORDER.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <p className="hint">
        {showGrid
          ? `Snapping to a ${gridSize} m grid (toggle in view controls).`
          : "Grid snapping is off (toggle in view controls)."}
      </p>
    </div>
  );
}
