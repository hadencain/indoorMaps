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

/** Default the additive collections a legacy or minimal blob may lack, in
 *  place. Every consumer of a parsed building (localStorage load, file import)
 *  must run this before the first render — downstream code indexes these
 *  arrays unguarded. Returns its argument for chaining. */
export function withBuildingDefaults<T extends object>(b: T): T {
  const o = b as Record<string, unknown>;
  for (const k of ["cameras", "incidents", "patrols", "amenities", "fixtures", "footprints", "underlays", "occupants", "vectorUnderlays"])
    if (!Array.isArray(o[k])) o[k] = [];
  return b;
}

/** File format for the full-fidelity building save (Data → Save building
 *  file…). The envelope wraps the EXACT persisted v3 building shape — nothing
 *  is projected or dropped, unlike the IMDF/GeoJSON exports. */
export const BUILDING_FILE_FORMAT = "indoormaps-building";

export function buildingFileText(building: unknown, propertyId: string): string {
  return JSON.stringify(
    { format: BUILDING_FILE_FORMAT, version: 3, propertyId, building },
    null,
    2,
  );
}

/** Parse a building save file. Accepts the envelope buildingFileText writes,
 *  or a bare building blob (so a hand-copied localStorage value also loads).
 *  Returns null unless the contained building passes the same structural
 *  validation as a localStorage load; additive collections are defaulted. */
export function parseBuildingFileText(
  text: string,
): { building: Record<string, unknown>; propertyId?: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if ("format" in o) {
    if (o.format !== BUILDING_FILE_FORMAT) return null;
    if (!isValidBuildingShape(o.building)) return null;
    return {
      building: withBuildingDefaults(o.building as Record<string, unknown>),
      propertyId: typeof o.propertyId === "string" ? o.propertyId : undefined,
    };
  }
  if (!isValidBuildingShape(obj)) return null;
  return { building: withBuildingDefaults(o) };
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
