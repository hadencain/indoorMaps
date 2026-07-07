import { useEffect } from "react";
import MapView from "../MapView";
import TopBar from "./TopBar";
import ToolRail from "./ToolRail";
import Inspector from "./Inspector";
import ViewControls from "./ViewControls";
import StatusBar from "./StatusBar";
import { useStore } from "../store";
import { selectableUnits } from "../building";

export default function AppShell() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const setTool = useStore((s) => s.setTool);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const deleteCamera = useStore((s) => s.deleteCamera);

  // Keep start/goal valid as rooms come and go.
  useEffect(() => {
    const rooms = selectableUnits(building);
    if (rooms.length === 0) return;
    if (!rooms.some((r) => r.id === startId)) setStart(rooms[0].id);
    if (!rooms.some((r) => r.id === goalId)) setGoal(rooms[rooms.length - 1].id);
  }, [building, startId, goalId, setStart, setGoal]);

  // Delete/Backspace removes selected room (unless typing); Esc handled in MapView.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      // Camera selection takes precedence when a camera is picked.
      if (selectedCameraId) {
        deleteCamera(selectedCameraId);
        return;
      }
      if (selectedId && building.units.some((u) => u.id === selectedId && u.category === "room")) {
        deleteUnit(selectedId);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, building, deleteUnit, setTool, selectedCameraId, deleteCamera]);

  return (
    <div className="shell">
      <TopBar />
      <ToolRail />
      <div className="canvas-zone">
        <MapView />
        <ViewControls />
      </div>
      <Inspector />
      <StatusBar />
    </div>
  );
}
