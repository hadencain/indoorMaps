import type { ReactNode } from "react";
import { useStore } from "../store";
import FloorContentsPanel from "./panels/FloorContentsPanel";
import PropertiesPanel from "./panels/PropertiesPanel";
import DrawPanel from "./panels/DrawPanel";
import LinkPanel from "./panels/LinkPanel";
import RoutePanel from "./panels/RoutePanel";

export default function Inspector() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);

  let body: ReactNode;
  if (activeTool === "rect" || activeTool === "polygon") body = <DrawPanel />;
  else if (activeTool === "link") body = <LinkPanel />;
  else if (activeTool === "route") body = <RoutePanel />;
  else if (activeTool === "vertex" || selectedId) body = <PropertiesPanel />;
  else body = <FloorContentsPanel />;

  return (
    <aside className="inspector" key={activeTool + (selectedId ?? "")}>
      {body}
    </aside>
  );
}
