import { useStore } from "../../store";
import { isSpace } from "../../categories";

export default function FloorContentsPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const renameUnit = useStore((s) => s.renameUnit);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const spaces = building.units.filter((u) => u.ordinal === ordinal && isSpace(u.category));

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
    </div>
  );
}
