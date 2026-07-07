import { Grid3x3, Ruler } from "lucide-react";
import { useStore } from "../store";
import LayersControl from "./LayersControl";

export default function ViewControls() {
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const gridSize = useStore((s) => s.gridSize);
  const setGridSize = useStore((s) => s.setGridSize);
  const showDims = useStore((s) => s.showDims);
  const toggleDims = useStore((s) => s.toggleDims);
  const unit = useStore((s) => s.unit);
  const setUnit = useStore((s) => s.setUnit);

  return (
    <div className="viewctl">
      <button className={showGrid ? "active" : ""} title="Grid & snap" onClick={toggleGrid}>
        <Grid3x3 size={15} />
      </button>
      {showGrid && (
        <input
          type="number"
          className="numin sm"
          min={0.25}
          max={20}
          step={0.25}
          value={gridSize}
          onChange={(e) => setGridSize(Number(e.target.value))}
          title="Grid size (m)"
        />
      )}
      <button className={showDims ? "active" : ""} title="Dimensions" onClick={toggleDims}>
        <Ruler size={15} />
      </button>
      <div className="unittoggle">
        <button className={unit === "m" ? "active" : ""} onClick={() => setUnit("m")}>
          m
        </button>
        <button className={unit === "ft" ? "active" : ""} onClick={() => setUnit("ft")}>
          ft
        </button>
      </div>
      <LayersControl />
    </div>
  );
}
