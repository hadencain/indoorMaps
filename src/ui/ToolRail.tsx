import {
  MousePointer2,
  Square,
  Hexagon,
  Spline,
  ArrowUpDown,
  Route,
  Cctv,
  MapPin,
  Footprints,
  Eye,
} from "lucide-react";
import { useStore } from "../store";
import type { Tool } from "../store";

const TOOLS: { id: Tool; label: string; Icon: typeof Square; needsSelection?: boolean }[] = [
  { id: "select", label: "Select", Icon: MousePointer2 },
  { id: "rect", label: "Rectangle", Icon: Square },
  { id: "polygon", label: "Polygon", Icon: Hexagon },
  { id: "vertex", label: "Edit vertices", Icon: Spline, needsSelection: true },
  { id: "link", label: "Vertical link", Icon: ArrowUpDown },
  { id: "route", label: "Wayfinding", Icon: Route },
  { id: "camera", label: "Cameras", Icon: Cctv },
  { id: "incident", label: "Incidents", Icon: MapPin },
  { id: "patrol", label: "Patrol paths", Icon: Footprints },
  { id: "inspect", label: "Inspect / live preview", Icon: Eye },
];

export default function ToolRail() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const setTool = useStore((s) => s.setTool);

  return (
    <div className="rail">
      {TOOLS.map(({ id, label, Icon, needsSelection }) => {
        const disabled = needsSelection && !selectedId;
        return (
          <button
            key={id}
            className={`rail-btn ${activeTool === id ? "active" : ""}`}
            title={label}
            disabled={disabled}
            onClick={() => setTool(id)}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
