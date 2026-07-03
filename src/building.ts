import type { Building, MetreXY } from "./types";

// Hand-authored two-floor building, designed in local metres.
// Ground (ordinal 0): Lobby / Cafe / Office 101 off a central corridor + elevator.
// Level 1 (ordinal 1): Conference / Office 201 / Lab off the same corridor + elevator.
// The elevator is the only vertical connection, so a Lobby->Lab route must use it.

const CORRIDOR_G: [number, number, number, number] = [0, 18, 40, 22];
const CORRIDOR_1: [number, number, number, number] = [0, 18, 40, 22];
const ELEVATOR: [number, number, number, number] = [18, 22, 22, 26];

export const initialBuilding: Building = {
  // Near the Empire State Building — arbitrary, just somewhere real-feeling.
  origin: [-73.9857, 40.7484],
  levels: [
    { ordinal: 0, name: "Ground" },
    { ordinal: 1, name: "Level 1" },
  ],
  units: [
    // --- Ground (ordinal 0) ---
    { id: "corridor-g", ordinal: 0, name: "Corridor", category: "corridor", rect: CORRIDOR_G },
    { id: "lobby", ordinal: 0, name: "Lobby", category: "room", rect: [0, 0, 12, 18] },
    { id: "cafe", ordinal: 0, name: "Cafe", category: "room", rect: [14, 0, 26, 18] },
    { id: "office-101", ordinal: 0, name: "Office 101", category: "room", rect: [28, 0, 40, 18] },
    { id: "elevator-g", ordinal: 0, name: "Elevator", category: "elevator", rect: ELEVATOR },
    // --- Level 1 (ordinal 1) ---
    { id: "corridor-1", ordinal: 1, name: "Corridor", category: "corridor", rect: CORRIDOR_1 },
    { id: "conf", ordinal: 1, name: "Conference", category: "room", rect: [0, 0, 12, 18] },
    { id: "office-201", ordinal: 1, name: "Office 201", category: "room", rect: [14, 0, 26, 18] },
    { id: "lab", ordinal: 1, name: "Lab", category: "room", rect: [28, 0, 40, 18] },
    { id: "elevator-1", ordinal: 1, name: "Elevator", category: "elevator", rect: ELEVATOR },
  ],
  openings: [
    // Ground doors onto the corridor (corridor bottom edge is y=18).
    { unit: "lobby", at: [6, 18] },
    { unit: "cafe", at: [20, 18] },
    { unit: "office-101", at: [34, 18] },
    { unit: "elevator-g", at: [20, 22] }, // corridor top edge
    // Level 1 doors.
    { unit: "conf", at: [6, 18] },
    { unit: "office-201", at: [20, 18] },
    { unit: "lab", at: [34, 18] },
    { unit: "elevator-1", at: [20, 22] },
  ],
  verticals: [{ a: "elevator-g", b: "elevator-1", name: "Elevator" }],
};

/** Rooms a user can pick as a start/destination (excludes corridors/elevators). */
export function selectableUnits(b: Building) {
  return b.units.filter((u) => u.category === "room");
}

/**
 * Place a door for a freshly-drawn room: on the room edge nearest the corridor,
 * horizontally centred on the room but clamped to the corridor's extent.
 * Good enough for the spike; a real authoring tool would let you drag the door.
 */
export function doorForRoom(
  b: Building,
  rect: [number, number, number, number],
  ordinal: number,
): MetreXY | null {
  const corridor = b.units.find((u) => u.category === "corridor" && u.ordinal === ordinal);
  if (!corridor) return null;
  const [cx0, cy0, cx1, cy1] = corridor.rect;
  const [x0, y0, x1, y1] = rect;
  const cx = Math.min(Math.max((x0 + x1) / 2, cx0), cx1);
  // Below the corridor band -> door on corridor's bottom edge; above -> top edge.
  if (y1 <= cy0) return [cx, cy0];
  if (y0 >= cy1) return [cx, cy1];
  return [cx, cy0];
}

/** Normalise a drag (any two corners) into an ordered rect [x0<x1, y0<y1]. */
export function normaliseRect(
  a: MetreXY,
  b: MetreXY,
): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
