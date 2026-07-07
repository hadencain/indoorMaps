import { useState } from "react";
import { Layers } from "lucide-react";
import { useStore } from "../store";
import type { LayerVisibility } from "../types";

// Rows in popover order. The Grid row is special: it proxies the existing
// showGrid/toggleGrid (one source of truth), not a LayerVisibility member.
type Row = { label: string; key: keyof LayerVisibility } | { label: string; grid: true };

const ROWS: Row[] = [
  { label: "Cameras", key: "cameras" },
  { label: "Coverage", key: "coverage" },
  { label: "Blind spots", key: "blindSpots" },
  { label: "Access zones", key: "accessZones" },
  { label: "Labels", key: "labels" },
  { label: "Grid", grid: true },
  { label: "Routes", key: "routes" },
  { label: "Incidents", key: "incidents" },
];

/** Floating Layers control: view-state, always available while any tool is
 *  active (it lives in ViewControls, not a rail tool that would vanish on tool
 *  switch). Toggles each overlay independently. */
export default function LayersControl() {
  const [open, setOpen] = useState(false);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);

  return (
    <div className="layers-ctl">
      <button className={open ? "active" : ""} title="Layers" onClick={() => setOpen((o) => !o)}>
        <Layers size={15} />
      </button>
      {open && (
        <div className="layers-pop">
          {ROWS.map((r) => {
            const checked = "grid" in r ? showGrid : layers[r.key];
            const onChange = "grid" in r ? toggleGrid : () => toggleLayer(r.key);
            return (
              <label className="layers-row" key={r.label}>
                <input type="checkbox" checked={checked} onChange={onChange} />
                <span>{r.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
