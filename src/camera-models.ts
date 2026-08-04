/** CAMERA MODEL CATALOGUE (pure, UI-free).
 *
 *  Why this exists: the onboarding spike measured that camera SPEC, not camera
 *  placement, is where a plant stays unrated — auto-suggest placed 12 cameras
 *  in two clicks, but only the one hand-edited camera had a resolution, so
 *  DORI (the number that beats a 2D cone diagram) was blank across the floor.
 *  One pick per camera fills fovDeg + resolutionMP + kind, and range is then
 *  DERIVED from those specs via the app's own DORI math rather than copied
 *  from a brochure — the drawn cone reaches exactly as far as the camera can
 *  still "observe", so the map never claims coverage the optics can't rate.
 *
 *  Specs are the published wide-end horizontal FOV and sensor MP for common
 *  integrator-stock lines. FOV for varifocal lenses is the WIDE end — the
 *  honest default for a coverage tool; narrowing is an aiming decision.
 *  PTZ entries carry their wide-end FOV too (the joystick's zoom takes it from
 *  there). Domes here means fisheye/360 panoramic mounts (fovDeg 360 by app
 *  convention: "sees all around", density math clamps to 179).
 */

import type { CameraKind } from "./types";
import { DORI_PX_PER_M } from "./coverage";

export interface CameraModelSpec {
  make: string;
  model: string;
  kind: CameraKind;
  /** Horizontal FOV, degrees, wide end. 360 for panoramic domes. */
  fovDeg: number;
  resolutionMP: number;
}

export const CAMERA_MODELS: readonly CameraModelSpec[] = [
  // ---- fixed (bullet / turret) ----
  { make: "Axis", model: "P3265-LVE", kind: "fixed", fovDeg: 100, resolutionMP: 2 },
  { make: "Axis", model: "P1465-LE", kind: "fixed", fovDeg: 109, resolutionMP: 2 },
  { make: "Axis", model: "Q1656-LE", kind: "fixed", fovDeg: 114, resolutionMP: 4 },
  { make: "Hikvision", model: "DS-2CD2087G2-LU", kind: "fixed", fovDeg: 102, resolutionMP: 8 },
  { make: "Hikvision", model: "DS-2CD2347G2-LU", kind: "fixed", fovDeg: 109, resolutionMP: 4 },
  { make: "Hanwha", model: "XNO-8083R", kind: "fixed", fovDeg: 92, resolutionMP: 6 },
  { make: "Hanwha", model: "QNO-C8083R", kind: "fixed", fovDeg: 100, resolutionMP: 5 },
  { make: "Bosch", model: "DINION 5100i IR", kind: "fixed", fovDeg: 106, resolutionMP: 5 },
  { make: "Uniview", model: "IPC3618SB-ADF28KM", kind: "fixed", fovDeg: 112, resolutionMP: 8 },
  // ---- panoramic domes (360 overhead) ----
  { make: "Axis", model: "M3077-PLVE", kind: "dome", fovDeg: 360, resolutionMP: 6 },
  { make: "Axis", model: "M4318-PLVE", kind: "dome", fovDeg: 360, resolutionMP: 12 },
  { make: "Hikvision", model: "DS-2CD2955G0-ISU", kind: "dome", fovDeg: 360, resolutionMP: 5 },
  { make: "Hanwha", model: "XNF-9010RV", kind: "dome", fovDeg: 360, resolutionMP: 12 },
  // ---- PTZ ----
  { make: "Axis", model: "Q6135-LE", kind: "ptz", fovDeg: 66, resolutionMP: 2 },
  { make: "Axis", model: "P5676-LE", kind: "ptz", fovDeg: 63, resolutionMP: 4 },
  { make: "Hikvision", model: "DS-2DE7A425IW-AEB", kind: "ptz", fovDeg: 59, resolutionMP: 4 },
  { make: "Hanwha", model: "XNP-C9310R", kind: "ptz", fovDeg: 61, resolutionMP: 8 },
  { make: "Bosch", model: "AUTODOME 7100i", kind: "ptz", fovDeg: 57, resolutionMP: 4 },
] as const;

/** Display label, also the value stored in Camera.model. */
export function modelLabel(m: CameraModelSpec): string {
  return `${m.make} ${m.model}`;
}

export function findModel(label: string): CameraModelSpec | undefined {
  return CAMERA_MODELS.find((m) => modelLabel(m) === label);
}

/** Coverage range for a spec: the farthest distance the camera still rates
 *  DORI "observe" (62 px/m). Same math as coverage.ts pxPerMetreAt, inlined on
 *  the spec so a not-yet-applied model can be ranged. Domes clamp to 179° like
 *  the density math does, which honestly shortens their reach. Capped at 60 m —
 *  beyond that a drawn cone stops being a plan and starts being a boast. */
export function modelRangeM(m: CameraModelSpec): number {
  const k = Math.sqrt((m.resolutionMP * 1e6) / (16 * 9));
  const widthPx = 16 * k;
  const fov = m.kind === "dome" || m.fovDeg >= 360 ? 179 : Math.min(179, Math.max(1, m.fovDeg));
  const pxPerMAt1 = widthPx / (2 * Math.tan((fov * Math.PI) / 360));
  return Math.min(60, Math.round((pxPerMAt1 / DORI_PX_PER_M.observe) * 10) / 10);
}
