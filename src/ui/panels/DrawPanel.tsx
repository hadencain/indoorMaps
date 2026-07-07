import { useStore } from "../../store";

export default function DrawPanel() {
  const activeTool = useStore((s) => s.activeTool);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
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
      <p className="hint">
        {showGrid
          ? `Snapping to a ${gridSize} m grid (toggle in view controls).`
          : "Grid snapping is off (toggle in view controls)."}
      </p>
    </div>
  );
}
