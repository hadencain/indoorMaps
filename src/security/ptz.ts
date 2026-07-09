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

export const TILT_STEP_DEG = 5;
export const TILT_MIN = 12;
export const TILT_MAX = 80;
/** First tilt press on a legacy planar camera starts from here. */
export const TILT_DEFAULT = 35;

/** One tilt press. dir 1 = tilt DOWN (band pulls in close), -1 = tilt UP
 *  (band reaches farther, near-field blind hole grows). A camera that has
 *  never been tilted (undefined) starts from TILT_DEFAULT. */
export function tiltStep(tiltDeg: number | undefined, dir: 1 | -1): number {
  const base = tiltDeg ?? TILT_DEFAULT;
  return Math.min(TILT_MAX, Math.max(TILT_MIN, base + dir * TILT_STEP_DEG));
}
