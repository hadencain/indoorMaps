export type Unit = "m" | "ft";

const M_TO_FT = 3.280839895;
const M2_TO_FT2 = 10.76391042;

/** Format a metre length in the chosen unit. */
export function formatLength(metres: number, unit: Unit): string {
  return unit === "ft"
    ? `${(metres * M_TO_FT).toFixed(1)} ft`
    : `${metres.toFixed(1)} m`;
}

/** Format a square-metre area in the chosen unit. */
export function formatArea(m2: number, unit: Unit): string {
  return unit === "ft"
    ? `${Math.round(m2 * M2_TO_FT2).toLocaleString()} ft²`
    : `${Math.round(m2).toLocaleString()} m²`;
}
