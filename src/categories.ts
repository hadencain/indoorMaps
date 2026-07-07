import type { Building, Category, Unit } from "./types";

/** Display order in every category <select> and legend. */
export const CATEGORY_ORDER: Category[] = [
  "room", "office", "restroom", "lobby", "retail", "storage",
  "mechanical", "corridor", "elevator", "stairs", "outside",
];

/** Human label used in dropdown options and as the default-name stem. */
export const CATEGORY_LABELS: Record<Category, string> = {
  room: "Room",
  office: "Office",
  restroom: "Restroom",
  lobby: "Lobby",
  retail: "Retail",
  storage: "Storage",
  mechanical: "Mechanical",
  corridor: "Corridor",
  elevator: "Elevator",
  stairs: "Stairs",
  outside: "Outside",
};

/** Fill colors — dark technical palette, tuned against the #0b0d10 canvas. */
export const CATEGORY_COLORS: Record<Category, string> = {
  room: "#171f2b",       // unchanged (generic space)
  corridor: "#1a2230",   // unchanged
  elevator: "#0e3b3a",   // unchanged
  stairs: "#3a2e14",     // unchanged
  office: "#1b2536",     // cool blue-grey
  restroom: "#16303a",   // muted teal
  lobby: "#202a3a",      // lighter public blue-grey
  retail: "#2a2340",     // violet
  storage: "#26221a",    // warm brown
  mechanical: "#2e2422", // rust/warm-grey
  outside: "#12261a",    // dark green — exterior, walkable
};

/** Circulation categories: excluded from the floor-contents "spaces" list. */
export const CIRCULATION: ReadonlySet<Category> = new Set<Category>([
  "corridor", "elevator", "stairs",
]);

/**
 * Non-routable predicate. Access is a hybrid model: `restricted` is a
 * `Unit.security` level, NOT a category. This is the shared contract Agent B
 * (routing) consumes — `buildGraph` should emit no node for such a unit and
 * skip openings referencing it; route pickers must exclude it.
 * Absent `security` is treated as "public" (routable).
 */
export function isNonRoutable(u: Unit): boolean {
  return u.security === "restricted";
}

/** A "space" = an authored region a user manages, not circulation infra. */
export function isSpace(c: Category): boolean {
  return !CIRCULATION.has(c);
}

/**
 * Type-aware default name for a freshly-created unit: "<Label> <N>",
 * where N counts existing units already in that category (+1).
 */
export function defaultNameFor(category: Category, b: Building): string {
  const n = b.units.filter((u) => u.category === category).length + 1;
  return `${CATEGORY_LABELS[category]} ${n}`;
}

/**
 * MapLibre data-driven "match" expression mapping category -> fill color.
 * Returned as a plain JSON array (no maplibre import); MapView casts it.
 */
export function categoryFillExpression(): unknown[] {
  const cases: unknown[] = ["match", ["get", "category"]];
  for (const c of CATEGORY_ORDER) cases.push(c, CATEGORY_COLORS[c]);
  cases.push("#171f2b"); // fallback
  return cases;
}
