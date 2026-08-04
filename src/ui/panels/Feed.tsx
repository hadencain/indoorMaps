import { Suspense, lazy } from "react";
import type { Camera } from "../../types";
import FeedPlaceholder from "./FeedPlaceholder";

// three.js loads only when a feed surface is actually mounted.
const CameraFeed = lazy(() => import("../../editor3d/CameraFeed"));

/**
 * THE feed surface. Every place that shows a camera preview goes through here —
 * the floating camera window, the camera panel, the inspector, and both operator
 * panels — so a camera looks the same wherever you meet it.
 *
 * This exists because the synthetic feed was first wired into the camera window
 * ALONE, which left four other surfaces still rendering "NO SIGNAL · OFFLINE".
 * The result was worse than not shipping it: the same camera showed a live view
 * in one panel and a dead one in another, which reads as a broken app rather
 * than a partial feature.
 *
 * A device that is NOT working keeps the inert placeholder. That is deliberate
 * and matches how `status` is defined — absent means unknown, never "online" —
 * so an unaudited or failed camera must never present a picture.
 */
export default function Feed({ camera, ptzControl = false }: { camera: Camera; ptzControl?: boolean }) {
  if (camera.status === "offline" || camera.status === "fault" || camera.status === "planned") {
    return <FeedPlaceholder camera={camera} />;
  }
  return (
    <Suspense fallback={<FeedPlaceholder camera={camera} />}>
      <CameraFeed camera={camera} ptzControl={ptzControl} />
    </Suspense>
  );
}
