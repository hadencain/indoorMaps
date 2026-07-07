import { useStore } from "../../store";
import { useRoute } from "../route";
import { selectableUnits } from "../../building";

export default function RoutePanel() {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const routeMode = useStore((s) => s.routeMode);
  const setStart = useStore((s) => s.setStart);
  const setGoal = useStore((s) => s.setGoal);
  const setRouteMode = useStore((s) => s.setRouteMode);
  const { geom, exit } = useRoute();
  const rooms = selectableUnits(building);
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;
  const egress = routeMode === "egress";

  return (
    <div className="panel">
      <div className="panel-title">Wayfinding</div>
      <div className="modetoggle">
        <button className={egress ? "" : "active"} onClick={() => setRouteMode("direct")}>
          Direct
        </button>
        <button className={egress ? "active" : ""} onClick={() => setRouteMode("egress")}>
          Egress
        </button>
      </div>
      <label>From</label>
      <select value={startId} onChange={(e) => setStart(e.target.value)}>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
      </select>
      {!egress && (
        <>
          <label>To</label>
          <select value={goalId} onChange={(e) => setGoal(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {level(r.ordinal)}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="readout" style={{ marginTop: 12 }}>
        {geom ? (
          <>
            {egress && (
              <div>
                <span className="k">exit</span> {exit?.name ?? "—"}
              </div>
            )}
            <div>
              <span className="k">floors</span> {geom.floors.map(level).join(" → ") || "—"}
            </div>
            <div>
              <span className="k">{egress ? "nearest exit" : "walk"}</span> ~{geom.metres.toFixed(0)} m
              {geom.floors.length > 1 && " + elevator"}
            </div>
          </>
        ) : (
          <div className="warn">{egress ? "no exit reachable" : "no route found"}</div>
        )}
      </div>
    </div>
  );
}
