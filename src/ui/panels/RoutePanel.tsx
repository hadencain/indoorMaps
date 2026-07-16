import { useState } from "react";
import { useStore } from "../../store";
import { useRoute } from "../route";
import { selectableUnits } from "../../building";
import { WALK_MPS } from "../../route-smooth";

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
  const occupants = building.occupants ?? [];
  const roomIds = new Set(rooms.map((r) => r.id));
  // Tenants routable via their unit; skip occupants of non-selectable units.
  const occupantOptions = occupants.filter((o) => roomIds.has(o.unitId));

  const [fromTok, setFromTok] = useState<string | null>(null);
  const [toTok, setToTok] = useState<string | null>(null);
  const tokToUnit = (tok: string): string =>
    tok.startsWith("o:") ? occupantOptions.find((o) => o.id === tok.slice(2))?.unitId ?? "" : tok.slice(2);
  // The local token only sticks while it still resolves to the store's unit —
  // external changes (AppShell keeps endpoints valid) fall back to the unit token.
  const fromValue = fromTok && tokToUnit(fromTok) === startId ? fromTok : `u:${startId}`;
  const toValue = toTok && tokToUnit(toTok) === goalId ? toTok : `u:${goalId}`;
  const onPick = (tok: string, which: "from" | "to") => {
    const unitId = tokToUnit(tok);
    if (!unitId) return;
    if (which === "from") {
      setFromTok(tok);
      setStart(unitId);
    } else {
      setToTok(tok);
      setGoal(unitId);
    }
  };

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
      <select value={fromValue} onChange={(e) => onPick(e.target.value, "from")}>
        {rooms.map((r) => (
          <option key={r.id} value={`u:${r.id}`}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
        {occupantOptions.map((o) => {
          const r = rooms.find((x) => x.id === o.unitId)!;
          return (
            <option key={`occ-${o.id}`} value={`o:${o.id}`}>
              {o.name} · {level(r.ordinal)}
            </option>
          );
        })}
      </select>
      {!egress && (
        <>
          <label>To</label>
          <select value={toValue} onChange={(e) => onPick(e.target.value, "to")}>
            {rooms.map((r) => (
              <option key={r.id} value={`u:${r.id}`}>
                {r.name} · {level(r.ordinal)}
              </option>
            ))}
            {occupantOptions.map((o) => {
              const r = rooms.find((x) => x.id === o.unitId)!;
              return (
                <option key={`occ-${o.id}`} value={`o:${o.id}`}>
                  {o.name} · {level(r.ordinal)}
                </option>
              );
            })}
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
              <span className="k">{egress ? "nearest exit" : "walk"}</span> ~{geom.metres.toFixed(0)} m ·{" "}
              ~{Math.max(1, Math.ceil(geom.metres / WALK_MPS / 60))} min
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
