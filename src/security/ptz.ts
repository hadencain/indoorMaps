/** PTZ step math for the floating camera window (pure, UI-free).
 *  Pan/zoom mutate the REAL camera (heading / fovDeg / rangeM) via the store,
 *  so the map cone sweeps live and coverage stays honest — accepted trade-off:
 *  operator PTZ permanently changes the authored aim. */

export const PAN_STEP_DEG = 5;
export const FOV_MIN = 20;
export const FOV_MAX = 120;
export const ZOOM_FACTOR = 1.25;

/** One pan press: ±5°, normalized to [0, 360). Matches rotateCamera's wrap. */
export function panStep(heading: number, dir: 1 | -1): number {
  return (((heading + dir * PAN_STEP_DEG) % 360) + 360) % 360;
}

/** One zoom press. dir 1 = zoom in (narrower FOV, longer reach). Range scales
 *  by sqrt of the ACTUAL fov ratio so partial clamps scale partially and
 *  in-then-out round-trips exactly. */
export function zoomStep(
  fovDeg: number,
  rangeM: number,
  dir: 1 | -1,
): { fovDeg: number; rangeM: number } {
  const target = dir === 1 ? fovDeg / ZOOM_FACTOR : fovDeg * ZOOM_FACTOR;
  const next = Math.min(FOV_MAX, Math.max(FOV_MIN, target));
  if (next === fovDeg) return { fovDeg, rangeM };
  return { fovDeg: next, rangeM: rangeM * Math.sqrt(fovDeg / next) };
}
