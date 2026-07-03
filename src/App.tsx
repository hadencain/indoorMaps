import { useEffect, useMemo, useState } from "react";
import MapView from "./MapView";
import type { DrawTool } from "./MapView";
import { initialBuilding, selectableUnits, doorForRoom } from "./building";
import { buildGraph } from "./graph";
import { findRoute } from "./astar";
import { routeToGeometry } from "./render";
import type { FC } from "./render";
import type { Building, MetreXY, Category } from "./types";
import { bbox, polygonArea, polygonPerimeter } from "./geo";
import { formatLength, formatArea } from "./format";
import type { Unit } from "./format";
import { parseSvgShapes } from "./svgImport";

// v3: openings carry a stable `id` (for door dragging). Older data is ignored.
const STORAGE_KEY = "indoormaps:building:v3";

function loadBuilding(): Building {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const b = JSON.parse(raw) as Building;
      const shapeOk =
        Array.isArray(b.units) &&
        Array.isArray(b.levels) &&
        Array.isArray(b.openings) &&
        b.units.every((u) => Array.isArray(u.polygon)) &&
        b.openings.every((o) => typeof o.id === "string");
      if (shapeOk) return b;
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
  const [drawTool, setDrawTool] = useState<DrawTool>("none");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>("m");
  const [showDims, setShowDims] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [gridSize, setGridSize] = useState(1);
  const [linkMode, setLinkMode] = useState(false);
  const [pendingLink, setPendingLink] = useState<{ id: string; ordinal: number } | null>(null);
  const [planWidth, setPlanWidth] = useState(40);
  const [importMsg, setImportMsg] = useState<string | null>(null);
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

  // Delete / Backspace removes the selected room (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (selectedId && building.units.some((u) => u.id === selectedId && u.category === "room")) {
        deleteRoom(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, building]);

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

  function addRoom(polygon: MetreXY[], ord: number) {
    setBuilding((prev) => {
      const id = `room-${Date.now()}-${roomSeq++}`;
      const name = `Room ${prev.units.filter((u) => u.category === "room").length + 1}`;
      const door = doorForRoom(prev, polygon, ord);
      return {
        ...prev,
        units: [...prev.units, { id, ordinal: ord, name, category: "room", polygon }],
        openings: door
          ? [...prev.openings, { id: `d-${id}`, unit: id, at: door }]
          : prev.openings,
      };
    });
  }

  function moveDoor(doorId: string, at: MetreXY) {
    setBuilding((prev) => ({
      ...prev,
      openings: prev.openings.map((o) => (o.id === doorId ? { ...o, at } : o)),
    }));
  }

  // Draw tools and link mode are mutually exclusive interaction modes.
  function pickDrawTool(t: DrawTool) {
    setDrawTool((cur) => (cur === t ? "none" : t));
    setLinkMode(false);
    setPendingLink(null);
  }
  function toggleLinkMode() {
    setLinkMode((v) => {
      if (!v) setDrawTool("none");
      setPendingLink(null);
      return !v;
    });
  }

  // Vertical connections: click a unit on one floor, then a unit on another.
  function onLinkUnit(id: string) {
    const u = building.units.find((x) => x.id === id);
    if (!u) return;
    setSelectedId(id);
    if (!pendingLink) {
      setPendingLink({ id, ordinal: u.ordinal });
      return;
    }
    if (pendingLink.id === id || pendingLink.ordinal === u.ordinal) {
      setPendingLink({ id, ordinal: u.ordinal }); // same floor / same unit -> re-pick
      return;
    }
    const a = pendingLink.id;
    const b = id;
    setBuilding((prev) => {
      const exists = prev.verticals.some(
        (v) => (v.a === a && v.b === b) || (v.a === b && v.b === a),
      );
      if (exists) return prev;
      return { ...prev, verticals: [...prev.verticals, { a, b, name: "Vertical" }] };
    });
    setPendingLink(null);
  }

  function deleteVertical(a: string, b: string) {
    setBuilding((prev) => ({
      ...prev,
      verticals: prev.verticals.filter((v) => !(v.a === a && v.b === b)),
    }));
  }

  function renameRoom(id: string, name: string) {
    setBuilding((prev) => ({
      ...prev,
      units: prev.units.map((u) => (u.id === id ? { ...u, name } : u)),
    }));
  }

  function setUnitCategory(id: string, category: Category) {
    setBuilding((prev) => ({
      ...prev,
      units: prev.units.map((u) => (u.id === id ? { ...u, category } : u)),
    }));
  }

  function deleteRoom(id: string) {
    setBuilding((prev) => ({
      ...prev,
      units: prev.units.filter((u) => u.id !== id),
      openings: prev.openings.filter((o) => o.unit !== id),
      verticals: prev.verticals.filter((v) => v.a !== id && v.b !== id),
    }));
    setSelectedId((s) => (s === id ? null : s));
  }

  function resetBuilding() {
    setBuilding(initialBuilding);
    setStartId("lobby");
    setGoalId("lab");
    setImportMsg(null);
  }

  function importSvg(text: string) {
    const shapes = parseSvgShapes(text);
    if (shapes.length === 0) {
      setImportMsg("No rect/polygon/path shapes found in that SVG.");
      return;
    }
    // Overall bounds in SVG space, to scale the plan to `planWidth` metres.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of shapes) {
      for (const [sx, sy] of s.points) {
        minX = Math.min(minX, sx);
        minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx);
        maxY = Math.max(maxY, sy);
      }
    }
    const scale = planWidth / (maxX - minX || 1);
    // Flip Y (SVG is y-down; our grid is y-up) and anchor the min corner at 0.
    const toMetre = ([sx, sy]: [number, number]): MetreXY => [
      (sx - minX) * scale,
      (maxY - sy) * scale,
    ];

    setBuilding((prev) => {
      const stamp = Date.now();
      const newUnits = shapes.map((s, i) => ({
        id: `imp-${stamp}-${i}`,
        ordinal,
        name: s.name || `Imported ${i + 1}`,
        category: "room" as const,
        polygon: s.points.map(toMetre),
      }));
      const openings = [...prev.openings];
      const hasCorridor = prev.units.some(
        (u) => u.category === "corridor" && u.ordinal === ordinal,
      );
      if (hasCorridor) {
        for (const u of newUnits) {
          const d = doorForRoom(prev, u.polygon, ordinal);
          if (d) openings.push({ id: `d-${u.id}`, unit: u.id, at: d });
        }
      }
      return { ...prev, units: [...prev.units, ...newUnits], openings };
    });
    setImportMsg(
      `Imported ${shapes.length} shape${shapes.length === 1 ? "" : "s"} onto ${levelName(ordinal)}.`,
    );
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    try {
      importSvg(await file.text());
    } catch {
      setImportMsg("Could not parse that file as SVG.");
    }
  }

  const selectedUnit = building.units.find((u) => u.id === selectedId) ?? null;

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
          <label>Draw a room on {levelName(ordinal)}</label>
          <div className="floors">
            <button
              className={drawTool === "rect" ? "active" : ""}
              onClick={() => pickDrawTool("rect")}
            >
              ▢ Rectangle
            </button>
            <button
              className={drawTool === "polygon" ? "active" : ""}
              onClick={() => pickDrawTool("polygon")}
            >
              ⬡ Polygon
            </button>
          </div>
          {drawTool === "rect" && (
            <p className="hint">Drag a rectangle. Releases into a routable room.</p>
          )}
          {drawTool === "polygon" && (
            <p className="hint">
              Click to drop vertices. Click the first point again (or press Enter) to
              close; Esc cancels.
            </p>
          )}
          {drawTool === "none" && (
            <p className="hint">
              Not drawing: click a room to select it, or drag a cyan door dot to move
              the doorway (routes update live).
            </p>
          )}
        </section>

        <section>
          <label>Measure</label>
          <div className="floors">
            <button
              className={showDims ? "active" : ""}
              onClick={() => setShowDims((v) => !v)}
            >
              {showDims ? "◼ Dimensions on" : "▢ Dimensions off"}
            </button>
          </div>
          <div className="floors" style={{ marginTop: 8 }}>
            <button className={unit === "m" ? "active" : ""} onClick={() => setUnit("m")}>
              Metric (m)
            </button>
            <button className={unit === "ft" ? "active" : ""} onClick={() => setUnit("ft")}>
              Imperial (ft)
            </button>
          </div>
          {selectedUnit && (
            <div className="readout" style={{ marginTop: 12 }}>
              <div>
                <span className="k">space</span> {selectedUnit.name}
              </div>
              <div>
                <span className="k">area</span> {formatArea(polygonArea(selectedUnit.polygon), unit)}
              </div>
              <div>
                <span className="k">size</span>{" "}
                {dimsWH(selectedUnit.polygon, unit)}
              </div>
              <div>
                <span className="k">perim</span>{" "}
                {formatLength(polygonPerimeter(selectedUnit.polygon), unit)}
              </div>
            </div>
          )}
        </section>

        <section>
          <label>Grid &amp; snap</label>
          <div className="floors" style={{ alignItems: "center" }}>
            <button
              className={showGrid ? "active" : ""}
              onClick={() => setShowGrid((v) => !v)}
            >
              {showGrid ? "◼ Grid on" : "▢ Grid off"}
            </button>
            <input
              type="number"
              className="numin"
              min={0.25}
              max={20}
              step={0.25}
              value={gridSize}
              onChange={(e) =>
                setGridSize(Math.min(20, Math.max(0.25, Number(e.target.value) || 1)))
              }
              title="Grid size"
            />
            <span className="unitlabel">m</span>
          </div>
          {showGrid && (
            <p className="hint">
              Drawing snaps to a {gridSize} m grid. Turn off for freehand placement.
            </p>
          )}
        </section>

        <section>
          <label>Vertical links (stairs / elevator)</label>
          <button className={`wide ${linkMode ? "active" : ""}`} onClick={toggleLinkMode}>
            {linkMode ? "◼ Linking — click stop" : "⭥ Link two units across floors"}
          </button>
          {linkMode && (
            <p className="hint">
              {pendingLink
                ? `Picked ${roomName(building, pendingLink.id)} on ${levelName(
                    pendingLink.ordinal,
                  )}. Switch floor and click another unit to connect them.`
                : "Click a unit (e.g. an elevator/stairwell), then switch floor and click its counterpart."}
            </p>
          )}
          {building.verticals.length > 0 && (
            <div className="roomlist" style={{ marginTop: 8 }}>
              {building.verticals.map((v) => (
                <div className="roomrow" key={`${v.a}-${v.b}`}>
                  <span className="vlabel">
                    {roomName(building, v.a)} ⭥ {roomName(building, v.b)}
                  </span>
                  <button
                    className="del"
                    title="Remove link"
                    onClick={() => deleteVertical(v.a, v.b)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
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
                <div
                  className={`roomrow ${r.id === selectedId ? "selected" : ""}`}
                  key={r.id}
                >
                  <input
                    value={r.name}
                    onFocus={() => setSelectedId(r.id)}
                    onChange={(e) => renameRoom(r.id, e.target.value)}
                  />
                  <button
                    className="del"
                    title="Delete room"
                    onClick={() => deleteRoom(r.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <label>Import SVG floorplan → {levelName(ordinal)}</label>
          <div className="floors" style={{ alignItems: "center" }}>
            <input
              type="number"
              className="numin"
              min={1}
              value={planWidth}
              onChange={(e) => setPlanWidth(Math.max(1, Number(e.target.value) || 1))}
              title="Plan width in metres"
            />
            <span className="unitlabel">m wide</span>
          </div>
          <label className="filebtn">
            Choose SVG…
            <input type="file" accept=".svg,image/svg+xml" onChange={onImportFile} hidden />
          </label>
          {importMsg && <p className="hint">{importMsg}</p>}
          <p className="hint">
            Parses rect/polygon/path shapes into rooms, scaled to the width above.
            Curves flatten to endpoints; element transforms are ignored. Tip: Reset or
            clear the floor first for a clean import.
          </p>
        </section>

        <section>
          <button className="wide ghost" onClick={resetBuilding}>
            Reset building
          </button>
        </section>
      </aside>

      <MapView
        building={building}
        ordinal={ordinal}
        drawTool={drawTool}
        selectedId={selectedId}
        unit={unit}
        showDims={showDims}
        showGrid={showGrid}
        gridSize={gridSize}
        linkMode={linkMode}
        routeLines={geom?.lines ?? empty}
        routePoints={geom?.points ?? []}
        onAddRoom={addRoom}
        onSelect={setSelectedId}
        onMoveDoor={moveDoor}
        onRename={renameRoom}
        onSetCategory={setUnitCategory}
        onDelete={deleteRoom}
        onLinkUnit={onLinkUnit}
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

function dimsWH(polygon: MetreXY[], unit: Unit): string {
  const [x0, y0, x1, y1] = bbox(polygon);
  return `${formatLength(x1 - x0, unit)} × ${formatLength(y1 - y0, unit)}`;
}
