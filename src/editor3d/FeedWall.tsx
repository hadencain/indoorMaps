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
import PtzJoystick from "./PtzJoystick";
import { distM } from "../geo";
import { WALK_MPS } from "../route-smooth";
import type { MetreXY } from "../types";

/** Advance the shadow subject at most every this many metres of guard travel.
 *  Each step re-ranks every camera on the floor (same cost as one drag tick on
 *  the plan strip); per-frame would burn that 60x/sec for sub-pixel movement.
 *  Matches PROBE_STEP_M in the map's PatrolPlayback. */
const SHADOW_STEP_M = 1.2;

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
  const addCameraToView = useStore((s) => s.addCameraToView);
  const removeCameraFromView = useStore((s) => s.removeCameraFromView);
  const moveCameraInView = useStore((s) => s.moveCameraInView);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const ensureCameraNumbers = useStore((s) => s.ensureCameraNumbers);
  const setCameraAim = useStore((s) => s.setCameraAim);
  const saveCameraPreset = useStore((s) => s.saveCameraPreset);
  const deleteCameraPreset = useStore((s) => s.deleteCameraPreset);
  const recallCameraPreset = useStore((s) => s.recallCameraPreset);
  /** Digits typed for a camera call-up, VMS style: 4 2 Enter. */
  const [dial, setDial] = useState("");
  const [dialMsg, setDialMsg] = useState<string | null>(null);
  /** Preset naming: "new" = the save-input is open, else a preset id being
   *  renamed. The window keypad handler skips INPUT targets, so typing a name
   *  never dials a camera. */
  const [namingId, setNamingId] = useState<"new" | string | null>(null);
  const renameCameraPreset = useStore((s) => s.renameCameraPreset);
  const [wallId, setWallId] = useState<string>("all");
  const [page, setPage] = useState(0);
  /** Saved-wall editor: membership managed from INSIDE the wall, so "+ New
   *  wall" stops dead-ending into the camera inspector. */
  const [editingWall, setEditingWall] = useState(false);
  const [editFilter, setEditFilter] = useState("");
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

  // PATROL SHADOWING: the same subject, driven along a guard route instead of
  // by the operator's hand. The wall reorders as the guard walks, so the
  // camera-to-camera handoff a tour requires happens by itself — and a stretch
  // of route nothing covers shows as NO COVERAGE, which is a finding about the
  // patrol, not a rendering failure.
  const [shadowId, setShadowId] = useState<string | null>(null);
  const shadowPatrol = shadowId
    ? (building.patrols ?? []).find((p) => p.id === shadowId && p.ordinal === ordinal) ?? null
    : null;

  useEffect(() => {
    if (!shadowPatrol || shadowPatrol.points.length < 2) return;
    const pts = shadowPatrol.points;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total <= 0) return;
    let dist = 0;
    let last = performance.now();
    let sinceStep = Infinity; // place the subject immediately on start
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      dist += WALK_MPS * dt;
      sinceStep += WALK_MPS * dt;
      if (sinceStep < SHADOW_STEP_M) return;
      sinceStep = 0;
      // Ping-pong: out and back, like a real tour on an open path.
      const lap = dist % (2 * total);
      const d = lap <= total ? lap : 2 * total - lap;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1];
      const f = seg > 0 ? (d - cum[i - 1]) / seg : 0;
      setSubject([
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
      ]);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shadowPatrol]);

  // A floor switch orphans the route (patrols are single-floor); stop cleanly
  // rather than shadowing a path that is no longer on screen.
  useEffect(() => {
    if (shadowId && !shadowPatrol) {
      setShadowId(null);
      setSubject(null);
    }
  }, [shadowId, shadowPatrol]);

  const stopShadow = useCallback(() => {
    setShadowId(null);
    setSubject(null);
  }, []);

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
  const editableViewId = activeWall?.id.startsWith("saved:") ? activeWall.id.slice(6) : null;
  const editableView = editableViewId ? views.find((v) => v.id === editableViewId) ?? null : null;
  useEffect(() => {
    setEditingWall(false);
    setEditFilter("");
  }, [wallId]);

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
  const numberById = useMemo(
    () => new Map(building.cameras.map((c) => [c.id, c.opNumber])),
    [building.cameras],
  );

  // Numbers are assigned once, when the operator surface that uses them opens.
  useEffect(() => { ensureCameraNumbers(); }, [ensureCameraNumbers]);

  const soloCamRecord = soloId ? building.cameras.find((c) => c.id === soloId) ?? null : null;
  const presets = useMemo(
    () => [...(soloCamRecord?.presets ?? [])].sort((a, b) => a.slot - b.slot),
    [soloCamRecord],
  );

  /** Call up a camera by its site-wide number, crossing floors if needed. */
  const callUp = useCallback(
    (num: number) => {
      const cam = building.cameras.find((c) => c.opNumber === num);
      if (!cam) {
        setDialMsg(`No camera ${num}`);
        return;
      }
      if (cam.ordinal !== ordinal) setOrdinal(cam.ordinal);
      setShadowId(null);
      setSubject(null);
      setSoloId(cam.id);
      setDialMsg(`${num} · ${cam.name}`);
    },
    [building.cameras, ordinal, setOrdinal],
  );

  // Operator keypad. Digits dial, Enter calls up, Esc backs out one level at a
  // time (dial first, then fullscreen — never the whole wall, or an operator
  // clearing a mistyped number would lose the screen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

      // Ctrl+<1-9> recalls a preset slot; slot 1 is always Home.
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        if (!soloId) return;
        e.preventDefault();
        e.stopPropagation();
        const slot = Number(e.key);
        const p = (building.cameras.find((c) => c.id === soloId)?.presets ?? []).find((x) => x.slot === slot);
        if (!p) { setDialMsg(`No preset ${slot}`); return; }
        recallCameraPreset(soloId, slot);
        setDialMsg(`${slot} · ${p.name}`);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // `H` = Home. Ctrl+1 is what an operator asks for, but Chrome reserves
      // Ctrl+1..8 for tab switching and a page cannot always intercept it, so
      // Home also has a plain key that nothing can swallow.
      if ((e.key === "h" || e.key === "H") && soloId) {
        e.preventDefault();
        const p = (building.cameras.find((c) => c.id === soloId)?.presets ?? []).find((x) => x.slot === 1);
        if (!p) { setDialMsg("No home set yet"); return; }
        recallCameraPreset(soloId, 1);
        setDialMsg("1 · Home");
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDialMsg(null);
        setDial((d) => (d + e.key).slice(0, 5));
        return;
      }
      if (e.key === "Backspace" && dial) {
        e.preventDefault();
        setDial((d) => d.slice(0, -1));
        return;
      }
      if (e.key === "Enter" && dial) {
        e.preventDefault();
        callUp(Number(dial));
        setDial("");
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        if (dial) setDial("");
        else if (soloId) setSoloId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [soloId, dial, callUp, building.cameras, recallCameraPreset]);

  // The call-up readout is a confirmation, not a log — let it fade.
  useEffect(() => {
    if (!dialMsg) return;
    const t = window.setTimeout(() => setDialMsg(null), 2600);
    return () => window.clearTimeout(t);
  }, [dialMsg]);

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
      setShadowId(null); // a hand on the plan takes over from the guard route
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
            {soloCamRecord?.opNumber != null && (
              <span className="feedwall-num solo">{soloCamRecord.opNumber}</span>
            )}
            <span className="feedwall-solo-name">{soloCam.name}</span>
            <span className="feedwall-solo-ctx">{activeWall?.name}</span>
            <span className="feedwall-count">
              type a number + Enter to call up · Esc to go back
            </span>
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
            {editableView && !subject && (
              <button
                className={editingWall ? "feedwall-follow on" : "feedwall-follow"}
                onClick={() => setEditingWall((v) => !v)}
                title="Add or remove this wall's cameras"
              >
                {editingWall ? "done editing" : "edit wall"}
              </button>
            )}
            <button
              className={subject ? "feedwall-follow on" : "feedwall-follow"}
              onClick={stopShadow}
              disabled={!subject}
              title={shadowPatrol ? "Stop shadowing the patrol" : "Clear the followed subject"}
            >
              {shadowPatrol
                ? `shadowing ${shadowPatrol.name} · stop`
                : subject
                  ? "following · clear"
                  : "drag on the plan to follow"}
            </button>
          </>
        )}
        {/* In operator mode the wall IS the mode, so leaving it means leaving
            the mode (back to the Display map) — setFeedWall(false) alone would
            strand a wall-less "operator" mode with nothing on it. */}
        <button
          className="feedwall-exit"
          onClick={() => (mode === "operator" ? setMode("display") : setFeedWall(false))}
        >
          {mode === "operator" ? "To map" : "Exit wall"}
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
                  setShadowId(null);
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

        {/* SHADOW A PATROL: the wall follows the guard route, handing off
            camera to camera by itself. Single-floor routes, current floor. */}
        {(building.patrols ?? []).some((p) => p.ordinal === ordinal) && (
          <>
            <div className="feedwall-rail-sep">Shadow patrol</div>
            {(building.patrols ?? [])
              .filter((p) => p.ordinal === ordinal)
              .map((p) => (
                <button
                  key={p.id}
                  className={`feedwall-rail-item${p.id === shadowId ? " on" : ""}`}
                  onClick={() => {
                    if (p.id === shadowId) {
                      stopShadow();
                    } else {
                      setSoloId(null);
                      setShadowId(p.id);
                      setDialMsg(`shadowing ${p.name}`);
                    }
                  }}
                  title={p.id === shadowId ? "Stop shadowing" : `Shadow ${p.name} — the wall follows the guard`}
                >
                  <span className="fwr-name">{p.id === shadowId ? "◼ " : "▶ "}{p.name}</span>
                  <span className="fwr-n">{p.points.length}pt</span>
                </button>
              ))}
          </>
        )}

        {/* INCIDENT RECALL: click an incident and the wall reorders to the
            cameras that see that spot — i.e. the ones whose footage to pull.
            All floors listed; recalling one on another floor switches to it. */}
        {(building.incidents ?? []).length > 0 && (
          <>
            <div className="feedwall-rail-sep">Incidents</div>
            {(building.incidents ?? []).map((inc) => {
              const lv = building.levels.find((l) => l.ordinal === inc.ordinal);
              return (
                <button
                  key={inc.id}
                  className="feedwall-rail-item"
                  onClick={() => {
                    if (inc.ordinal !== ordinal) setOrdinal(inc.ordinal);
                    setSoloId(null);
                    setShadowId(null);
                    setSubject(inc.at);
                    setDialMsg(`recall · ${inc.kind}${inc.note ? ` · ${inc.note}` : ""}`);
                  }}
                  title={`Show the cameras that see this ${inc.kind}${lv ? ` (${lv.name})` : ""}`}
                >
                  <span className="fwr-name">
                    {inc.kind}
                    {inc.note ? ` · ${inc.note}` : ""}
                  </span>
                  <span className="fwr-n">{lv?.name ?? `L${inc.ordinal}`}</span>
                </button>
              );
            })}
          </>
        )}
      </div>

      <div className="feedwall-stage">
        <div className="feedwall-canvas" ref={mountRef} />

        {/* Keypad readout. Shows the digits as they are typed and then what the
            call-up resolved to, so a mistyped number is visible BEFORE Enter. */}
        {(dial || dialMsg) && (
          <div className={`feedwall-dial${dialMsg && /^No /.test(dialMsg) ? " bad" : ""}`}>
            {dial ? (
              <>
                <span className="fwd-label">CALL</span>
                <span className="fwd-digits">{dial}</span>
                <span className="fwd-hint">Enter</span>
              </>
            ) : (
              <span className="fwd-msg">{dialMsg}</span>
            )}
          </div>
        )}

        {/* SAVED-WALL EDITOR: membership managed here, where the operator IS,
            instead of a detour through the camera inspector. Members keep the
            view's insertion order (route order) and can be nudged; the add
            list is this floor's cameras, call-up number first because that is
            how an operator thinks of them. */}
        {editingWall && editableView && !soloId && (
          <div className="feedwall-editor">
            <div className="fwe-head">
              Editing · {editableView.name}
              <button className="del" title="Done" onClick={() => setEditingWall(false)}>
                ✕
              </button>
            </div>
            <div className="fwe-sec">In this wall ({editableView.cameraIds.length})</div>
            {editableView.cameraIds.length === 0 && <div className="fwe-empty">empty — add cameras below</div>}
            {editableView.cameraIds.map((cid, i) => {
              const c = building.cameras.find((x) => x.id === cid);
              if (!c) return null;
              return (
                <div className="fwe-row" key={cid}>
                  <span className="fwe-num">{c.opNumber ?? "—"}</span>
                  <span className="fwe-name">{c.name}</span>
                  <button
                    className="fwe-btn"
                    disabled={i === 0}
                    title="Earlier in the wall"
                    onClick={() => moveCameraInView(editableView.id, cid, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="fwe-btn"
                    disabled={i === editableView.cameraIds.length - 1}
                    title="Later in the wall"
                    onClick={() => moveCameraInView(editableView.id, cid, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="fwe-btn danger"
                    title="Remove from this wall"
                    onClick={() => removeCameraFromView(editableView.id, cid)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <div className="fwe-sec">
              Add from {building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`}
            </div>
            <input
              className="fwe-filter"
              placeholder="filter by name or number…"
              value={editFilter}
              onChange={(e) => setEditFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="fwe-addlist">
              {building.cameras
                .filter(
                  (c) =>
                    c.ordinal === ordinal &&
                    !editableView.cameraIds.includes(c.id) &&
                    (editFilter.trim() === "" ||
                      c.name.toLowerCase().includes(editFilter.trim().toLowerCase()) ||
                      String(c.opNumber ?? "").startsWith(editFilter.trim())),
                )
                .slice(0, 40)
                .map((c) => (
                  <div className="fwe-row" key={c.id}>
                    <span className="fwe-num">{c.opNumber ?? "—"}</span>
                    <span className="fwe-name">{c.name}</span>
                    <button
                      className="fwe-btn add"
                      title="Add to this wall"
                      onClick={() => addCameraToView(editableView.id, c.id)}
                    >
                      +
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* PRESETS: only for a PTZ in fullscreen — nothing else has an aim the
            operator can move, so nothing else has one worth saving. */}
        {soloCam && soloCam.kind === "ptz" && (
          <div className="feedwall-presets">
            <span className="fwp-head">Presets</span>
            {presets.map((p) => (
              <span key={p.id} className={`fwp-item${p.slot === 1 ? " home" : ""}`}>
                {namingId === p.id ? (
                  // Replaces the whole recall button while renaming — an input
                  // inside a <button> is invalid HTML and steals its clicks.
                  <input
                    className="fwp-name-input"
                    autoFocus
                    defaultValue={p.name}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        renameCameraPreset(soloCam.id, p.id, e.currentTarget.value);
                        setNamingId(null);
                      } else if (e.key === "Escape") setNamingId(null);
                    }}
                    onBlur={(e) => {
                      renameCameraPreset(soloCam.id, p.id, e.currentTarget.value);
                      setNamingId(null);
                    }}
                  />
                ) : (
                  <button
                    className="fwp-recall"
                    onClick={() => {
                      recallCameraPreset(soloCam.id, p.slot);
                      setDialMsg(`${p.slot} · ${p.name}`);
                    }}
                    onDoubleClick={(e) => {
                      // Home keeps its name — renaming it would hide what the
                      // slot IS. Everything else renames on double-click.
                      if (p.slot === 1) return;
                      e.stopPropagation();
                      setNamingId(p.id);
                    }}
                    title={
                      p.slot === 1
                        ? "Home — the aim this camera was authored with (Ctrl+1, or H)"
                        : `Recall "${p.name}" (Ctrl+${p.slot}) · double-click to rename`
                    }
                  >
                    <span className="fwp-slot">{p.slot}</span>
                    {p.name}
                  </button>
                )}
                {p.slot !== 1 && (
                  <button
                    className="fwp-del"
                    title={`Delete "${p.name}"`}
                    onClick={() => deleteCameraPreset(soloCam.id, p.id)}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
            {presets.length === 0 && <span className="fwp-empty">move the camera to set Home</span>}
            {namingId === "new" ? (
              <input
                className="fwp-name-input new"
                autoFocus
                placeholder="name this shot…"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    const slot = saveCameraPreset(soloCam.id, e.currentTarget.value);
                    setDialMsg(slot ? `saved ${slot} · ${e.currentTarget.value.trim() || `Preset ${slot}`}` : "all nine slots are full");
                    setNamingId(null);
                  } else if (e.key === "Escape") setNamingId(null);
                }}
                onBlur={() => setNamingId(null)}
              />
            ) : (
              <button
                className="fwp-add"
                title="Save the current aim as a named preset"
                onClick={() => setNamingId("new")}
              >
                + Save this shot
              </button>
            )}
          </div>
        )}
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
                {/* PTZ in fullscreen gets the joystick an operator expects:
                    crosshair, drag-to-slew, wheel-to-zoom. Nested INSIDE the tile
                    so the double-click that leaves fullscreen still bubbles. */}
                {soloId && p.kind === "ptz" && (
                  <PtzJoystick
                    pose={p}
                    onLive={(live) => rendererRef.current?.setFeedPose(live)}
                    // setCameraAim, not updateCamera: it snapshots the authored
                    // aim into preset slot 1 (Home) on the FIRST move, which is
                    // the only moment the original is still recoverable.
                    onCommit={(patch) => setCameraAim(p.id, patch)}
                  />
                )}
                <span className="feedwall-tag">
                  {subject ? `${i + 1}. ` : ""}
                  {p.name}
                  {score != null ? ` · ${Math.round(score * 100)}%` : ""}
                </span>
                {/* The call-up number, shown ON the tile — an operator cannot
                    dial a camera whose number they have to go and look up. */}
                {!soloId && numberById.get(p.id) != null && (
                  <span className="feedwall-num">{numberById.get(p.id)}</span>
                )}
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
