import type { Building, MetreXY } from "./types";
import { bbox } from "./geo";
import { isSpace, isNonRoutable } from "./categories";

/** Axis-aligned rectangle as a 4-vertex polygon (open ring). */
export function rectPoly(x0: number, y0: number, x1: number, y1: number): MetreXY[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** A rectangle polygon from any two drag corners. */
export function rectFromDrag(a: MetreXY, b: MetreXY): MetreXY[] {
  return rectPoly(
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  );
}

export { casinoBuilding as initialBuilding } from "./demos/casino";

/**
 * Units a user can pick as a route start/destination: every authored space
 * (room/office/restroom/lobby/retail/storage/mechanical/outside), excluding
 * circulation (corridor/elevator/stairs) and security-restricted units.
 */
export function selectableUnits(b: Building) {
  return b.units.filter((u) => isSpace(u.category) && !isNonRoutable(u));
}

/**
 * Place a door for a freshly-authored room: on the room's bounding-box edge
 * nearest the corridor, horizontally centred but clamped to the corridor's
 * extent. Good enough for the spike; doors become draggable next.
 */
export function doorForRoom(
  b: Building,
  polygon: MetreXY[],
  ordinal: number,
): MetreXY | null {
  const corridor = b.units.find((u) => u.category === "corridor" && u.ordinal === ordinal);
  if (!corridor) return null;
  const [cx0, cy0, cx1, cy1] = bbox(corridor.polygon);
  const [x0, y0, x1, y1] = bbox(polygon);
  const cx = Math.min(Math.max((x0 + x1) / 2, cx0), cx1);
  // Below the corridor band -> door on corridor's bottom edge; above -> top edge.
  if (y1 <= cy0) return [cx, cy0];
  if (y0 >= cy1) return [cx, cy1];
  return [cx, cy0];
}

/**
 * Retro-fill doors for every doorless space room on a floor, given a building
 * that already has its corridor unit in place. Used when a corridor is added
 * AFTER rooms were traced (the from-scratch authoring order) — without this,
 * those earlier rooms are stranded with no door and no UI to add one.
 * Pure: returns placements only, caller maps them to Opening objects/ids.
 */
export function autoDoorsForRooms(
  b: Building,
  ordinal: number,
): { unit: string; at: MetreXY }[] {
  const doored = new Set(b.openings.map((o) => o.unit));
  const doorless = b.units.filter(
    (u) =>
      u.ordinal === ordinal &&
      isSpace(u.category) &&
      u.category !== "outside" &&
      !doored.has(u.id),
  );
  const placements: { unit: string; at: MetreXY }[] = [];
  for (const u of doorless) {
    const at = doorForRoom(b, u.polygon, ordinal);
    if (at) placements.push({ unit: u.id, at });
  }
  return placements;
}
