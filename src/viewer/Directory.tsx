import type { Building, MetreXY, OccupantCategory } from "../types";
import { OCCUPANT_CATEGORY_LABELS, occupantAnchor } from "../occupants";
import { isSpace } from "../categories";
import { polygonCentroid } from "../geo";

/** Tenant directory (display-mode's FloorContentsPanel "Tenants" view, minus
 *  authoring). Occupants grouped by OCCUPANT_CATEGORY_LABELS, building-wide
 *  (not floor-scoped — a visitor browsing the directory shouldn't have to
 *  hunt floor by floor); clicking one flies the map to its unit and switches
 *  floor if needed. Vacant selectable spaces list separately below. */
export default function Directory({
  building,
  onGo,
}: {
  building: Building;
  onGo: (unitId: string, ordinal: number, center: MetreXY) => void;
}) {
  const unitById = new Map(building.units.map((u) => [u.id, u]));
  const occupants = building.occupants ?? [];
  const occupiedUnitIds = new Set(occupants.map((o) => o.unitId));
  const vacant = building.units.filter(
    (u) => isSpace(u.category) && u.category !== "outside" && !occupiedUnitIds.has(u.id),
  );

  const go = (unitId: string, at: MetreXY) => {
    const u = unitById.get(unitId);
    if (!u) return;
    onGo(unitId, u.ordinal, at);
  };

  return (
    <div className="panel">
      <div className="panel-title">Directory</div>
      {occupants.length === 0 && vacant.length === 0 && <p className="hint">No tenants listed.</p>}
      {(Object.keys(OCCUPANT_CATEGORY_LABELS) as OccupantCategory[]).map((cat) => {
        const group = occupants.filter((o) => o.category === cat);
        if (group.length === 0) return null;
        return (
          <div key={cat}>
            <div className="panel-subtitle" style={{ marginTop: 10 }}>
              {OCCUPANT_CATEGORY_LABELS[cat]}
            </div>
            <div className="roomlist">
              {group.map((o) => {
                const u = unitById.get(o.unitId);
                return (
                  <div className="roomrow" key={o.id}>
                    <button
                      className="occ-head"
                      onClick={() => go(o.unitId, occupantAnchor(building, o))}
                      title="Show on map"
                    >
                      <span className="vlabel">{o.name}</span>
                      <span className="occ-cat">{u?.name ?? ""}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {vacant.length > 0 && (
        <>
          <div className="panel-subtitle" style={{ marginTop: 10 }}>
            Other spaces
          </div>
          <div className="roomlist">
            {vacant.map((u) => (
              <div className="roomrow" key={u.id}>
                <button
                  className="occ-head"
                  onClick={() => go(u.id, polygonCentroid(u.polygon))}
                  title="Show on map"
                >
                  <span className="vlabel">{u.name}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
