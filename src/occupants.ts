import type { Building, MetreXY, Occupant } from "./types";
import { polygonCentroid } from "./geo";

/** The occupant's label/POI point: explicit anchor, else its unit's centroid,
 *  else [0,0] for a dangling unitId (never persisted — deleteUnit cascades —
 *  but render code must not throw on transient states). */
export function occupantAnchor(b: Building, o: Occupant): MetreXY {
  if (o.anchor) return o.anchor;
  const unit = b.units.find((u) => u.id === o.unitId);
  return unit ? polygonCentroid(unit.polygon) : [0, 0];
}

/** All occupants of one unit, in array order. [] for vacant / pre-default. */
export function occupantsForUnit(b: Building, unitId: string): Occupant[] {
  return (b.occupants ?? []).filter((o) => o.unitId === unitId);
}

/** unitId → space-joined occupant names. Feeds the unit-feature `occupant`
 *  property so canvas search-dimming can match tenant names (P2) and the
 *  occupant-anchored labels can render (P3). Units with no occupants are
 *  absent from the map (vacant ≠ empty string). */
export function occupantNamesByUnit(b: Building): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of b.occupants ?? []) {
    const prev = m.get(o.unitId);
    m.set(o.unitId, prev ? `${prev} ${o.name}` : o.name);
  }
  return m;
}
