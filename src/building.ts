import type { Building, MetreXY } from "./types";
import { bbox } from "./geo";
import { isSpace, isNonRoutable } from "./categories";

// Hand-authored two-floor building, designed in local metres.
// Ground (ordinal 0): Lobby / Cafe / Office 101 off a central corridor + elevator.
// Level 1 (ordinal 1): Conference / Office 201 / Lab off the same corridor + elevator.
// The elevator is the only vertical connection, so a Lobby->Lab route must use it.

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

export const initialBuilding: Building = {
  // Near the Empire State Building — arbitrary, just somewhere real-feeling.
  origin: [-73.9857, 40.7484],
  levels: [
    { ordinal: 0, name: "Ground" },
    { ordinal: 1, name: "Level 1" },
  ],
  units: [
    // --- Ground (ordinal 0) ---
    { id: "corridor-g", ordinal: 0, name: "Corridor", category: "corridor", polygon: rectPoly(0, 18, 40, 22) },
    { id: "lobby", ordinal: 0, name: "Lobby", category: "room", polygon: rectPoly(0, 0, 12, 18) },
    { id: "cafe", ordinal: 0, name: "Cafe", category: "room", polygon: rectPoly(14, 0, 26, 18) },
    { id: "office-101", ordinal: 0, name: "Office 101", category: "room", polygon: rectPoly(28, 0, 40, 18) },
    { id: "elevator-g", ordinal: 0, name: "Elevator", category: "elevator", polygon: rectPoly(18, 22, 22, 26) },
    // --- Level 1 (ordinal 1) ---
    { id: "corridor-1", ordinal: 1, name: "Corridor", category: "corridor", polygon: rectPoly(0, 18, 40, 22) },
    { id: "conf", ordinal: 1, name: "Conference", category: "room", polygon: rectPoly(0, 0, 12, 18) },
    { id: "office-201", ordinal: 1, name: "Office 201", category: "room", polygon: rectPoly(14, 0, 26, 18) },
    { id: "lab", ordinal: 1, name: "Lab", category: "room", polygon: rectPoly(28, 0, 40, 18) },
    { id: "elevator-1", ordinal: 1, name: "Elevator", category: "elevator", polygon: rectPoly(18, 22, 22, 26) },
  ],
  openings: [
    // Ground doors onto the corridor (corridor bottom edge is y=18).
    { id: "d-lobby", unit: "lobby", at: [6, 18] },
    { id: "d-cafe", unit: "cafe", at: [20, 18] },
    { id: "d-office-101", unit: "office-101", at: [34, 18] },
    { id: "d-elevator-g", unit: "elevator-g", at: [20, 22] }, // corridor top edge
    // Level 1 doors.
    { id: "d-conf", unit: "conf", at: [6, 18] },
    { id: "d-office-201", unit: "office-201", at: [20, 18] },
    { id: "d-lab", unit: "lab", at: [34, 18] },
    { id: "d-elevator-1", unit: "elevator-1", at: [20, 22] },
  ],
  verticals: [{ a: "elevator-g", b: "elevator-1", name: "Elevator" }],
  cameras: [],
};

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
