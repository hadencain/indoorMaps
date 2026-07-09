/** Per-property building persistence keys. Pure + storage-injected so the key
 *  scheme and legacy migration are node-testable without jsdom. */
export const BUILDING_KEY_BASE = "indoormaps:building:v3";

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
