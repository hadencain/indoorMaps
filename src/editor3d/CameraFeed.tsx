// A camera's SYNTHETIC FEED: the venue model rendered from that camera's own
// pose. Lazily imported (like WalkView) so three.js stays out of the initial
// chunk and never reaches the single-file viewer.
//
// WHY THIS EXISTS: the app had the whole operator shell — PTZ pad, camera
// presets, device/status records, rankCamerasForPoint, a floating camera window —
// and a PLACEHOLDER where the picture goes. Every abstraction in it (a coverage
// cone, a DORI band, a blind spot) is an answer to "what can this camera see",
// asked and answered without ever looking through the camera. Since the venue
// already exists as geometry and the renderer already takes an arbitrary pose,
// the feed is that scene from that pose. No network, no stream — it is a
// simulated view, and `streamRef` remains the hook for a real one.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import { build3dScene } from "../scene/scene-build";
import { WalkRenderer } from "./walk-renderer";
import PtzJoystick from "./PtzJoystick";
import type { Camera } from "../types";

/** `ptzControl` opts this surface into the virtual joystick for PTZ cameras —
 *  the same crosshair/drag/wheel control the wall's fullscreen feed uses, so a
 *  camera is driven the same way wherever it is met. Live poses go straight to
 *  this feed's own renderer (no store write per frame, no scene rebuild); the
 *  aim commits once per gesture through setCameraAim, which also captures Home
 *  on the first move. */
export default function CameraFeed({ camera, ptzControl = false }: { camera: Camera; ptzControl?: boolean }) {
  const building = useStore((s) => s.building);
  const setCameraAim = useStore((s) => s.setCameraAim);
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WalkRenderer | null>(null);

  // One renderer per feed surface, created once. Feed mode parks the camera at a
  // pose rather than driving it from input — no pointer lock, no WASD, no picking.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const r = new WalkRenderer(el, { onPickCamera: () => {}, feed: true });
    // A feed tile is small and there may be several; the bloom + AO chain is not
    // worth its cost at this size, and Low keeps every extra WebGL context cheap.
    r.setQuality("low");
    rendererRef.current = r;
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Rebuild the world when the camera's FLOOR changes, and re-park the view
  // whenever the pose changes. Both come from build3dScene, so the feed sees the
  // same resolved pose (defaults applied, mount clamped) the 3D gizmo does —
  // there is no second interpretation of the camera record to drift out of sync.
  const scene = useMemo(() => build3dScene(building, camera.ordinal), [building, camera.ordinal]);
  const pose = useMemo(() => scene.cameras.find((c) => c.id === camera.id) ?? null, [scene, camera.id]);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setScene(scene);
    r.setFeedPose(pose);
  }, [scene, pose]);

  return (
    <div className="camera-feed live">
      <div className="camera-feed-canvas" ref={mountRef} />
      {ptzControl && camera.kind === "ptz" && pose && (
        <PtzJoystick
          pose={pose}
          onLive={(live) => rendererRef.current?.setFeedPose(live)}
          onCommit={(patch) => setCameraAim(camera.id, patch)}
        />
      )}
      <div className="camera-feed-scan" aria-hidden />
      <div className="camera-feed-corner">
        {camera.id}
        {camera.status && camera.status !== "online" ? ` · ${camera.status.toUpperCase()}` : ""}
      </div>
    </div>
  );
}
