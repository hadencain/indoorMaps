import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import { parseDxfText, type DxfParseResult } from "../dxf";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../categories";
import type { Category } from "../types";

type UnitChoice = "detected" | "mm" | "cm" | "m" | "in" | "ft";

interface Props {
  raw: string;
  initial: DxfParseResult;
  onClose: () => void;
}

/** DXF/CAD import wizard: pick units, pick which layers become the vector
 *  underlay, opt individual layers' closed shapes into real units, then
 *  import. Opened by TopBar's Data menu after a successful parseDxfText. */
export default function DxfImportDialog({ raw, initial, onClose }: Props) {
  const importDxf = useStore((s) => s.importDxf);
  const [unitChoice, setUnitChoice] = useState<UnitChoice>("detected");
  const [result, setResult] = useState<DxfParseResult>(initial);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initial.layers.map((l) => [l.name, true])),
  );
  const [convert, setConvert] = useState<Record<string, boolean>>({});
  const [category, setCategory] = useState<Category>("room");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changeUnit = (u: UnitChoice) => {
    setUnitChoice(u);
    const r = parseDxfText(raw, u === "detected" ? undefined : u);
    if (r.ok) setResult(r.result);
  };

  const skippedEntries = Object.entries(result.skipped).filter(([, n]) => n > 0);

  const doImport = () => {
    const layerNames = result.layers.filter((l) => selected[l.name]).map((l) => l.name);
    const convertLayers = result.layers
      .filter((l) => selected[l.name] && convert[l.name] && l.closedShapes.length > 0)
      .map((l) => l.name);
    importDxf(result, { layerNames, convertLayers, category });
    onClose();
  };

  return (
    <div className="wiz-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wiz">
        <div className="wiz-head">
          <span className="wiz-title">Import DXF (CAD)</span>
          <button className="wiz-x" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
        <div className="wiz-body">
          <label className="wiz-label">Units</label>
          <select
            className="wiz-input"
            value={unitChoice}
            onChange={(e) => changeUnit(e.target.value as UnitChoice)}
          >
            <option value="detected">
              Detected{result.unitsGuessed ? " (guessed — verify below)" : ""}
            </option>
            <option value="mm">Millimetres</option>
            <option value="cm">Centimetres</option>
            <option value="m">Metres</option>
            <option value="in">Inches</option>
            <option value="ft">Feet</option>
          </select>

          <label className="wiz-label">Layers</label>
          <div className="dxf-layer-list">
            {result.layers.map((l) => (
              <div key={l.name} className="dxf-layer-row">
                <label className="dxf-layer-name">
                  <input
                    type="checkbox"
                    checked={!!selected[l.name]}
                    onChange={(e) => setSelected((s) => ({ ...s, [l.name]: e.target.checked }))}
                  />
                  {l.name} — {l.entityCount} entities, {l.closedShapes.length} closed shapes
                </label>
                <label className="dxf-layer-convert">
                  <input
                    type="checkbox"
                    disabled={!selected[l.name] || l.closedShapes.length === 0}
                    checked={!!convert[l.name]}
                    onChange={(e) => setConvert((s) => ({ ...s, [l.name]: e.target.checked }))}
                  />
                  convert closed shapes
                </label>
              </div>
            ))}
            {result.layers.length === 0 && <p className="wiz-hint">No linework found in this file.</p>}
          </div>

          <label className="wiz-label">Category for converted units</label>
          <select
            className="wiz-input"
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>

          <p className="wiz-derived-line">
            Plan extent {result.widthM.toFixed(0)} × {result.heightM.toFixed(0)} m
            {result.unitsGuessed ? " · units could not be detected — verify above" : ""}
          </p>
          {skippedEntries.length > 0 && (
            <p className="wiz-hint">
              Skipped: {skippedEntries.map(([t, n]) => `${n} ${t}`).join(", ")}
            </p>
          )}

          <div className="wiz-actions">
            <button className="wiz-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <span className="wiz-spacer" />
            <button className="wiz-btn primary" onClick={doImport}>
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
