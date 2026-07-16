import { useMemo, useState } from "react";
import { useStore } from "../../store";
import { bbox, polygonArea, polygonPerimeter } from "../../geo";
import { formatArea, formatLength } from "../../format";
import { CATEGORY_ORDER, CATEGORY_LABELS, isSpace } from "../../categories";
import { rankCamerasForUnitWithRings } from "../../security/coverage-link";
import { useVisibility } from "../visibility";
import { SECURITY_LEVELS, SECURITY_LABELS, SECURITY_COLORS, securityOf } from "../security";
import { occupantsForUnit, OCCUPANT_CATEGORY_LABELS } from "../../occupants";
import { selectableUnits } from "../../building";
import { fileToSmallDataUrl } from "../img";
import { doorAdjacency } from "../../interaction/health";
import type { Category, SecurityLevel, Occupant, OccupantCategory, Unit } from "../../types";

export default function PropertiesPanel() {
  const building = useStore((s) => s.building);
  const selectedId = useStore((s) => s.selectedId);
  const unit = useStore((s) => s.unit);
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const renameUnit = useStore((s) => s.renameUnit);
  const setCategory = useStore((s) => s.setCategory);
  const setSecurity = useStore((s) => s.setSecurity);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const addOccupant = useStore((s) => s.addOccupant);
  const addOpening = useStore((s) => s.addOpening);
  const deleteOpening = useStore((s) => s.deleteOpening);
  const toggleOpeningKind = useStore((s) => s.toggleOpeningKind);
  const { polys } = useVisibility();
  const [expandedOcc, setExpandedOcc] = useState<string | null>(null);
  // Cameras that see this unit, ranked by view quality (best first). Built from
  // the SHARED active-floor visibility (useVisibility's per-camera cache) so it
  // never re-runs the full-floor ray-cast on a rename keystroke, and it recomputes
  // whenever coverage changes. Skipped for circulation / exterior.
  const seenBy = useMemo(() => {
    const u = building.units.find((x) => x.id === selectedId);
    if (!u || u.category === "outside" || u.category === "corridor") return [];
    const ringById = new Map(polys.map((p) => [p.cameraId, p.ring]));
    const cams = building.cameras.filter((c) => c.ordinal === u.ordinal);
    return rankCamerasForUnitWithRings(u, cams, ringById);
  }, [polys, selectedId, building.units, building.cameras]);
  const u = building.units.find((x) => x.id === selectedId);
  if (!u)
    return (
      <div className="panel">
        <p className="hint">Select a unit to edit its properties.</p>
      </div>
    );
  const [x0, y0, x1, y1] = bbox(u.polygon);
  const occs = occupantsForUnit(building, u.id);
  const unitOpenings = building.openings.filter((o) => o.unit === u.id);

  return (
    <div className="panel">
      <div className="panel-title">Properties</div>
      <label>Name</label>
      <input value={u.name} onChange={(e) => renameUnit(u.id, e.target.value)} />
      <label>Category</label>
      <select value={u.category} onChange={(e) => setCategory(u.id, e.target.value as Category)}>
        {CATEGORY_ORDER.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <label>Security</label>
      <select
        className="sec-selector"
        style={{ borderColor: SECURITY_COLORS[securityOf(u)] }}
        value={securityOf(u)}
        onChange={(e) => setSecurity(u.id, e.target.value as SecurityLevel)}
      >
        {SECURITY_LEVELS.map((lvl) => (
          <option key={lvl} value={lvl}>
            {SECURITY_LABELS[lvl]}
          </option>
        ))}
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        <div>
          <span className="k">area</span> {formatArea(polygonArea(u.polygon), unit)}
        </div>
        <div>
          <span className="k">size</span> {formatLength(x1 - x0, unit)} ×{" "}
          {formatLength(y1 - y0, unit)}
        </div>
        <div>
          <span className="k">perim</span> {formatLength(polygonPerimeter(u.polygon), unit)}
        </div>
      </div>
      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Seen by
      </div>
      {seenBy.length === 0 ? (
        <p className="hint">No camera coverage.</p>
      ) : (
        <div className="roomlist">
          {seenBy.map((c) => (
            <div className="roomrow" key={c.cameraId}>
              <button
                className="camrow-select"
                onClick={() => setSelectedCamera(c.cameraId)}
                title={`Select camera · view quality ${Math.round(c.score * 100)}%`}
              >
                <span className="vlabel">{c.name}</span>
                <span className="camrow-kind">{Math.round(c.score * 100)}%</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {isSpace(u.category) && (
        <>
          <div className="panel-subtitle" style={{ marginTop: 12 }}>
            Doors
          </div>
          {unitOpenings.length === 0 && <p className="hint">No doors — routing can't reach this unit.</p>}
          <div className="roomlist">
            {unitOpenings.map((op) => {
              const adj = doorAdjacency(building.units, op);
              const other = adj.other ? building.units.find((x) => x.id === adj.other) : undefined;
              const isEntrance = op.kind === "entrance";
              return (
                <div className="roomrow" key={op.id}>
                  <button
                    className="occ-head"
                    title="Toggle door / entrance"
                    onClick={() => toggleOpeningKind(op.id)}
                  >
                    <span className="vlabel">{isEntrance ? "Entrance" : "Door"}</span>
                    <span className="occ-cat">
                      {isEntrance ? "to outside" : other ? `↔ ${other.name}` : "unmapped side"}
                    </span>
                  </button>
                  <button className="del" title="Delete door" onClick={() => deleteOpening(op.id)}>
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <button className="wide ghost" style={{ marginTop: 6 }} onClick={() => addOpening(u.id)}>
            + Add door
          </button>
        </>
      )}

      {isSpace(u.category) && (
        <>
          <div className="panel-subtitle" style={{ marginTop: 12 }}>
            Occupants
          </div>
          {occs.length === 0 && <p className="hint">Vacant.</p>}
          <div className="roomlist">
            {occs.map((o) => (
              <OccupantRow key={o.id} occ={o} unit={u} expanded={expandedOcc === o.id}
                onToggle={() => setExpandedOcc(expandedOcc === o.id ? null : o.id)} />
            ))}
          </div>
          <button className="wide ghost" style={{ marginTop: 6 }} onClick={() => addOccupant(u.id)}>
            + Add occupant
          </button>
        </>
      )}

      <button
        className={`wide ${activeTool === "vertex" ? "active" : ""}`}
        style={{ marginTop: 8 }}
        onClick={() => setTool(activeTool === "vertex" ? "select" : "vertex")}
      >
        {activeTool === "vertex" ? "◼ Editing vertices" : "✎ Edit vertices"}
      </button>
      <button className="wide danger" style={{ marginTop: 8 }} onClick={() => deleteUnit(u.id)}>
        Delete unit
      </button>
    </div>
  );
}

function OccupantRow({
  occ,
  unit,
  expanded,
  onToggle,
}: {
  occ: Occupant;
  unit: Unit;
  expanded: boolean;
  onToggle: () => void;
}) {
  const building = useStore((s) => s.building);
  const updateOccupant = useStore((s) => s.updateOccupant);
  const deleteOccupant = useStore((s) => s.deleteOccupant);
  const moveOccupant = useStore((s) => s.moveOccupant);
  const setOccupantAnchor = useStore((s) => s.setOccupantAnchor);
  // Same-floor tenant-swap targets; exclude the current unit (no-op move).
  const moveTargets = selectableUnits(building).filter(
    (r) => r.ordinal === unit.ordinal && r.id !== unit.id,
  );
  return (
    <div className={`occrow ${expanded ? "open" : ""}`}>
      <div className="roomrow">
        <button className="occ-head" onClick={onToggle} title={expanded ? "Collapse" : "Edit occupant"}>
          {occ.logo && <img className="occ-logo-mini" src={occ.logo} alt="" />}
          <span className="vlabel">{occ.name || "(unnamed)"}</span>
          <span className="occ-cat">{OCCUPANT_CATEGORY_LABELS[occ.category]}</span>
        </button>
        <button className="del" title="Delete occupant" onClick={() => deleteOccupant(occ.id)}>
          ✕
        </button>
      </div>
      {expanded && (
        <div className="occ-editor">
          <label>Name</label>
          <input value={occ.name} onChange={(e) => updateOccupant(occ.id, { name: e.target.value })} />
          <label>Category</label>
          <select
            value={occ.category}
            onChange={(e) => updateOccupant(occ.id, { category: e.target.value as OccupantCategory })}
          >
            {(Object.keys(OCCUPANT_CATEGORY_LABELS) as OccupantCategory[]).map((c) => (
              <option key={c} value={c}>
                {OCCUPANT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <label>Hours</label>
          <input
            placeholder="Mon–Sat 10–9"
            value={occ.hours ?? ""}
            onChange={(e) => updateOccupant(occ.id, { hours: e.target.value || undefined })}
          />
          <label>Phone</label>
          <input value={occ.phone ?? ""} onChange={(e) => updateOccupant(occ.id, { phone: e.target.value || undefined })} />
          <label>Website</label>
          <input value={occ.website ?? ""} onChange={(e) => updateOccupant(occ.id, { website: e.target.value || undefined })} />
          <label>Logo</label>
          {occ.logo ? (
            <div className="occ-logo-row">
              <img className="occ-logo" src={occ.logo} alt={`${occ.name} logo`} />
              <button className="del" title="Remove logo" onClick={() => updateOccupant(occ.id, { logo: undefined })}>
                ✕
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const logo = await fileToSmallDataUrl(f, 320);
                  updateOccupant(occ.id, { logo });
                } catch {
                  /* unreadable image — leave logo unset */
                }
                e.target.value = "";
              }}
            />
          )}
          <label>Move to unit</label>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) moveOccupant(occ.id, e.target.value);
            }}
          >
            <option value="">(same floor…)</option>
            {moveTargets.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="wide ghost" style={{ marginTop: 6 }} onClick={() => setOccupantAnchor(occ.id, null)}>
            Reset label anchor to centroid
          </button>
        </div>
      )}
    </div>
  );
}
