// OPERATOR FEED WALL: N cameras on one screen, each showing what it actually
// sees. Lazily imported so three.js stays out of the initial chunk.
//
// ONE renderer with scissored viewports, not one renderer per tile. Each
// WebGLRenderer is its own GL context and browsers cap those around a dozen — a
// 4x4 wall of separate contexts would blow the cap and start silently dropping
// the oldest, which here would include the MapLibre map underneath. The tiles
// share one scene, so the world is built once regardless of wall size.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { build3dScene } from "../scene/scene-build";
import { rankCamerasForPoint } from "../coverage";
import { useVisibility } from "../ui/visibility";
import { WalkRenderer } from "./walk-renderer";
import type { MetreXY } from "../types";

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
  const { polys } = useVisibility();

  // FOLLOW MODE: a subject standing at a point on the floor. This is the drill an
  // operator actually runs — not "show me camera 12" but "who can see THIS", and
  // then keeping eyes on it as it moves. Null until the operator drops a subject.
  const [subject, setSubject] = useState<MetreXY | null>(null);

  // Best-view-first for the subject, derived live from the SAME occlusion-clipped
  // rings the 2D coverage layer draws — so the wall's ordering and the map's
  // green can never disagree about who sees what.
  const ranked = useMemo(() => {
    if (!subject) return [];
    const ringById = new Map(polys.map((p) => [p.cameraId, p.ring]));
    const cams = building.cameras.filter((c) => c.ordinal === ordinal);
    return rankCamerasForPoint(subject, cams, ringById);
  }, [subject, polys, building.cameras, ordinal]);

  // Which cameras are on the wall: an operator preset if one is picked,
  // otherwise the first cameras on this floor. Preset order is preserved — it is
  // the order the operator built the route in, which is the whole point of a
  // preset (a delivery route's cameras are nowhere near each other).
  const scene = useMemo(() => build3dScene(building, ordinal), [building, ordinal]);
  const poses = useMemo(() => {
    // A subject OVERRIDES the preset: while following, the wall is ordered by who
    // sees the subject best, so tile 1 is always the shot to be looking at and
    // the handoff between cameras happens by itself as the subject moves.
    if (subject) {
      return ranked
        .map((r) => scene.cameras.find((c) => c.id === r.cameraId))
        .filter((c): c is NonNullable<typeof c> => c != null)
        .slice(0, MAX_TILES);
    }
    const view = views.find((v) => v.id === viewId);
    if (view) {
      return view.cameraIds
        .map((id) => scene.cameras.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c != null)
        .slice(0, MAX_TILES);
    }
    return scene.cameras.slice(0, MAX_TILES);
  }, [scene, views, viewId, subject, ranked]);

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
  const scoreById = useMemo(
    () => new Map(ranked.map((r) => [r.cameraId, r.score])),
    [ranked],
  );

  // ---- plan strip -----------------------------------------------------------
  // Metre-space bbox of the floor, so the mini-plan maps 1:1 onto the same
  // coordinates rankCamerasForPoint consumes — no second projection to drift.
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of scene.floorPatches) {
      for (const [x, y] of p.ring) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    return { minX, minY, maxX, maxY };
  }, [scene.floorPatches]);

  const planRef = useRef<SVGSVGElement>(null);
  const dropSubject = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = planRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      // SVG y grows downward, metre y grows north — flip, or dragging up moves
      // the subject south and the ranking follows the wrong cameras.
      setSubject([
        bounds.minX + fx * (bounds.maxX - bounds.minX),
        bounds.maxY - fy * (bounds.maxY - bounds.minY),
      ]);
    },
    [bounds],
  );

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
        <button
          className={subject ? "feedwall-follow on" : "feedwall-follow"}
          onClick={() => setSubject(subject ? null : null)}
          disabled={!subject}
          title="Clear the followed subject"
        >
          {subject ? "following · clear" : "drag on the plan to follow"}
        </button>
        <button className="feedwall-exit" onClick={() => setFeedWall(false)}>
          Exit wall
        </button>
      </div>

      <div className="feedwall-stage">
        <div className="feedwall-canvas" ref={mountRef} />
        {/* A followed subject standing where nothing sees it must SAY so. The wall
            otherwise just empties, which reads as a broken screen rather than as
            the finding it actually is — "no camera covers this" is the single most
            valuable answer this tool gives. Stale tiles would be worse still:
            showing the last good feeds implies coverage that does not exist. */}
        {subject && poses.length === 0 && (
          <div className="feedwall-blind">
            <span className="feedwall-blind-tag">NO COVERAGE</span>
            <span className="feedwall-blind-sub">
              no camera on this floor sees {subject[0].toFixed(1)}, {subject[1].toFixed(1)} m
            </span>
          </div>
        )}
        {/* Label overlay mirrors the renderer's row-major tile order exactly, so a
            caption can never drift onto the wrong picture. */}
        <div className="feedwall-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {poses.map((p, i) => {
            const score = scoreById.get(p.id);
            return (
              <div className={`feedwall-tile${subject && i === 0 ? " best" : ""}`} key={p.id}>
                <span className="feedwall-tag">
                  {subject ? `${i + 1}. ` : ""}
                  {p.name}
                  {score != null ? ` · ${Math.round(score * 100)}%` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* PLAN STRIP: the index, not the subject. Drag anywhere on it to place a
          subject; the wall reorders live as it moves, which IS the handoff. */}
      <svg
        className="feedwall-plan"
        ref={planRef}
        viewBox={`${bounds.minX} ${-bounds.maxY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dropSubject(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) dropSubject(e);
        }}
      >
        {scene.floorPatches.map((p) => (
          <polygon
            key={p.id}
            className={`fwp-unit fwp-${p.category}`}
            points={p.ring.map(([x, y]) => `${x},${-y}`).join(" ")}
          />
        ))}
        {scene.cameras.map((c) => (
          <circle
            key={c.id}
            className={`fwp-cam${scoreById.has(c.id) ? " sees" : ""}`}
            cx={c.at[0]}
            cy={-c.at[1]}
            r={(bounds.maxX - bounds.minX) / 260}
          />
        ))}
        {subject && (
          <circle
            className="fwp-subject"
            cx={subject[0]}
            cy={-subject[1]}
            r={(bounds.maxX - bounds.minX) / 120}
          />
        )}
      </svg>
    </div>
  );
}
