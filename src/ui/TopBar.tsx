import { useState } from "react";
import { ChevronDown, Undo2, Redo2 } from "lucide-react";
import { useStore } from "../store";

export default function TopBar() {
  const levels = useStore((s) => s.building.levels);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const planWidth = useStore((s) => s.planWidth);
  const setPlanWidth = useStore((s) => s.setPlanWidth);
  const importSvgText = useStore((s) => s.importSvgText);
  const importRasterFile = useStore((s) => s.importRasterFile);
  const exportGeoJSON = useStore((s) => s.exportGeoJSON);
  const exportIMDFArchive = useStore((s) => s.exportIMDFArchive);
  const exportSecurityReport = useStore((s) => s.exportSecurityReport);
  const loadGeoJSONText = useStore((s) => s.loadGeoJSONText);
  const resetBuilding = useStore((s) => s.resetBuilding);
  const importMsg = useStore((s) => s.importMsg);
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="wordmark">indoorMaps</div>
      <div className="histbtns">
        <button
          className="histbtn"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={!canUndo}
          onClick={undo}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="histbtn"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          disabled={!canRedo}
          onClick={redo}
        >
          <Redo2 size={15} />
        </button>
      </div>
      <div className="floorpills">
        {levels.map((lv) => (
          <button
            key={lv.ordinal}
            className={lv.ordinal === ordinal ? "active" : ""}
            onClick={() => setOrdinal(lv.ordinal)}
          >
            {lv.name}
          </button>
        ))}
      </div>
      <div className="datamenu">
        <button className="datamenu-trigger" onClick={() => setOpen((v) => !v)}>
          Data <ChevronDown size={14} />
        </button>
        {open && (
          <div className="datamenu-pop" onMouseLeave={() => setOpen(false)}>
            <div className="dm-row">
              <span>Plan width</span>
              <input
                type="number"
                className="numin"
                min={1}
                value={planWidth}
                onChange={(e) => setPlanWidth(Number(e.target.value))}
              />{" "}
              m
            </div>
            <label className="dm-item">
              Import SVG…
              <input
                type="file"
                accept=".svg,image/svg+xml"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) importSvgText(await f.text());
                }}
              />
            </label>
            <label className="dm-item">
              Import floorplan image…
              <input
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) await importRasterFile(f);
                }}
              />
            </label>
            <button className="dm-item" onClick={exportGeoJSON}>
              Export GeoJSON
            </button>
            <button className="dm-item" onClick={exportIMDFArchive}>
              Export IMDF archive…
            </button>
            <button className="dm-item" onClick={exportSecurityReport}>
              Export security report…
            </button>
            <label className="dm-item">
              Load GeoJSON…
              <input
                type="file"
                accept=".geojson,.json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) loadGeoJSONText(await f.text());
                }}
              />
            </label>
            <button className="dm-item danger" onClick={resetBuilding}>
              Reset building
            </button>
            {importMsg && <div className="dm-msg">{importMsg}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
