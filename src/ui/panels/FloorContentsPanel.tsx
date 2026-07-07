import { useStore } from "../../store";
import { isSpace } from "../../categories";

export default function FloorContentsPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const renameUnit = useStore((s) => s.renameUnit);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const setUnderlayWidth = useStore((s) => s.setUnderlayWidth);
  const setUnderlayOpacity = useStore((s) => s.setUnderlayOpacity);
  const nudgeUnderlay = useStore((s) => s.nudgeUnderlay);
  const removeUnderlay = useStore((s) => s.removeUnderlay);
  const spaces = building.units.filter((u) => u.ordinal === ordinal && isSpace(u.category));
  const underlay = (building.underlays ?? []).find((u) => u.ordinal === ordinal);
  const NUDGE = 1; // metres per nudge step

  return (
    <div className="panel">
      <div className="panel-title">Floor contents</div>
      {spaces.length === 0 && (
        <p className="hint">No spaces on this floor. Draw one with the ▢ or ⬡ tool.</p>
      )}
      <div className="roomlist">
        {spaces.map((r) => (
          <div className={`roomrow ${r.id === selectedId ? "selected" : ""}`} key={r.id}>
            <input
              value={r.name}
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
