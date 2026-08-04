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
import { pointInRing, rankCamerasForPoint } from "../coverage";
import { polygonArea } from "../geo";
import { useVisibility } from "../ui/visibility";
import { WalkRenderer } from "./walk-renderer";
import type { MetreXY } from "../types";

/** Tiles per page. Past this the tiles are too small to read AND each one still
 *  costs a full scene draw — 16 tiles is 16x the geometry per frame. A floor
 *  with more cameras than this PAGES; it never silently truncates. The old
 *  behaviour sliced to 16 while the picker said "All on this floor", which on
 *  the casino floor claimed to be showing 16 of 300 and called it all. */
const PAGE_SIZE = 16;

/** One entry in the left rail. `room` groups are derived from the map every
 *  render (a camera moved into another space regroups itself); `saved` groups
 *  are the operator's own CameraView presets, whose order is route order. */
interface Wall {
  id: string;
  name: string;
  kind: "all" | "room" | "saved";
  cameraIds: string[];
}

export default function FeedWall() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setFeedWall = useStore((s) => s.setFeedWall);
  const addCameraView = useStore((s) => s.addCameraView);
  const [wallId, setWallId] = useState<string>("all");
  const [page, setPage] = useState(0);
  // Fullscreen a single camera. Double-click a tile to enter, double-click the
  // picture (or Esc) to come back to the wall you were on.
  const [soloId, setSoloId] = useState<string | null>(null);

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

  const scene = useMemo(() => build3dScene(building, ordinal), [building, ordinal]);

  // The rail: "All on this floor", then one wall per SPACE that actually
  // contains cameras, then the operator's saved presets. Room walls are derived
  // rather than stored so they can't go stale against the map — an operator who
  // has never authored a preset still gets a usable rail on any building, which
  // matters because no demo ships one.
  const walls = useMemo<Wall[]>(() => {
    const floorCams = building.cameras.filter((c) => c.ordinal === ordinal);
    const all: Wall = {
      id: "all",
      name: `All · ${building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`}`,
      kind: "all",
      cameraIds: floorCams.map((c) => c.id),
    };
    // SMALLEST containing space wins, not the first one in document order.
    // Spaces nest — a poker room sits inside the casino floor polygon — and
    // first-match-wins puts a camera in whichever of the two happens to be
    // earlier in the array, which is arbitrary and reads as a mislabelled wall.
    const floorUnits = building.units
      .filter((u) => u.ordinal === ordinal)
      .map((u) => ({ u, area: polygonArea(u.polygon) }))
      .sort((a, b) => a.area - b.area);
    const byUnit = new Map<string, string[]>();
    for (const c of floorCams) {
      const hit = floorUnits.find((x) => pointInRing(c.at, x.u.polygon));
      if (!hit) continue;
      const list = byUnit.get(hit.u.id);
      if (list) list.push(c.id);
      else byUnit.set(hit.u.id, [c.id]);
    }
    const rooms: Wall[] = [...byUnit].map(([unitId, ids]) => ({
      id: `room:${unitId}`,
      name: building.units.find((u) => u.id === unitId)?.name ?? unitId,
      kind: "room" as const,
      cameraIds: ids,
    }));
    rooms.sort((a, b) => b.cameraIds.length - a.cameraIds.length || a.name.localeCompare(b.name));
    const saved: Wall[] = views.map((v) => ({
      id: `saved:${v.id}`,
      name: v.name,
      kind: "saved",
      // A preset can name a camera on another floor or one since deleted; the
      // rail count must reflect what will actually render, not what was saved.
      cameraIds: v.cameraIds.filter((id) => floorCams.some((c) => c.id === id)),
    }));
    return [all, ...rooms, ...saved];
  }, [building.cameras, building.units, building.levels, ordinal, views]);

  const activeWall = walls.find((w) => w.id === wallId) ?? walls[0];

  // Which cameras are on the wall, in order. Preset order is preserved — it is
  // the order the operator built the route in, which is the whole point of a
  // preset (a delivery route's cameras are nowhere near each other).
  const wallCams = useMemo(() => {
    const byId = new Map(scene.cameras.map((c) => [c.id, c]));
    return (activeWall?.cameraIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => c != null);
  }, [scene.cameras, activeWall]);

  const pageCount = Math.max(1, Math.ceil(wallCams.length / PAGE_SIZE));
  // Switching walls can leave `page` past the end of a shorter one.
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => setPage(0), [wallId]);

  const poses = useMemo(() => {
    // Solo wins over everything: one pose renders through the normal full-canvas
    // path (renderTiles only engages above one pose), so it is a real fullscreen
    // view rather than a 1x1 tile.
    if (soloId) {
      const c = scene.cameras.find((x) => x.id === soloId);
      return c ? [c] : [];
    }
    // A subject OVERRIDES the wall: while following, the tiles are ordered by who
    // sees the subject best, so tile 1 is always the shot to be looking at and
    // the handoff between cameras happens by itself as the subject moves. Ranked
    // results are a shortlist, not a catalogue — top page only, no paging.
    if (subject) {
      return ranked
        .map((r) => scene.cameras.find((c) => c.id === r.cameraId))
        .filter((c): c is NonNullable<typeof c> => c != null)
        .slice(0, PAGE_SIZE);
    }
    return wallCams.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  }, [scene.cameras, soloId, subject, ranked, wallCams, safePage]);

  const soloCam = soloId ? scene.cameras.find((c) => c.id === soloId) ?? null : null;

  // Esc backs out one level: solo -> wall -> exit is left to the button, because
  // an operator hitting Esc to leave a fullscreen feed must not also drop the
  // whole wall.
  useEffect(() => {
    if (!soloId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSoloId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [soloId]);

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
      {/* Title bar. In solo it names the camera you are looking at — a fullscreen
          feed with no label is the one screen an operator must never mistake. */}
      <div className="feedwall-bar">
        <span className="feedwall-title">{soloCam ? "CAMERA" : "FEED WALL"}</span>
        {soloCam ? (
          <>
            <span className="feedwall-solo-name">{soloCam.name}</span>
            <span className="feedwall-solo-ctx">{activeWall?.name}</span>
            <span className="feedwall-count">double-click the picture or press Esc to go back</span>
            <button className="feedwall-follow" onClick={() => setSoloId(null)}>
              Back to wall
            </button>
          </>
        ) : (
          <>
            <span className="feedwall-wallname">{activeWall?.name ?? "—"}</span>
            {subject ? (
              <span className="feedwall-count">
                {poses.length} of {ranked.length} seeing the subject
              </span>
            ) : (
              <span className="feedwall-count">
                {wallCams.length === 0
                  ? "no cameras"
                  : `${safePage * PAGE_SIZE + 1}–${Math.min(wallCams.length, (safePage + 1) * PAGE_SIZE)} of ${wallCams.length}`}
              </span>
            )}
            {!subject && pageCount > 1 && (
              <span className="feedwall-pager">
                <button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} title="Previous page">
                  ‹
                </button>
                <span className="feedwall-pageno">
                  {safePage + 1}/{pageCount}
                </span>
                <button
                  onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                  disabled={safePage >= pageCount - 1}
                  title="Next page"
                >
                  ›
                </button>
              </span>
            )}
            <button
              className={subject ? "feedwall-follow on" : "feedwall-follow"}
              onClick={() => setSubject(null)}
              disabled={!subject}
              title="Clear the followed subject"
            >
              {subject ? "following · clear" : "drag on the plan to follow"}
            </button>
          </>
        )}
        <button className="feedwall-exit" onClick={() => setFeedWall(false)}>
          Exit wall
        </button>
      </div>

      <div className="feedwall-body">

      {/* LEFT RAIL: every wall this building can show, so switching from one
          room's cameras to another is one click and never a rebuild. */}
      <div className="feedwall-rail">
        <div className="feedwall-rail-head">Walls</div>
        {walls.map((w, i) => {
          const prev = walls[i - 1];
          const sep = !prev || prev.kind === w.kind ? null : w.kind === "room" ? "Rooms" : "Saved";
          return (
            <div key={w.id}>
              {sep && <div className="feedwall-rail-sep">{sep}</div>}
              <button
                className={`feedwall-rail-item${w.id === activeWall?.id ? " on" : ""}`}
                onClick={() => {
                  setWallId(w.id);
                  setSoloId(null);
                  setSubject(null);
                }}
                title={w.name}
              >
                <span className="fwr-name">{w.name}</span>
                <span className="fwr-n">{w.cameraIds.length}</span>
              </button>
            </div>
          );
        })}
        <button
          className="feedwall-rail-add"
          onClick={() => {
            const id = addCameraView(`Wall ${views.length + 1}`);
            setWallId(`saved:${id}`);
          }}
          title="Create an empty wall — add cameras to it from the camera inspector"
        >
          + New wall
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
        {/* A wall an operator selected that turns out to hold nothing must say so
            for the same reason the blind subject does — an empty black stage
            reads as a broken screen, not as an answer. */}
        {!subject && !soloId && poses.length === 0 && (
          <div className="feedwall-blind">
            <span className="feedwall-blind-tag">NO CAMERAS</span>
            <span className="feedwall-blind-sub">
              {activeWall?.kind === "saved"
                ? "this wall has no cameras on this floor yet"
                : "nothing is mounted in this space"}
            </span>
          </div>
        )}
        <div className="feedwall-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {poses.map((p, i) => {
            const score = scoreById.get(p.id);
            return (
              <div
                className={`feedwall-tile${subject && i === 0 ? " best" : ""}${soloId ? " solo" : ""}`}
                key={p.id}
                onDoubleClick={() => setSoloId(soloId ? null : p.id)}
                title={soloId ? "Double-click to go back to the wall" : `Double-click to fullscreen ${p.name}`}
              >
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
