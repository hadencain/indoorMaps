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

/**
 * FUNCTIONAL fill buckets — a security/space plan reads by FUNCTION, not by the
 * generic "room" category (every casino space is category "room"). Bucketed by
 * unit id-prefix (the demo generator's convention) with a category fallback for
 * generic buildings. Muted, tuned against the #191411 carpet slab; the
 * secure/restricted tint still layers on top for access-control units.
 */
export const FUNCTION_LABELS: Record<string, string> = {
  gaming: "Gaming floor",
  circ: "Circulation",
  premium: "Premium gaming",
  fnb: "Food & bar",
  show: "Entertainment",
  sport: "Sportsbook",
  cage: "Cage / cash",
  boh: "Back of house",
  core: "Vertical core",
  outside: "Exterior",
};
export const FUNCTION_COLORS: Record<string, string> = {
  gaming: "#1c232f",
  circ: "#26314a",
  premium: "#2c2442",
  fnb: "#2d2519",
  show: "#271d36",
  sport: "#162b33",
  cage: "#2b2113",
  boh: "#1e242c",
  core: "#0e3b3a",
  outside: "#12261a",
};
export function functionBucket(u: Unit): string {
  const id = u.id;
  if (id.startsWith("pit-")) return "gaming";
  if (id.startsWith("aisle-") || u.category === "corridor") return "circ";
  if (id.startsWith("poker-") || id.startsWith("hilimit-")) return "premium";
  if (id.startsWith("food-") || id.startsWith("bar-")) return "fnb";
  if (id.startsWith("showroom-")) return "show";
  if (id.startsWith("sport-")) return "sport";
  if (id.startsWith("cage-")) return "cage";
  if (id.startsWith("boh-")) return "boh";
  if (u.category === "stairs" || u.category === "elevator") return "core";
  if (u.category === "outside") return "outside";
  return "gaming";
}
export function functionFillExpression(): unknown[] {
  const cases: unknown[] = ["match", ["get", "func"]];
  for (const k of Object.keys(FUNCTION_COLORS)) cases.push(k, FUNCTION_COLORS[k]);
  cases.push(FUNCTION_COLORS.gaming); // fallback
  return cases;
}
