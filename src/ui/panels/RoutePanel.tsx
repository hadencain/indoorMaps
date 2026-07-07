import { useStore } from "../../store";
import { useRoute } from "../route";
import { selectableUnits } from "../../building";

export default function RoutePanel() {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const { geom } = useRoute();
  const rooms = selectableUnits(building);
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  return (
    <div className="panel">
      <div className="panel-title">Wayfinding</div>
      <label>From</label>
      <select value={startId} onChange={(e) => setStart(e.target.value)}>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
      </select>
      <label>To</label>
      <select value={goalId} onChange={(e) => setGoal(e.target.value)}>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        {geom ? (
          <>
            <div>
              <span className="k">floors</span> {geom.floors.map(level).join(" → ") || "—"}
            </div>
            <div>
              <span className="k">walk</span> ~{geom.metres.toFixed(0)} m
              {geom.floors.length > 1 && " + elevator"}
            </div>
          </>
        ) : (
          <div className="warn">no route found</div>
        )}
      </div>
    </div>
  );
}
