import { useStore } from "../../store";

export default function LinkPanel() {
  const building = useStore((s) => s.building);
  const linkKind = useStore((s) => s.linkKind);
  const setLinkKind = useStore((s) => s.setLinkKind);
  const pendingLink = useStore((s) => s.pendingLink);
  const deleteVertical = useStore((s) => s.deleteVertical);
  const name = (id: string) => building.units.find((u) => u.id === id)?.name ?? id;
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  return (
    <div className="panel">
      <div className="panel-title">Vertical links</div>
      <label>Kind</label>
      <select value={linkKind} onChange={(e) => setLinkKind(e.target.value)}>
        <option>Elevator</option>
        <option>Stairs</option>
        <option>Ramp</option>
        <option>Escalator</option>
      </select>
      <p className="hint">
        {pendingLink
          ? `Picked ${name(pendingLink.id)} on ${level(
              pendingLink.ordinal,
            )}. Switch floor and click its counterpart.`
          : "Click a unit, switch floor, then click the unit to connect it to."}
      </p>
      {building.verticals.length > 0 && (
        <div className="roomlist" style={{ marginTop: 8 }}>
          {building.verticals.map((v) => (
            <div className="roomrow" key={`${v.a}-${v.b}`}>
              <span className="vlabel">
                {name(v.a)} ⭥ {name(v.b)}
              </span>
              <button className="del" onClick={() => deleteVertical(v.a, v.b)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
