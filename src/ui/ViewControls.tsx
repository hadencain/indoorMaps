import { Box, Footprints, Grid3x3, LayoutGrid, Ruler } from "lucide-react";
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
  const view3d = useStore((s) => s.view3d);
  const setView3d = useStore((s) => s.setView3d);
  const walkMode = useStore((s) => s.walkMode);
  const feedWall = useStore((s) => s.feedWall);
  const setFeedWall = useStore((s) => s.setFeedWall);
  const setWalkMode = useStore((s) => s.setWalkMode);

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
      <button
        className={view3d ? "active" : ""}
        title="3D view (tilt & rotate)"
        onClick={() => setView3d(!view3d)}
      >
        <Box size={15} />
      </button>
      <button
        className={walkMode ? "active" : ""}
        title="Walk the floor (first person)"
        onClick={() => setWalkMode(!walkMode)}
      >
        <Footprints size={15} />
      </button>
      <button
        className={feedWall ? "active" : ""}
        title="Feed wall (operator view)"
        onClick={() => setFeedWall(!feedWall)}
      >
        <LayoutGrid size={15} />
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
