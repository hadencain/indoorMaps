/** Per-property building persistence keys. Pure + storage-injected so the key
 *  scheme and legacy migration are node-testable without jsdom. */
export const BUILDING_KEY_BASE = "indoormaps:building:v3";

/** Minimal shape a parsed localStorage building save must satisfy before
 *  loadBuilding() (src/store.ts) will use it. localStorage is user-controlled
 *  startup input — hand-edited, quota-truncated, or written by an older build —
 *  so a structurally-plausible but truncated blob (missing `verticals` or
 *  `origin`) must fail here and fall back to the pristine demo, rather than
 *  reach the first render: graph.ts iterates `b.verticals` unguarded, and
 *  `m2ll(b.origin, ...)` destructures `origin` unguarded. Kept pure (no
 *  localStorage/JSON access) so it's node-testable without jsdom, matching the
 *  rest of this module. */
export function isValidBuildingShape(b: unknown): b is {
  units: { polygon: unknown }[];
  levels: unknown[];
  openings: { id: unknown }[];
  verticals: unknown[];
  origin: [unknown, unknown];
} {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    Array.isArray(o.units) &&
    Array.isArray(o.levels) &&
    Array.isArray(o.openings) &&
    Array.isArray(o.verticals) &&
    Array.isArray(o.origin) &&
    o.origin.length === 2 &&
    typeof o.origin[0] === "number" &&
    typeof o.origin[1] === "number" &&
    (o.units as unknown[]).every((u) => !!u && typeof u === "object" && Array.isArray((u as Record<string, unknown>).polygon)) &&
    (o.openings as unknown[]).every((op) => !!op && typeof op === "object" && typeof (op as Record<string, unknown>).id === "string")
  );
}

export function buildingKey(propertyId: string): string {
  return `${BUILDING_KEY_BASE}:${propertyId}`;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** One-time migration: pre-gallery saves lived at the un-suffixed key and were
 *  always the casino. Copy (never delete — cheap safety) to the casino key. */
export function migrateLegacyBuilding(storage: StorageLike): void {
  const legacy = storage.getItem(BUILDING_KEY_BASE);
  if (legacy !== null && storage.getItem(buildingKey("casino")) === null) {
    storage.setItem(buildingKey("casino"), legacy);
  }
}
