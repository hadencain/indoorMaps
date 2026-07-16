import { useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { useStore } from "../../store";
import { isSpace } from "../../categories";
import { occupantNamesByUnit, OCCUPANT_CATEGORY_LABELS } from "../../occupants";
import { polygonCentroid } from "../../geo";
import { fileToSmallDataUrl } from "../img";
import type { OccupantCategory } from "../../types";
import SearchBox from "../SearchBox";

export default function FloorContentsPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedIds = useStore((s) => s.selectedIds);
  const searchQuery = useStore((s) => s.searchQuery);
  const setSelected = useStore((s) => s.setSelected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const renameUnit = useStore((s) => s.renameUnit);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const setUnderlayWidth = useStore((s) => s.setUnderlayWidth);
  const setUnderlayOpacity = useStore((s) => s.setUnderlayOpacity);
  const nudgeUnderlay = useStore((s) => s.nudgeUnderlay);
  const removeUnderlay = useStore((s) => s.removeUnderlay);
  const setVectorUnderlayOpacity = useStore((s) => s.setVectorUnderlayOpacity);
  const removeVectorUnderlay = useStore((s) => s.removeVectorUnderlay);
  const requestFly = useStore((s) => s.requestFly);
  const updateSiteInfo = useStore((s) => s.updateSiteInfo);
  const [view, setView] = useState<"rooms" | "tenants">("rooms");
  const [hoursDraft, setHoursDraft] = useState<string | null>(null);
  const si = { photos: [], hours: "", ...building.siteInfo };
  const q = searchQuery.trim().toLowerCase();
  const occNames = occupantNamesByUnit(building);
  const spaces = building.units.filter(
    (u) =>
      u.ordinal === ordinal &&
      isSpace(u.category) &&
      (q === "" ||
        u.name.toLowerCase().includes(q) ||
        u.category.toLowerCase().includes(q) ||
        (occNames.get(u.id) ?? "").toLowerCase().includes(q)),
  );
  const underlay = (building.underlays ?? []).find((u) => u.ordinal === ordinal);
  const vectorUnderlay = (building.vectorUnderlays ?? []).find((v) => v.ordinal === ordinal);
  const NUDGE = 1; // metres per nudge step

  const addPhoto = async (file: File) => {
    try {
      const dataUrl = await fileToSmallDataUrl(file);
      updateSiteInfo({ photos: [...si.photos, dataUrl] });
    } catch {
      /* unreadable image — ignore */
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">Floor contents</div>
      <SearchBox />
      <div className="modetoggle" role="group" aria-label="Floor contents view" style={{ marginBottom: 8 }}>
        <button className={view === "rooms" ? "active" : ""} onClick={() => setView("rooms")}>
          Rooms
        </button>
        <button className={view === "tenants" ? "active" : ""} onClick={() => setView("tenants")}>
          Tenants
        </button>
      </div>
      {view === "rooms" && (
        <>
          {spaces.length === 0 && (
            <p className="hint">
              {q === ""
                ? "No spaces on this floor. Draw one with the ▢ or ⬡ tool."
                : "No spaces match your search."}
            </p>
          )}
          <div className="roomlist">
            {spaces.map((r) => (
              <div
                className={`roomrow ${selectedIds.includes(r.id) ? "selected" : ""}`}
                key={r.id}
              >
                <input
                  value={r.name}
                  // Shift-click adds/removes the row from the multi-selection; the
                  // preventDefault stops the input focusing (which would otherwise
                  // fire onFocus → single-select and undo the toggle).
                  onMouseDown={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault();
                      toggleSelected(r.id);
                    }
                  }}
                  onFocus={() => setSelected(r.id)}
                  onChange={(e) => renameUnit(r.id, e.target.value)}
                />
                <button className="del" title="Delete" onClick={() => deleteUnit(r.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {view === "tenants" && (() => {
        const floorUnitById = new Map(
          building.units.filter((u) => u.ordinal === ordinal).map((u) => [u.id, u]),
        );
        const occs = (building.occupants ?? []).filter(
          (o) => floorUnitById.has(o.unitId) && (q === "" || o.name.toLowerCase().includes(q)),
        );
        const occupiedUnitIds = new Set((building.occupants ?? []).map((o) => o.unitId));
        const vacant = [...floorUnitById.values()].filter(
          (u) => isSpace(u.category) && u.category !== "outside" && !occupiedUnitIds.has(u.id) &&
            (q === "" || u.name.toLowerCase().includes(q)),
        );
        const go = (unitId: string) => {
          const u = floorUnitById.get(unitId);
          if (!u) return;
          setSelected(unitId);
          requestFly(polygonCentroid(u.polygon), ordinal);
        };
        return (
          <>
            {(Object.keys(OCCUPANT_CATEGORY_LABELS) as OccupantCategory[]).map((cat) => {
              const group = occs.filter((o) => o.category === cat);
              if (group.length === 0) return null;
              return (
                <div key={cat}>
                  <div className="panel-subtitle" style={{ marginTop: 10 }}>
                    {OCCUPANT_CATEGORY_LABELS[cat]}
                  </div>
                  <div className="roomlist">
                    {group.map((o) => (
                      <div className="roomrow" key={o.id}>
                        <button className="occ-head" onClick={() => go(o.unitId)} title="Show on map">
                          <span className="vlabel">{o.name}</span>
                          <span className="occ-cat">{floorUnitById.get(o.unitId)?.name}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {occs.length === 0 && <p className="hint">No tenants on this floor{q ? " match the search" : ""}.</p>}
            {vacant.length > 0 && (
              <>
                <div className="panel-subtitle" style={{ marginTop: 10 }}>
                  Vacant
                </div>
                <div className="roomlist">
                  {vacant.map((u) => (
                    <div className="roomrow" key={u.id}>
                      <button className="occ-head" onClick={() => go(u.id)} title="Show on map">
                        <span className="vlabel">{u.name}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        );
      })()}

      <div className="panel-subtitle" style={{ marginTop: 12 }}>
        Site info
      </div>
      <div className="panel-photos">
        {si.photos.map((p, i) => (
          <div className="panel-photo" key={i}>
            <img src={p} alt={`site photo ${i + 1}`} />
            <button
              className="panel-photo-del"
              title="Remove photo"
              onClick={() => updateSiteInfo({ photos: si.photos.filter((_, j) => j !== i) })}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <label className="panel-photo add" title="Add a location photo">
          <ImagePlus size={16} />
          <input
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void addPhoto(f);
            }}
          />
        </label>
      </div>
      <label>Hours</label>
      <textarea
        placeholder={"Mon–Thu 10:00–02:00\nFri–Sun 24h"}
        value={hoursDraft ?? si.hours}
        onChange={(e) => setHoursDraft(e.target.value)}
        onBlur={() => {
          if (hoursDraft !== null && hoursDraft !== si.hours) updateSiteInfo({ hours: hoursDraft });
          setHoursDraft(null);
        }}
        rows={3}
      />

      {underlay && (
        <div className="underlay-sec">
          <div className="panel-title">Floorplan underlay</div>
          {underlay.dataUrl === "" && (
            <p className="warn">image not saved — re-import after reload</p>
          )}
          <label>Width (m)</label>
          <input
            type="number"
            min={1}
            value={underlay.widthM}
            onChange={(e) => setUnderlayWidth(ordinal, Number(e.target.value))}
          />
          <label>Opacity</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={underlay.opacity}
            onChange={(e) => setUnderlayOpacity(ordinal, Number(e.target.value))}
          />
          <label>Position</label>
          <div className="nudge-pad">
            <span />
            <button onClick={() => nudgeUnderlay(ordinal, [0, NUDGE])}>N</button>
            <span />
            <button onClick={() => nudgeUnderlay(ordinal, [-NUDGE, 0])}>W</button>
            <span />
            <button onClick={() => nudgeUnderlay(ordinal, [NUDGE, 0])}>E</button>
            <span />
            <button onClick={() => nudgeUnderlay(ordinal, [0, -NUDGE])}>S</button>
            <span />
          </div>
          <button className="wide ghost danger" onClick={() => removeUnderlay(ordinal)}>
            Remove underlay
          </button>
        </div>
      )}

      {vectorUnderlay && (
        <div className="underlay-sec">
          <div className="panel-title">CAD linework</div>
          <label>Opacity</label>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={vectorUnderlay.opacity}
            onChange={(e) => setVectorUnderlayOpacity(ordinal, Number(e.target.value))}
          />
          <button className="wide ghost danger" onClick={() => removeVectorUnderlay(ordinal)}>
            Remove CAD linework
          </button>
        </div>
      )}
    </div>
  );
}
