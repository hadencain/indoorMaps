import type { ReactNode } from "react";
import { useStore } from "../store";
import FloorContentsPanel from "./panels/FloorContentsPanel";
import PropertiesPanel from "./panels/PropertiesPanel";
import DrawPanel from "./panels/DrawPanel";
import LinkPanel from "./panels/LinkPanel";
import RoutePanel from "./panels/RoutePanel";
import CameraPanel from "./panels/CameraPanel";
import IncidentPanel from "./panels/IncidentPanel";
import PatrolPanel from "./panels/PatrolPanel";
import BulkPanel from "./panels/BulkPanel";

export default function Inspector() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const selectedIncidentId = useStore((s) => s.selectedIncidentId);

  let body: ReactNode;
  // A selected camera wins over tool/unit routing (mutually exclusive with unit
  // selection), so clicking a camera in any tool shows its panel.
  if (selectedCameraId) body = <CameraPanel />;
  else if (activeTool === "rect" || activeTool === "polygon") body = <DrawPanel />;
  else if (activeTool === "link") body = <LinkPanel />;
  else if (activeTool === "route") body = <RoutePanel />;
  else if (activeTool === "camera") body = <CameraPanel />;
  else if (activeTool === "incident") body = <IncidentPanel />;
  else if (activeTool === "patrol") body = <PatrolPanel />;
  // A multi-selection (shift-click) routes to the bulk editor, ahead of the
  // single-unit Properties branch but behind camera + active tool panels.
  else if (selectedIds.length > 1) body = <BulkPanel />;
  else if (activeTool === "vertex" || selectedId) body = <PropertiesPanel />;
  else body = <FloorContentsPanel />;

  return (
    <aside
      className="inspector"
      key={activeTool + (selectedCameraId ?? selectedIncidentId ?? selectedId ?? "")}
    >
      {body}
    </aside>
  );
}
