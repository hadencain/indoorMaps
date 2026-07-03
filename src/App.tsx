import { useEffect, useMemo, useState } from "react";
import MapView from "./MapView";
import { initialBuilding, selectableUnits, doorForRoom } from "./building";
import { buildGraph } from "./graph";
import { findRoute } from "./astar";
import { routeToGeometry } from "./render";
import type { FC } from "./render";
import type { Building } from "./types";

const STORAGE_KEY = "indoormaps:building:v1";

function loadBuilding(): Building {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const b = JSON.parse(raw) as Building;
      if (Array.isArray(b.units) && Array.isArray(b.levels)) return b;
    }
  } catch {
    /* fall through to the seed */
  }
  return initialBuilding;
}

let roomSeq = 0;

export default function App() {
  const [building, setBuilding] = useState<Building>(loadBuilding);
  const [ordinal, setOrdinal] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [startId, setStartId] = useState("lobby");
  const [goalId, setGoalId] = useState("lab");

  const graph = useMemo(() => buildGraph(building), [building]);
  const rooms = useMemo(() => selectableUnits(building), [building]);

  // Persist edits.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(building));
    } catch {
      /* storage full / unavailable — non-fatal for a local spike */
    }
  }, [building]);

  // Keep start/goal valid as rooms come and go.
  useEffect(() => {
    if (rooms.length === 0) return;
    if (!rooms.some((r) => r.id === startId)) setStartId(rooms[0].id);
    if (!rooms.some((r) => r.id === goalId)) setGoalId(rooms[rooms.length - 1].id);
  }, [rooms, startId, goalId]);

  const route = useMemo(() => findRoute(graph, startId, goalId), [graph, startId, goalId]);
  const geom = useMemo(
    () => (route ? routeToGeometry(graph, route.path) : null),
    [graph, route],
  );
  const empty: FC = { type: "FeatureCollection", features: [] };

  function addRoom(rect: [number, number, number, number], ord: number) {
    setBuilding((prev) => {
      const id = `room-${Date.now()}-${roomSeq++}`;
      const name = `Room ${prev.units.filter((u) => u.category === "room").length + 1}`;
      const door = doorForRoom(prev, rect, ord);
      return {
        ...prev,
        units: [...prev.units, { id, ordinal: ord, name, category: "room", rect }],
        openings: door ? [...prev.openings, { unit: id, at: door }] : prev.openings,
      };
    });
  }

  function renameRoom(id: string, name: string) {
    setBuilding((prev) => ({
      ...prev,
      units: prev.units.map((u) => (u.id === id ? { ...u, name } : u)),
    }));
  }

  function resetBuilding() {
    setBuilding(initialBuilding);
    setStartId("lobby");
    setGoalId("lab");
  }

  const roomsOnFloor = rooms.filter((r) => r.ordinal === ordinal);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>indoorMaps</h1>
        <p className="sub">authoring + wayfinding · IMDF + MapLibre + A*</p>

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
          <label>Edit</label>
          <button
            className={`wide ${editMode ? "active" : ""}`}
            onClick={() => setEditMode((v) => !v)}
          >
            {editMode ? "◼ Drawing rooms — click to stop" : "✎ Draw a room"}
          </button>
          {editMode && (
            <p className="hint">
              Drag a rectangle on <b>{levelName(ordinal)}</b> to add a room. A door
              auto-connects it to the corridor, and it becomes routable immediately.
            </p>
          )}
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
                <span className="k">route</span> {roomName(building, startId)} →{" "}
                {roomName(building, goalId)}
              </div>
              <div>
                <span className="k">floors</span>{" "}
                {geom.floors.map((o) => levelName(o)).join(" → ") || "—"}
              </div>
              <div>
                <span className="k">walk</span> ~{geom.metres.toFixed(0)} m
                {geom.floors.length > 1 && " + elevator"}
              </div>
            </>
          ) : (
            <div className="warn">no route found</div>
          )}
        </section>

        {roomsOnFloor.length > 0 && (
          <section>
            <label>Rooms on {levelName(ordinal)}</label>
            <div className="roomlist">
              {roomsOnFloor.map((r) => (
                <input
                  key={r.id}
                  value={r.name}
                  onChange={(e) => renameRoom(r.id, e.target.value)}
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <button className="wide ghost" onClick={resetBuilding}>
            Reset building
          </button>
        </section>
      </aside>

      <MapView
        building={building}
        ordinal={ordinal}
        editMode={editMode}
        routeLines={geom?.lines ?? empty}
        routePoints={geom?.points ?? []}
        onAddRoom={addRoom}
      />
    </div>
  );

  function levelName(o: number): string {
    return building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;
  }
}

function roomName(building: Building, id: string): string {
  return building.units.find((u) => u.id === id)?.name ?? id;
}
