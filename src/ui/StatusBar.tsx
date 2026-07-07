import { useStore } from "../store";
import { useRoute } from "./route";

const HINTS: Record<string, string> = {
  select: "Click a unit to select · drag door dots · right-click for properties",
  rect: "Drag a rectangle to add a room",
  polygon: "Click to add vertices · Enter/first-point to close · Esc to cancel",
  vertex: "Drag handles · + to insert · right-click a handle to delete",
  link: "Click a unit, switch floor, click its counterpart",
  route: "Pick From and To in the inspector",
};

export default function StatusBar() {
  const activeTool = useStore((s) => s.activeTool);
  const building = useStore((s) => s.building);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const { geom } = useRoute();
  const name = (id: string) => building.units.find((u) => u.id === id)?.name ?? id;

  return (
    <footer className="statusbar mono">
      <span className="st-tool">{activeTool}</span>
      <span className="st-sep">·</span>
      {geom ? (
        <span>
          {name(startId)} → {name(goalId)} · {geom.metres.toFixed(0)} m · {geom.floors.length} floor
          {geom.floors.length === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="warn">no route</span>
      )}
      <span className="st-hint">{HINTS[activeTool]}</span>
      <span className="st-grid">{showGrid ? `grid ${gridSize} m` : "grid off"}</span>
    </footer>
  );
}
