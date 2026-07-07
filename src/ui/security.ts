// Access-control (security level) presentation helpers. Pure — no React.

import type { SecurityLevel, Unit } from "../types";

/** A unit's effective security level. Absent ⇒ "public". */
export function securityOf(u: Unit): SecurityLevel {
  return u.security ?? "public";
}

export const SECURITY_LEVELS: readonly SecurityLevel[] = ["public", "secure", "restricted"];

export const SECURITY_LABELS: Record<SecurityLevel, string> = {
  public: "Public",
  secure: "Secure",
  restricted: "Restricted",
};

/** Accent color per level (amber = secure, red = restricted, dim = public). */
export const SECURITY_COLORS: Record<SecurityLevel, string> = {
  public: "#8a96a5",
  secure: "#f2c14e",
  restricted: "#ff5c5c",
};
