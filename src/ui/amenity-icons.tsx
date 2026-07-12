import type { AmenityKind } from "../types";

/** Custom amenity pictograms — one hand-drawn stroke icon per kind, in the
 *  same 24×24 / round-cap grammar as the app's lucide iconography. Kept as
 *  markup strings (not components) because the map markers are imperative DOM
 *  (maplibre Marker elements); AmenityIcon wraps the same markup for React
 *  surfaces so the map and panels can never drift apart. */
const PATHS: Record<AmenityKind, string> = {
  // Twin figures (classic restroom signage).
  restroom:
    '<circle cx="7" cy="4.8" r="2"/><path d="M7 7.6v6.2"/><path d="M7 13.8 5 20M7 13.8 9 20"/><path d="M4.2 9.8h5.6"/>' +
    '<circle cx="17" cy="4.8" r="2"/><path d="M17 7.6l-2.7 7.2h5.4Z"/><path d="M15.7 14.8 15 20M18.3 14.8 19 20"/>',
  // Banknote.
  atm: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><circle cx="12" cy="12" r="3"/><path d="M5.8 9.2v5.6M18.2 9.2v5.6"/>',
  // Door + outbound arrow (emergency-exit grammar).
  exit: '<path d="M13.5 4H20v16h-6.5"/><path d="M3 12h10.5M9.5 8l4 4-4 4"/>',
  // i in a ring.
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M11.95 7.8h.1"/>',
  // Bold cross.
  firstaid: '<path d="M9.3 3.5h5.4v5.8h5.8v5.4h-5.8v5.8H9.3v-5.8H3.5V9.3h5.8Z"/>',
  // Ticket with perforation.
  ticketing:
    '<path d="M3.5 7.5h17v2.6a2 2 0 0 0 0 3.8v2.6h-17v-2.6a2 2 0 0 0 0-3.8Z"/><path d="M15 8v1.6M15 11.2v1.6M15 14.4V16"/>',
  // Fork & knife.
  dining: '<path d="M6 3v5.2a2.2 2.2 0 0 0 4.4 0V3"/><path d="M8.2 10.6V21"/><path d="M16.4 21V3c2.7 2.5 3.1 7.6.6 10.2l-.6.6"/>',
  // Martini.
  bar: '<path d="M5 5h14l-7 8.2Z"/><path d="M12 13.2V20M8.3 20h7.4"/><path d="M9.2 7.4h5.6"/>',
  // Hanger.
  coatcheck: '<path d="M12 8.6V7a2.1 2.1 0 1 0-2.1-2.1"/><path d="M12 8.6 3.4 15.2a1 1 0 0 0 .6 1.8h16a1 1 0 0 0 .6-1.8Z"/>',
  // Cigarette + smoke.
  smoking:
    '<rect x="3" y="14.5" width="14.5" height="3.5"/><path d="M14.3 14.5V18"/><path d="M17.6 8.2c1.4 1 1.5 2.4.5 3.4M20.3 5.8c2 1.5 2.1 4 .6 5.8"/>',
};

/** Badge fill per kind — the identity color. Also what the far-zoom declutter
 *  dot shows, so every kind stays tellable even collapsed. */
export const AMENITY_COLORS: Record<AmenityKind, string> = {
  restroom: "#4da3ff",
  atm: "#f2c14e",
  exit: "#43d675",
  info: "#00d7cd",
  firstaid: "#ff5c5c",
  ticketing: "#e8739e",
  dining: "#ff9042",
  bar: "#c77dff",
  coatcheck: "#b9c2cc",
  smoking: "#93a1b0",
};

export const AMENITY_LABELS: Record<AmenityKind, string> = {
  restroom: "Restroom", atm: "ATM", exit: "Exit", info: "Info", firstaid: "First aid",
  ticketing: "Ticketing", dining: "Dining", bar: "Bar", coatcheck: "Coat check", smoking: "Smoking",
};

/** Full inline-SVG markup for a kind (imperative DOM: map markers). */
export function amenityIconSvg(kind: AmenityKind, size = 12): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    PATHS[kind] +
    "</svg>"
  );
}

/** Badge fill + icon stroke for a kind. Dark stroke on every light fill;
 *  first aid inverts (white cross on red — the universal treatment). */
export function amenityBadgeStyle(kind: AmenityKind): { background: string; color: string } {
  return {
    background: AMENITY_COLORS[kind],
    color: kind === "firstaid" ? "#fff" : "#05070a",
  };
}

/** React badge: colored square chip with the kind's pictogram. */
export function AmenityIcon({ kind, size = 12 }: { kind: AmenityKind; size?: number }) {
  return (
    <span
      className={`amenity inline amenity-${kind}`}
      style={amenityBadgeStyle(kind)}
      // Static, app-authored markup — nothing user-controlled flows in here.
      dangerouslySetInnerHTML={{ __html: amenityIconSvg(kind, size) }}
    />
  );
}
