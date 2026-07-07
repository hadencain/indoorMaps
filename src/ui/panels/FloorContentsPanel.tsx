import { useStore } from "../../store";

export default function FloorContentsPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const renameUnit = useStore((s) => s.renameUnit);
  const deleteUnit = useStore((s) => s.deleteUnit);
  const rooms = building.units.filter((u) => u.category === "room" && u.ordinal === ordinal);

  return (
    <div className="panel">
      <div className="panel-title">Floor contents</div>
      {rooms.length === 0 && (
        <p className="hint">No rooms on this floor. Draw one with the ▢ or ⬡ tool.</p>
      )}
      <div className="roomlist">
        {rooms.map((r) => (
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
