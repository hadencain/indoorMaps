import type { Building } from "../types";
// Demo venue: "The Basement" — a small underground music club (v1, hand-authored,
// no generator, no coverage-planner engine). Single floor, ~40x25m envelope:
// street vestibule + queue rail out front, a box-office window, one big main
// room with a small stage at the back, a sound booth, a bar + backbar/keg
// storage, a kitchen closet, two restrooms, an office (safe, `security:
// "secure"`) and a greenroom off a short backstage corridor, a load-in alley
// door, and a smoking patio tucked behind the back wall. Intentionally tiny
// (13 hand-placed cameras, not the casino's engine-generated plant) — proves
// the authoring tool and the camera/coverage math read cleanly at club scale,
// not just at the casino's size. Footprint is bumped out behind the back wall
// to include the patio notch, so the patio (and its camera) sit inside the
// measured floor rather than off in undefined space.
export const venueSmallBuilding: Building = {
  origin: [-115.1228, 36.1147],
  levels: [{ ordinal: 0, name: "Main" }],
  units: [
    { id: "restroom-1", ordinal: 0, name: "Restroom A", category: "restroom", polygon: [[0,0],[6,0],[6,5],[0,5]] },
    { id: "vestibule", ordinal: 0, name: "Vestibule", category: "lobby", polygon: [[6,0],[24,0],[24,5],[6,5]] },
    { id: "boxoffice", ordinal: 0, name: "Box Office", category: "retail", polygon: [[24,0],[30,0],[30,5],[24,5]] },
    { id: "restroom-2", ordinal: 0, name: "Restroom B", category: "restroom", polygon: [[30,0],[40,0],[40,5],[30,5]] },
    { id: "mainroom", ordinal: 0, name: "Main Room", category: "room", polygon: [[0,5],[32,5],[32,19],[14,19],[14,25],[0,25]] },
    { id: "bar", ordinal: 0, name: "Bar", category: "room", polygon: [[32,5],[40,5],[40,11],[32,11]] },
    { id: "backbar", ordinal: 0, name: "Backbar Storage", category: "storage", polygon: [[32,11],[40,11],[40,19],[32,19]] },
    { id: "corridor", ordinal: 0, name: "Backstage Corridor", category: "corridor", polygon: [[14,19],[24,19],[24,25],[14,25]] },
    { id: "office", ordinal: 0, name: "Office", category: "office", security: "secure", polygon: [[24,19],[32,19],[32,25],[24,25]] },
    { id: "kitchen", ordinal: 0, name: "Kitchen Closet", category: "storage", polygon: [[32,19],[40,19],[40,22],[32,22]] },
    { id: "soundbooth", ordinal: 0, name: "Sound Booth", category: "room", polygon: [[32,22],[36,22],[36,25],[32,25]] },
    { id: "greenroom", ordinal: 0, name: "Greenroom", category: "room", polygon: [[36,22],[40,22],[40,25],[36,25]] },
    { id: "patio", ordinal: 0, name: "Smoking Patio", category: "outside", polygon: [[16,25],[26,25],[26,31],[16,31]] },
  ],
  openings: [
    { id: "d-1", unit: "vestibule", at: [15,0], kind: "entrance" },
    { id: "d-2", unit: "boxoffice", at: [24,2.5] },
    { id: "d-3", unit: "restroom-1", at: [6,2.5] },
    { id: "d-4", unit: "restroom-2", at: [30,2.5] },
    { id: "d-5", unit: "mainroom", at: [15,5] },
    { id: "d-6", unit: "bar", at: [32,8] },
    { id: "d-7", unit: "backbar", at: [32,15] },
    { id: "d-8", unit: "corridor", at: [14,22] },
    { id: "d-9", unit: "office", at: [24,22] },
    { id: "d-10", unit: "kitchen", at: [32,20.5] },
    { id: "d-11", unit: "soundbooth", at: [32,23.5] },
    { id: "d-12", unit: "greenroom", at: [36,22] },
    { id: "d-13", unit: "corridor", at: [19,25], kind: "entrance" },
  ],
  verticals: [],
  footprints: [
    { ordinal: 0, polygon: [[0,0],[40,0],[40,25],[26,25],[26,31],[16,31],[16,25],[0,25]] },
  ],
  amenities: [
    { id: "am-1", ordinal: 0, at: [3,2.5], kind: "restroom" },
    { id: "am-2", ordinal: 0, at: [35,2.5], kind: "restroom" },
    { id: "am-3", ordinal: 0, at: [36,8], kind: "bar" },
    { id: "am-4", ordinal: 0, at: [15,1], kind: "exit" },
    { id: "am-5", ordinal: 0, at: [19,24.5], kind: "exit" },
    { id: "am-6", ordinal: 0, at: [21,28], kind: "smoking" },
  ],
  fixtures: [
    { id: "fix-1", ordinal: 0, kind: "counter", polygon: [[11,1],[19,1],[19,1.4],[11,1.4]] },
    { id: "fix-2", ordinal: 0, kind: "stage", polygon: [[4,15],[18,15],[18,19],[4,19]] },
    { id: "fix-3", ordinal: 0, kind: "bar", polygon: [[33,7],[39,7],[39,8],[33,8]] },
  ],
  patrols: [
    { id: "patrol-0", ordinal: 0, name: "Basement Sweep", points: [[15,2.5],[15,7],[10,12],[36,8],[20,22],[26,22]] },
  ],
  cameras: [
    // Hand-placed, 13 cameras — no coverage-planner engine (unlike the casino's
    // generated plant). Each cam is a corner- or FOH-style mount with a real
    // aim, sized to the room it watches.
    { id: "cam-0-1", ordinal: 0, at: [7.6,0.6], heading: 14, fovDeg: 100, rangeM: 16, kind: "ptz", name: "Entry · PTZ 01", streamRef: "rtsp://10.7.10.1/main" },
    { id: "cam-0-2", ordinal: 0, at: [22.4,4.4], heading: 211, fovDeg: 95, rangeM: 12, kind: "ptz", name: "Entry · PTZ 02", streamRef: "rtsp://10.7.10.2/main" },
    { id: "cam-0-3", ordinal: 0, at: [1.4,6.6], heading: 20, fovDeg: 90, rangeM: 18, kind: "ptz", name: "Main Room · PTZ 01", streamRef: "rtsp://10.7.10.3/main" },
    { id: "cam-0-4", ordinal: 0, at: [30.6,6.6], heading: 160, fovDeg: 90, rangeM: 18, kind: "ptz", name: "Main Room · PTZ 02", streamRef: "rtsp://10.7.10.4/main" },
    { id: "cam-0-5", ordinal: 0, at: [30.6,17.4], heading: 200, fovDeg: 90, rangeM: 18, kind: "ptz", name: "Main Room · PTZ 03", streamRef: "rtsp://10.7.10.5/main" },
    { id: "cam-0-6", ordinal: 0, at: [1.4,17.4], heading: 340, fovDeg: 90, rangeM: 18, kind: "ptz", name: "Main Room · PTZ 04", streamRef: "rtsp://10.7.10.6/main" },
    { id: "cam-0-7", ordinal: 0, at: [32.6,5.6], heading: 35, fovDeg: 95, rangeM: 10, kind: "ptz", name: "Bar · PTZ 01", streamRef: "rtsp://10.7.10.7/main" },
    { id: "cam-0-8", ordinal: 0, at: [32.6,11.6], heading: 45, fovDeg: 95, rangeM: 14, kind: "ptz", name: "Backbar · PTZ 01", streamRef: "rtsp://10.7.10.8/main" },
    { id: "cam-0-9", ordinal: 0, at: [24.6,7.6], heading: 145, fovDeg: 85, rangeM: 18, kind: "ptz", name: "Stage · PTZ 01", streamRef: "rtsp://10.7.10.9/main" },
    { id: "cam-0-10", ordinal: 0, at: [15.4,20.6], heading: 25, fovDeg: 100, rangeM: 10, kind: "ptz", name: "Backstage · PTZ 01", streamRef: "rtsp://10.7.10.10/main" },
    { id: "cam-0-11", ordinal: 0, at: [25.4,20.6], heading: 0, fovDeg: 360, rangeM: 10, kind: "dome", name: "Office · DOME 01", streamRef: "rtsp://10.7.10.11/main" },
    { id: "cam-0-12", ordinal: 0, at: [15.4,23.4], heading: 30, fovDeg: 100, rangeM: 12, kind: "ptz", name: "Alley Door · PTZ 01", streamRef: "rtsp://10.7.10.12/main" },
    { id: "cam-0-13", ordinal: 0, at: [17.6,26.6], heading: 22, fovDeg: 90, rangeM: 10, kind: "ptz", name: "Patio · PTZ 01", streamRef: "rtsp://10.7.10.13/main" },
  ],
};
