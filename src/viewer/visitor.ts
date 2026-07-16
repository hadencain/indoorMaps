import type { Building, Unit } from "../types";

/**
 * Produces a public-viewer-safe building: strips all operator/security data
 * before it can ever leave the authoring app (the single-file export embeds
 * only this). Never mutates `b`.
 *
 * Drops every unit with `security === "restricted"` and cascades the drop to
 * its openings, its verticals (either endpoint), and its occupants —
 * stripping just the flag would leave a vault routable, so the units
 * themselves come out. Surviving units — including `secure` ones, since only
 * `restricted` is dropped — have `security` cleared (all become public).
 *
 * Result carries NO cameras/incidents/patrols/cameraViews/underlays/
 * vectorUnderlays (camera `streamRef` goes with them) and satisfies
 * `isValidBuildingShape`.
 */
export function toVisitorBuilding(b: Building): Building {
  const dropped = new Set(
    b.units.filter((u) => u.security === "restricted").map((u) => u.id),
  );

  const units: Unit[] = b.units
    .filter((u) => !dropped.has(u.id))
    .map((u) => {
      const copy: Unit = { ...u, polygon: u.polygon.map((p) => [...p] as typeof p) };
      delete copy.security;
      return copy;
    });

  return {
    origin: [...b.origin],
    levels: b.levels.map((l) => ({ ...l })),
    units,
    openings: b.openings
      .filter((o) => !dropped.has(o.unit))
      .map((o) => ({ ...o, at: [...o.at] as typeof o.at })),
    verticals: b.verticals.filter((v) => !dropped.has(v.a) && !dropped.has(v.b)).map((v) => ({ ...v })),
    // Operator-only data: never leaves the authoring app.
    cameras: [],
    occupants: (b.occupants ?? [])
      .filter((o) => !dropped.has(o.unitId))
      .map((o) => (o.anchor ? { ...o, anchor: [...o.anchor] as typeof o.anchor } : { ...o })),
    amenities: (b.amenities ?? []).map((a) => ({ ...a, at: [...a.at] as typeof a.at })),
    fixtures: (b.fixtures ?? []).map((f) => ({ ...f, polygon: f.polygon.map((p) => [...p] as typeof p) })),
    footprints: (b.footprints ?? []).map((f) => ({ ...f, polygon: f.polygon.map((p) => [...p] as typeof p) })),
    siteInfo: b.siteInfo ? { ...b.siteInfo, photos: [...b.siteInfo.photos] } : undefined,
    // incidents/patrols/cameraViews/underlays/vectorUnderlays: intentionally
    // omitted (all optional on Building) — visitors never see operator data.
  };
}
