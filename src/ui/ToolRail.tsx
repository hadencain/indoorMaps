import {
  MousePointer2,
  Square,
  Hexagon,
  Spline,
  ArrowUpDown,
  Cylinder,
  Route,
  Cctv,
  MapPin,
  Footprints,
  Eye,
  ClipboardCheck,
} from "lucide-react";
import { useStore } from "../store";
import type { Tool } from "../store";

const GROUPS: {
  label: string;
  tools: { id: Tool; label: string; Icon: typeof Square; needsSelection?: boolean }[];
}[] = [
  {
    label: "Build",
    tools: [
      { id: "select", label: "Select", Icon: MousePointer2 },
      { id: "rect", label: "Rectangle", Icon: Square },
      { id: "polygon", label: "Polygon", Icon: Hexagon },
      { id: "vertex", label: "Edit vertices", Icon: Spline, needsSelection: true },
      { id: "link", label: "Vertical link", Icon: ArrowUpDown },
      { id: "column", label: "Column", Icon: Cylinder },
    ],
  },
  {
    label: "Security",
    tools: [
      { id: "camera", label: "Cameras", Icon: Cctv },
      { id: "incident", label: "Incidents", Icon: MapPin },
      { id: "patrol", label: "Patrol paths", Icon: Footprints },
    ],
  },
  {
    label: "Review",
    tools: [
      { id: "route", label: "Wayfinding", Icon: Route },
      { id: "inspect", label: "Inspect / live preview", Icon: Eye },
      { id: "review", label: "Review checklist", Icon: ClipboardCheck },
    ],
  },
];

export default function ToolRail() {
  const activeTool = useStore((s) => s.activeTool);
  const selectedId = useStore((s) => s.selectedId);
  const setTool = useStore((s) => s.setTool);
  return (
    <div className="rail">
      {GROUPS.map((g, gi) => (
        <div className="rail-group" key={g.label}>
          {gi > 0 && <div className="rail-sep" />}
          <div className="rail-group-label">{g.label}</div>
          {g.tools.map(({ id, label, Icon, needsSelection }) => {
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
      ))}
    </div>
  );
}
