import { useStore } from "../../store";
import { isSpace } from "../../categories";
import { occupantNamesByUnit } from "../../occupants";
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
  const NUDGE = 1; // metres per nudge step

  return (
    <div className="panel">
      <div className="panel-title">Floor contents</div>
      <SearchBox />
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
    </div>
  );
}
