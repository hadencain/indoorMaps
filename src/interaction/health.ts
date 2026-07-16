import type { Building, MetreXY, Opening, Unit } from "../types";
import { distM, polygonArea, polygonCentroid, projectOnSegment } from "../geo";
import { pointInRing } from "../coverage";
import { isSpace, isNonRoutable } from "../categories";

/** How far (metres) to probe each side of a door's wall for the adjoining unit. */
const PROBE_M = 0.4;

export interface DoorAdjacency {
  owner: string;
  /** Unit on the far side of the wall, or null for a one-sided door. */
  other: string | null;
}

/** The wall segment of `poly` nearest to `p`, as its outward-agnostic unit
 *  normal. Mirrors nearestPointOnPolygon's scan but keeps the segment. */
function nearestWallNormal(p: MetreXY, poly: MetreXY[]): MetreXY {
  let bestD = Infinity;
  let normal: MetreXY = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const q = projectOnSegment(p, a, b);
    const d = distM(p, q);
    if (d < bestD) {
      bestD = d;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len = Math.hypot(ex, ey) || 1;
      normal = [-ey / len, ex / len];
    }
  }
  return normal;
}

/** Which two spaces a door joins: probe a point on each side of the owning
 *  unit's nearest wall; the probe that lands OUTSIDE the owner is searched for
 *  in every other same-ordinal unit. Pure; unknown owner → { owner, other: null }. */
export function doorAdjacency(units: Unit[], op: Opening): DoorAdjacency {
  const owner = units.find((u) => u.id === op.unit);
  if (!owner) return { owner: op.unit, other: null };
  const [nx, ny] = nearestWallNormal(op.at, owner.polygon);
  const probes: MetreXY[] = [
    [op.at[0] + nx * PROBE_M, op.at[1] + ny * PROBE_M],
    [op.at[0] - nx * PROBE_M, op.at[1] - ny * PROBE_M],
  ];
  for (const probe of probes) {
    if (pointInRing(probe, owner.polygon)) continue; // that's the inside — skip
    const hit = units.find(
      (u) => u.id !== owner.id && u.ordinal === owner.ordinal && pointInRing(probe, u.polygon),
    );
    if (hit) return { owner: owner.id, other: hit.id };
  }
  return { owner: owner.id, other: null };
}

export interface FloorHealth {
  /** Space-category units (not circulation/outside) with no opening at all. */
  doorlessRoomIds: string[];
  /** Plain doors (kind !== "entrance") with no unit on the far side. */
  oneSidedDoorIds: string[];
  /** Floor has plain doors but no corridor unit — graph.ts's no-route condition. */
  missingCorridor: boolean;
}

/** Authoring-health predicates for one floor. Shared by the on-canvas badges
 *  (P1) and the Review checklist panel (P4). Pure. */
export function floorHealth(building: Building, ordinal: number): FloorHealth {
  const units = building.units.filter((u) => u.ordinal === ordinal);
  const unitIds = new Set(units.map((u) => u.id));
  const openings = building.openings.filter((o) => unitIds.has(o.unit));
  const openedUnits = new Set(openings.map((o) => o.unit));

  // Build unit lookup by id to check category
  const unitsById = new Map(units.map((u) => [u.id, u]));

  const doorlessRoomIds = units
    .filter((u) => isSpace(u.category) && u.category !== "outside" && !openedUnits.has(u.id))
    .map((u) => u.id);

  const oneSidedDoorIds = openings
    .filter((o) => (o.kind ?? "door") === "door")
    .filter((o) => doorAdjacency(building.units, o).other === null)
    .map((o) => o.id);

  // Plain doors are those not owned by "outside" or restricted (non-routable) units;
  // mirrors graph.ts's skip condition (line ~83), which never reaches the
  // corridor-hub throw for doors owned by outside patches or non-routable units.
  const plainDoors = openings.some((o) => {
    const owner = unitsById.get(o.unit);
    return (o.kind ?? "door") === "door" && owner?.category !== "outside" && !(owner && isNonRoutable(owner));
  });
  const hasCorridor = units.some((u) => u.category === "corridor");
  const missingCorridor = plainDoors && !hasCorridor;

  return { doorlessRoomIds, oneSidedDoorIds, missingCorridor };
}

export type ReviewSeverity = "error" | "warn" | "info";

