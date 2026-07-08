import type { Camera } from "../../types";

/** Inert timestamp — the feed never streams (no network, ever). */
const FEED_TIME = "00:00:00";

/**
 * Inert "live feed" placeholder. Presents as clickable but performs NO network
 * I/O — ever. Shared by CameraPanel (authoring) and InspectPanel (click-to-
 * camera preview) so the preview surface is identical in both. The live-console
 * app swaps this scaffold for a real stream resolved from `camera.streamRef`.
 */
export default function FeedPlaceholder({ camera }: { camera: Camera }) {
  return (
    <div
      className="camera-feed"
      role="button"
      tabIndex={0}
      title="Live feed unavailable"
      onClick={() => {
        /* TODO: live feed — intentionally a no-op stub (no network). */
      }}
    >
      <div className="camera-feed-scan" aria-hidden />
      <div className="camera-feed-label">NO SIGNAL · OFFLINE</div>
      <div className="camera-feed-corner">
        {camera.id} · {FEED_TIME}
      </div>
    </div>
  );
}
