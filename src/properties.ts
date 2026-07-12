import type { Building, RasterUnderlay } from "./types";
import { buildingKey, type StorageLike } from "./persistence";
import { DEMOS } from "./demos";

/** User-created properties (New property from image). The registry holds only
 *  {id, name} rows — each property's building lives under the normal
 *  per-property v3 key, exactly like a demo's edits, so save/load/export all
 *  work unchanged. Pure + storage-injected, node-testable without jsdom. */
export interface UserProperty {
  id: string;
  name: string;
}

export const USER_PROPERTIES_KEY = "indoormaps:userprops:v1";

export function loadUserProperties(storage: StorageLike): UserProperty[] {
  try {
    const raw = storage.getItem(USER_PROPERTIES_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return [];
    return p.filter(
      (x): x is UserProperty =>
        !!x && typeof x === "object" && typeof x.id === "string" && typeof x.name === "string",
    );
  } catch {
    return [];
  }
}

export function saveUserProperties(storage: StorageLike, props: UserProperty[]): void {
  try {
    storage.setItem(USER_PROPERTIES_KEY, JSON.stringify(props));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Kebab-slug a display name into a property id, deduped against every
 *  existing id (demo AND user) so a user naming a property "Casino" can never
 *  shadow the shipped demo's persistence key. */
export function newPropertyId(name: string, existingIds: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "property";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Display name for any property id — demo or user-created. Unknown ids echo
 *  the id itself (better than claiming to be the casino). */
export function propertyNameFor(id: string, userProperties: UserProperty[]): string {
  const demo = DEMOS.find((d) => d.id === id);
  if (demo) return demo.name;
  return userProperties.find((u) => u.id === id)?.name ?? id;
}

/** Key holding a user property's creation-time building — what "Reset this
 *  property" restores for a property that has no shipped demo to fall back to. */
export function pristineBuildingKey(propertyId: string): string {
  return `${buildingKey(propertyId)}:pristine`;
}

/** The building a new user property starts from: one floor, no geometry, and
 *  (when created from an image) the calibrated floorplan underlay to trace
 *  over. Origin is arbitrary — all authoring happens in local metres. */
export function starterBuilding(underlay: RasterUnderlay | null): Building {
  return {
    origin: [-98.5795, 39.8283],
    levels: [{ ordinal: 0, name: "Floor 1" }],
    units: [],
    openings: [],
    verticals: [],
    cameras: [],
    incidents: [],
    patrols: [],
    amenities: [],
    fixtures: [],
    footprints: [],
    underlays: underlay ? [underlay] : [],
  };
}