export interface ReviewIssue {
  id: string; // stable row key, e.g. "doorless:<unitId>"
  severity: ReviewSeverity;
  message: string; // human sentence naming the offender
  unitId?: string; // click target (select)
  at?: MetreXY; // fly target
  ordinal?: number; // floor the fly target lives on, when it differs from the reviewed floor
}

const SEV_ORDER: Record<ReviewSeverity, number> = { error: 0, warn: 1, info: 2 };

/** Typed authoring-health issues for one floor, mirroring the routing
 *  reality in graph.ts. Pure. Errors sort before warns before infos;
 *  stable within a tier (derivation order). */
export function reviewFloor(building: Building, ordinal: number): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const units = building.units.filter((u) => u.ordinal === ordinal);
  const unitsById = new Map(building.units.map((u) => [u.id, u]));
  const health = floorHealth(building, ordinal);

  if (health.missingCorridor) {
    let at: MetreXY | undefined;
    if (units.length > 0) {
      let largest = units[0];
      let largestArea = polygonArea(largest.polygon);
      for (const u of units.slice(1)) {
        const area = polygonArea(u.polygon);
        if (area > largestArea) {
          largest = u;
          largestArea = area;
        }
      }
      at = polygonCentroid(largest.polygon);
    }
    issues.push({
      id: "missing-corridor",
      severity: "error",
      message: "No corridor on this floor — plain doors have nowhere to route",
      at,
      ordinal,
    });
  }

  // Verticals are building-wide (they break routing globally, not just on
  // one floor) so these are surfaced on every floor's review, not just
  // where an endpoint happens to live.
  for (const v of building.verticals) {
    const a = unitsById.get(v.a);
    const b = unitsById.get(v.b);
    if (!a || !b) {
      const resolved = a ?? b;
      issues.push({
        id: `dangling-vertical:${v.a}:${v.b}`,
        severity: "error",
        message: `Vertical "${v.name}" references a missing unit`,
        unitId: resolved?.id,
        at: resolved ? polygonCentroid(resolved.polygon) : undefined,
        ordinal: resolved?.ordinal,
      });
    } else if (a.ordinal === b.ordinal) {
      issues.push({
        id: `flat-vertical:${v.a}:${v.b}`,
        severity: "warn",
        message: `Vertical "${v.name}" links two units on the same floor`,
        unitId: a.id,
        at: polygonCentroid(a.polygon),
        ordinal: a.ordinal,
      });
    }
  }

  for (const unitId of health.doorlessRoomIds) {
    const u = unitsById.get(unitId);
    const name = u && u.name.trim() ? u.name : "Unnamed unit";
    issues.push({
      id: `doorless:${unitId}`,
      severity: "warn",
      message: `${name} has no door — routing can't reach it`,
      unitId,
      at: u ? polygonCentroid(u.polygon) : undefined,
      ordinal,
    });
  }

  for (const openingId of health.oneSidedDoorIds) {
    const op = building.openings.find((o) => o.id === openingId);
    if (!op) continue;
    const owner = unitsById.get(op.unit);
    // Geometric one-sidedness never breaks routing: corridor-hub edges route plain doors
    // regardless of whether the far side is mapped. This is advisory only.
    issues.push({
      id: `one-sided-door:${openingId}`,
      severity: "info",
      message: `Door on ${owner?.name ?? "unknown unit"} opens onto unmapped space`,
      unitId: op.unit,
      at: op.at,
      ordinal,
    });
  }

  for (const u of units) {
    if (isSpace(u.category) && u.category !== "outside" && u.name.trim() === "") {
      issues.push({
        id: `unnamed:${u.id}`,
        severity: "warn",
        message: `Unnamed unit (${u.category})`,
        unitId: u.id,
        at: polygonCentroid(u.polygon),
        ordinal,
      });
    }
  }

  if ((building.occupants ?? []).length > 0) {
    const occupiedUnitIds = new Set((building.occupants ?? []).map((o) => o.unitId));
    for (const u of units) {
      if (isSpace(u.category) && u.category !== "outside" && !occupiedUnitIds.has(u.id)) {
        issues.push({
          id: `vacant:${u.id}`,
          severity: "info",
          message: `${u.name.trim() ? u.name : "Unnamed unit"} is vacant`,
          unitId: u.id,
          at: polygonCentroid(u.polygon),
          ordinal,
        });
      }
    }
  }

  issues.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
  return issues;
}
