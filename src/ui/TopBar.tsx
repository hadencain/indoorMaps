import { useState } from "react";
import { ChevronDown, Undo2, Redo2, Pencil, MonitorPlay, LayoutGrid, Plus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { DEMOS } from "../demos";
import { propertyNameFor } from "../properties";
import NewPropertyWizard from "./NewPropertyWizard";
import DxfImportDialog from "./DxfImportDialog";
import CsvImportDialog from "./CsvImportDialog";
import { parseDxfText, type DxfParseResult } from "../dxf";
import { parseCameraCsv, type CameraCsvResult } from "../camera-csv";

export default function TopBar() {
  const levels = useStore((s) => s.building.levels);
  const propertyId = useStore((s) => s.propertyId);
  const setProperty = useStore((s) => s.setProperty);
  const userProperties = useStore((s) => s.userProperties);
  const deleteProperty = useStore((s) => s.deleteProperty);
  const [propOpen, setPropOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dxfDialog, setDxfDialog] = useState<{ raw: string; initial: DxfParseResult } | null>(null);
  const [csvDialog, setCsvDialog] = useState<CameraCsvResult | null>(null);
  // Two-step delete: first click arms, second click deletes (no blocking confirm()).
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const addLevel = useStore((s) => s.addLevel);
  const reopenGuide = useStore((s) => s.reopenGuide);
  const planWidth = useStore((s) => s.planWidth);
  const setPlanWidth = useStore((s) => s.setPlanWidth);
  const importSvgText = useStore((s) => s.importSvgText);
  const importRasterFile = useStore((s) => s.importRasterFile);
  const exportGeoJSON = useStore((s) => s.exportGeoJSON);
  const exportIMDFArchive = useStore((s) => s.exportIMDFArchive);
  const exportSecurityReport = useStore((s) => s.exportSecurityReport);
  const exportCameraIndex = useStore((s) => s.exportCameraIndex);
  const loadGeoJSONText = useStore((s) => s.loadGeoJSONText);
  const exportBuildingFile = useStore((s) => s.exportBuildingFile);
  const exportViewer = useStore((s) => s.exportViewer);
  const importBuildingFileText = useStore((s) => s.importBuildingFileText);
  const resetBuilding = useStore((s) => s.resetBuilding);
  const importMsg = useStore((s) => s.importMsg);
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="wordmark">indoorMaps</div>
      <div className="prop-picker">
        <button className="datamenu-trigger" onClick={() => setPropOpen((v) => !v)}>
          {propertyNameFor(propertyId, userProperties)} <ChevronDown size={14} />
        </button>
        {propOpen && (
          <div
            className="datamenu-pop"
            onMouseLeave={() => {
              setPropOpen(false);
              setArmedDelete(null);
            }}
          >
            {DEMOS.map((d) => (
              <button
                key={d.id}
                className={`dm-item ${d.id === propertyId ? "on" : ""}`}
                onClick={() => {
                  setProperty(d.id);
                  setPropOpen(false);
                }}
              >
                {d.name}
              </button>
            ))}
            {userProperties.length > 0 && <div className="dm-sep" />}
            {userProperties.map((p) => (
              <div key={p.id} className="dm-item-row">
                <button
                  className={`dm-item grow ${p.id === propertyId ? "on" : ""}`}
                  onClick={() => {
                    setProperty(p.id);
                    setPropOpen(false);
                  }}
                >
                  {p.name}
                </button>
                <button
                  className={`dm-del ${armedDelete === p.id ? "armed" : ""}`}
                  title={armedDelete === p.id ? "Click again to delete permanently" : `Delete ${p.name}`}
                  onClick={() => {
                    if (armedDelete === p.id) {
                      deleteProperty(p.id);
                      setArmedDelete(null);
                    } else {
                      setArmedDelete(p.id);
                    }
                  }}
                >
                  {armedDelete === p.id ? "sure?" : <Trash2 size={12} />}
                </button>
              </div>
            ))}
            <div className="dm-sep" />
            <button
              className="dm-item"
              onClick={() => {
                setPropOpen(false);
                setWizardOpen(true);
              }}
            >
              <Plus size={12} /> New property from image…
            </button>
          </div>
        )}
      </div>
      {wizardOpen && <NewPropertyWizard onClose={() => setWizardOpen(false)} />}
      {dxfDialog && (
        <DxfImportDialog
          raw={dxfDialog.raw}
          initial={dxfDialog.initial}
          onClose={() => setDxfDialog(null)}
        />
      )}
      {csvDialog && <CsvImportDialog result={csvDialog} onClose={() => setCsvDialog(null)} />}
      <div className="modetoggle" role="group" aria-label="Mode">
        <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} title="Authoring — draw & edit the map">
          <Pencil size={13} /> Edit
        </button>
        <button className={mode === "display" ? "active" : ""} onClick={() => setMode("display")} title="Display — read-only map, click-to-camera">
          <MonitorPlay size={13} /> Display
        </button>
        <button className={mode === "operator" ? "active" : ""} onClick={() => setMode("operator")} title="Operator — feed wall first, plan as index">
          <LayoutGrid size={13} /> Operator
        </button>
      </div>
      {mode === "edit" && (
        <div className="histbtns">
          <button className="histbtn" title="Undo (Ctrl/Cmd+Z)" disabled={!canUndo} onClick={undo}>
            <Undo2 size={15} />
          </button>
          <button className="histbtn" title="Redo (Ctrl/Cmd+Shift+Z)" disabled={!canRedo} onClick={redo}>
            <Redo2 size={15} />
          </button>
        </div>
      )}
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
        {mode === "edit" && (
          <button className="floorpill-add" title="Add a floor" onClick={addLevel}>
            +
          </button>
        )}
      </div>
      <div className="datamenu">
        <button className="datamenu-trigger" onClick={() => setOpen((v) => !v)}>
          Data <ChevronDown size={14} />
        </button>
        {open && (
          <div className="datamenu-pop" onMouseLeave={() => setOpen(false)}>
            {mode === "edit" && (
              <>
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
                <label className="dm-item">
                  Import camera schedule (CSV)…
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const r = parseCameraCsv(await f.text());
                      if (!r.ok) {
                        useStore.setState({ importMsg: `Schedule import failed: ${r.error}` });
                      } else {
                        setOpen(false);
                        setCsvDialog(r.result);
                      }
                    }}
                  />
                </label>
                <label className="dm-item">
                  Import DXF (CAD)…
                  <input
                    type="file"
                    accept=".dxf"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const text = await f.text();
                      const r = parseDxfText(text);
                      if (!r.ok) {
                        useStore.setState({ importMsg: `DXF import failed: ${r.error}` });
                      } else {
                        setOpen(false);
                        setDxfDialog({ raw: text, initial: r.result });
                      }
                    }}
                  />
                </label>
                {userProperties.some((u) => u.id === propertyId) && (
                  <button
                    className="dm-item"
                    onClick={() => {
                      reopenGuide(propertyId);
                      setOpen(false);
                    }}
                  >
                    Setup guide
                  </button>
                )}
              </>
            )}
            <button className="dm-item" onClick={exportBuildingFile}>
              Save building file (JSON)…
            </button>
            <button className="dm-item" onClick={exportViewer}>
              Export shareable viewer (.html)…
            </button>
            <button className="dm-item" onClick={exportGeoJSON}>
              Export GeoJSON
            </button>
            <button className="dm-item" onClick={exportIMDFArchive}>
              Export IMDF archive…
            </button>
            <button className="dm-item" onClick={exportSecurityReport}>
              Export security report…
            </button>
            <button className="dm-item" onClick={exportCameraIndex}>
              Export camera index (JSON)…
            </button>
            {mode === "edit" && (
              <>
                <label className="dm-item">
                  Load building file…
                  <input
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) importBuildingFileText(await f.text());
                    }}
                  />
                </label>
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
              </>
            )}
            {importMsg && <div className="dm-msg">{importMsg}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
