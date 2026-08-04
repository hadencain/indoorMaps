import { useStore } from "../store";
import { useRoute } from "./route";
import { useVisibility } from "./visibility";

const HINTS: Record<string, string> = {
  select: "Click a unit to select · drag door dots · right-click a door to make it an entrance",
  rect: "Drag a rectangle to add a room",
  polygon: "Click to add vertices · Enter/first-point to close · Esc to cancel",
  vertex: "Drag handles · + to insert · right-click a handle to delete",
  link: "Click a unit, switch floor, click its counterpart",
  column: "click to place a column — columns block camera sightlines",
  route: "Pick From and To in the inspector",
  camera: "Click to place a camera · drag to move · drag the handle to aim · sightlines clip to walls",
  inspect: "Click any point to see which camera covers it · click a camera for its feed",
};

export default function StatusBar() {
  const activeTool = useStore((s) => s.activeTool);
  const mode = useStore((s) => s.mode);
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const routeMode = useStore((s) => s.routeMode);
  const showCoverage = useStore((s) => s.layers.coverage);
  const { geom, exit } = useRoute();
  const { coverage } = useVisibility();
  const name = (id: string) => building.units.find((u) => u.id === id)?.name ?? id;
  const floors = geom ? `${geom.floors.length} floor${geom.floors.length === 1 ? "" : "s"}` : "";
  const floorName = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const camCount = building.cameras.filter((c) => c.ordinal === ordinal).length;

  if (mode === "display" || mode === "operator") {
    return (
      <footer className="statusbar mono">
        <span className="st-tool">{mode}</span>
        <span className="st-sep">·</span>
        <span>
          {floorName} · {camCount} cameras
          {showCoverage && coverage ? ` · coverage ${(coverage.coveragePct * 100).toFixed(0)}%` : ""}
        </span>
        <span className="st-hint">
          {mode === "operator"
            ? "type a camera number + Enter · double-click a tile to fullscreen · H = home"
            : HINTS.inspect}
        </span>
      </footer>
    );
  }

  return (
    <footer className="statusbar mono">
      <span className="st-tool">{activeTool}</span>
      <span className="st-sep">·</span>
      {activeTool === "camera" ? (
        <span>
          Cameras · {camCount} on {floorName}
          {showCoverage && coverage
            ? ` · coverage ${(coverage.coveragePct * 100).toFixed(0)}%`
            : ""}
        </span>
      ) : geom ? (
        routeMode === "egress" ? (
          <span>
            Egress · {name(startId)} → {exit?.name ?? "Exit"} · {geom.metres.toFixed(0)} m · {floors}
          </span>
        ) : (
          <span>
            {name(startId)} → {name(goalId)} · {geom.metres.toFixed(0)} m · {floors}
          </span>
        )
      ) : (
        <span className="warn">{routeMode === "egress" ? "no exit reachable" : "no route"}</span>
      )}
      <span className="st-hint">{HINTS[activeTool]}</span>
      <span className="st-grid">{showGrid ? `grid ${gridSize} m` : "grid off"}</span>
    </footer>
  );
}
