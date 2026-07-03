import { useMemo, useState } from "react";
import MapView from "./MapView";
import { building, selectableUnits } from "./building";
import { buildGraph } from "./graph";
import { findRoute } from "./astar";
import { routeToGeometry } from "./render";
import type { FC } from "./render";

export default function App() {
  const graph = useMemo(() => buildGraph(building), []);
  const rooms = useMemo(() => selectableUnits(building), []);

  const [ordinal, setOrdinal] = useState(0);
  const [startId, setStartId] = useState("lobby");
  const [goalId, setGoalId] = useState("lab");

  const route = useMemo(() => findRoute(graph, startId, goalId), [graph, startId, goalId]);
  const geom = useMemo(
    () => (route ? routeToGeometry(graph, route.path) : null),
    [graph, route],
  );

  const empty: FC = { type: "FeatureCollection", features: [] };

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>indoorMaps</h1>
        <p className="sub">viewer core · IMDF + MapLibre + A*</p>

        <section>
          <label>Floor</label>
          <div className="floors">
            {building.levels.map((lv) => (
              <button
                key={lv.ordinal}
                className={lv.ordinal === ordinal ? "active" : ""}
                onClick={() => setOrdinal(lv.ordinal)}
              >
                {lv.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label>From</label>
          <select value={startId} onChange={(e) => setStartId(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {levelName(r.ordinal)}
              </option>
            ))}
          </select>

          <label>To</label>
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {levelName(r.ordinal)}
              </option>
            ))}
          </select>
        </section>

        <section className="readout">
          {geom ? (
            <>
              <div>
                <span className="k">route</span> {roomName(startId)} → {roomName(goalId)}
              </div>
              <div>
                <span className="k">floors</span>{" "}
                {geom.floors.map(levelName).join(" → ") || "—"}
              </div>
              <div>
                <span className="k">walk</span> ~{geom.metres.toFixed(0)} m
                {geom.floors.length > 1 && " + elevator"}
              </div>
            </>
          ) : (
            <div className="warn">no route found</div>
          )}
          <p className="hint">
            Route legs draw only on the visible floor. Cross to the other floor to
            see the rest — the ↕ marks the elevator transition.
          </p>
        </section>
      </aside>

      <MapView
        building={building}
        ordinal={ordinal}
        routeLines={geom?.lines ?? empty}
        routePoints={geom?.points ?? []}
      />
    </div>
  );
}

function levelName(ordinal: number): string {
  return building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
}

function roomName(id: string): string {
  return building.units.find((u) => u.id === id)?.name ?? id;
}
