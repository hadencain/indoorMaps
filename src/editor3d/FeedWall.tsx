// OPERATOR FEED WALL: N cameras on one screen, each showing what it actually
// sees. Lazily imported so three.js stays out of the initial chunk.
//
// ONE renderer with scissored viewports, not one renderer per tile. Each
// WebGLRenderer is its own GL context and browsers cap those around a dozen — a
// 4x4 wall of separate contexts would blow the cap and start silently dropping
// the oldest, which here would include the MapLibre map underneath. The tiles
// share one scene, so the world is built once regardless of wall size.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { build3dScene } from "../scene/scene-build";
import { WalkRenderer } from "./walk-renderer";

/** Wall size cap. Past this the tiles are too small to read AND each one still
 *  costs a full scene draw — 16 tiles is 16x the geometry per frame. */
const MAX_TILES = 16;

export default function FeedWall() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setFeedWall = useStore((s) => s.setFeedWall);
  const [viewId, setViewId] = useState<string | null>(null);

  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WalkRenderer | null>(null);

  const views = building.cameraViews ?? [];

  // Which cameras are on the wall: an operator preset if one is picked,
  // otherwise the first cameras on this floor. Preset order is preserved — it is
  // the order the operator built the route in, which is the whole point of a
  // preset (a delivery route's cameras are nowhere near each other).
  const scene = useMemo(() => build3dScene(building, ordinal), [building, ordinal]);
  const poses = useMemo(() => {
    const view = views.find((v) => v.id === viewId);
    if (view) {
      return view.cameraIds
        .map((id) => scene.cameras.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c != null)
        .slice(0, MAX_TILES);
    }
    return scene.cameras.slice(0, MAX_TILES);
  }, [scene, views, viewId]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const r = new WalkRenderer(el, { onPickCamera: () => {}, feed: true });
    r.setQuality("low"); // tiles are small and each one is a full scene draw
    rendererRef.current = r;
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setScene(scene);
    r.setFeedPoses(poses);
  }, [scene, poses]);

  const cols = Math.ceil(Math.sqrt(Math.max(1, poses.length)));

  return (
    <div className="feedwall">
      <div className="feedwall-bar">
        <span className="feedwall-title">FEED WALL</span>
        <select value={viewId ?? ""} onChange={(e) => setViewId(e.target.value || null)}>
          <option value="">All on this floor ({Math.min(scene.cameras.length, MAX_TILES)})</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.cameraIds.length})
            </option>
          ))}
        </select>
        <span className="feedwall-count">
          {poses.length} {poses.length === 1 ? "camera" : "cameras"}
        </span>
        <button className="feedwall-exit" onClick={() => setFeedWall(false)}>
          Exit wall
        </button>
      </div>

      <div className="feedwall-stage">
        <div className="feedwall-canvas" ref={mountRef} />
        {/* Label overlay mirrors the renderer's row-major tile order exactly, so a
            caption can never drift onto the wrong picture. */}
        <div className="feedwall-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {poses.map((p) => (
            <div className="feedwall-tile" key={p.id}>
              <span className="feedwall-tag">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
