import { useState } from "react";
import type { Building } from "../types";
import { selectableUnits } from "../building";
import { WALK_MPS } from "../route-smooth";
import { formatLength } from "../format";
import type { Unit as LengthUnit } from "../format";
import type { ViewerRouteInfo } from "./route";

/** A→B wayfinding panel (visitor RoutePanel.tsx's "direct" mode only — no
 *  egress/nearest-exit, that's an operator concept). From/To pick any
 *  selectable unit OR any occupant (resolved to its unit), same token scheme
 *  as the authoring app's RoutePanel. */
export default function RouteFinder({
  building,
  startId,
  goalId,
  setStartId,
  setGoalId,
  route,
  lengthUnit,
}: {
  building: Building;
  startId: string;
  goalId: string;
  setStartId: (id: string) => void;
  setGoalId: (id: string) => void;
  route: ViewerRouteInfo;
  lengthUnit: LengthUnit;
}) {
  const rooms = selectableUnits(building);
  const level = (o: number) => building.levels.find((l) => l.ordinal === o)?.name ?? `Floor ${o}`;
  const roomIds = new Set(rooms.map((r) => r.id));
  const occupantOptions = (building.occupants ?? []).filter((o) => roomIds.has(o.unitId));

  const [fromTok, setFromTok] = useState<string | null>(null);
  const [toTok, setToTok] = useState<string | null>(null);
  const tokToUnit = (tok: string): string =>
    tok.startsWith("o:") ? occupantOptions.find((o) => o.id === tok.slice(2))?.unitId ?? "" : tok.slice(2);
  const fromValue = fromTok && tokToUnit(fromTok) === startId ? fromTok : `u:${startId}`;
  const toValue = toTok && tokToUnit(toTok) === goalId ? toTok : `u:${goalId}`;
  const onPick = (tok: string, which: "from" | "to") => {
    const unitId = tokToUnit(tok);
    if (!unitId) return;
    if (which === "from") {
      setFromTok(tok);
      setStartId(unitId);
    } else {
      setToTok(tok);
      setGoalId(unitId);
    }
  };

  const { geom, steps } = route;

  return (
    <div className="panel">
      <div className="panel-title">Wayfinding</div>
      <label>From</label>
      <select value={fromValue} onChange={(e) => onPick(e.target.value, "from")}>
        {rooms.map((r) => (
          <option key={r.id} value={`u:${r.id}`}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
        {occupantOptions.map((o) => {
          const r = rooms.find((x) => x.id === o.unitId);
          if (!r) return null;
          return (
            <option key={`occ-${o.id}`} value={`o:${o.id}`}>
              {o.name} · {level(r.ordinal)}
            </option>
          );
        })}
      </select>
      <label>To</label>
      <select value={toValue} onChange={(e) => onPick(e.target.value, "to")}>
        {rooms.map((r) => (
          <option key={r.id} value={`u:${r.id}`}>
            {r.name} · {level(r.ordinal)}
          </option>
        ))}
        {occupantOptions.map((o) => {
          const r = rooms.find((x) => x.id === o.unitId);
          if (!r) return null;
          return (
            <option key={`occ-${o.id}`} value={`o:${o.id}`}>
              {o.name} · {level(r.ordinal)}
            </option>
          );
        })}
      </select>
      <div className="readout" style={{ marginTop: 12 }}>
        {geom ? (
          <>
            <div>
              <span className="k">floors</span> {geom.floors.map(level).join(" → ") || "—"}
            </div>
            <div>
              <span className="k">walk</span> ~{formatLength(geom.metres, lengthUnit)} ·{" "}
              ~{Math.max(1, Math.ceil(geom.metres / WALK_MPS / 60))} min
              {geom.floors.length > 1 && " + elevator"}
            </div>
          </>
        ) : (
          <div className="warn">no route found</div>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="route-steps">
          {steps.map((s, i) => (
            <li key={i}>{s.text}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
