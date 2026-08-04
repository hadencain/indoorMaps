import { lazy, Suspense, useEffect } from "react";
import MapView from "../MapView";
import TopBar from "./TopBar";
import ToolRail from "./ToolRail";
import Inspector from "./Inspector";
import OperatorPanel from "./panels/OperatorPanel";
import MapChrome from "./MapChrome";
import ViewControls from "./ViewControls";
import StatusBar from "./StatusBar";
import { useStore } from "../store";
import { selectableUnits } from "../building";

// Lazy so three.js (imported only under src/editor3d) code-splits out of the
// initial chunk — the main vite config has no manualChunks, so a dynamic import
// is what creates the boundary. Never render this in place of MapView: MapView's
// init-effect cleanup calls map.remove(), destroying the MapLibre instance. The
// walk view mounts as an absolutely-positioned sibling OVER the (still-mounted) map.
const WalkView = lazy(() => import("../editor3d/WalkView"));
const FeedWall = lazy(() => import("../editor3d/FeedWall"));

export default function AppShell() {
  const building = useStore((s) => s.building);
  const mode = useStore((s) => s.mode);
  const walkMode = useStore((s) => s.walkMode);
  const feedWall = useStore((s) => s.feedWall);
  const selectedId = useStore((s) => s.selectedId);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const setTool = useStore((s) => s.setTool);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const deleteCamera = useStore((s) => s.deleteCamera);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

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
      if (useStore.getState().mode !== "edit") return; // no destructive keys in display
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

  // Undo/redo: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo. Skipped while
  // typing in a text field so editing a name/note keeps native undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().mode !== "edit") return; // undo/redo is authoring-only
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const display = mode === "display";
  return (
    <div className={display ? "shell display" : "shell"}>
      <TopBar />
      {!display && <ToolRail />}
      <div className="canvas-zone">
        <MapView />
        <ViewControls />
        {display && <MapChrome />}
        {walkMode && (
          <Suspense fallback={null}>
            <WalkView />
          </Suspense>
        )}
        {feedWall && (
          <Suspense fallback={null}>
            <FeedWall />
          </Suspense>
        )}
      </div>
      {display ? <OperatorPanel /> : <Inspector />}
      <StatusBar />
    </div>
  );
}
