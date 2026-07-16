import { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import { useStore } from "../store";
import { m2ll, distM } from "../geo";
import { WALK_MPS } from "../route-smooth";
import type { MetreXY } from "../types";

/** Push a new probe (camera-window handoff check) every this many metres. */
const PROBE_STEP_M = 1.2;

/**
 * Patrol playback (display mode): animates a guard dot along the selected
 * patrol route. The dot is a MapLibre marker moved imperatively from a rAF
 * loop — the store only holds identity/paused/speed, so playback never churns
 * React state per frame. Every ~1.2 m of travel it pushes the dot's position
 * as the probe, and the existing CameraWindow does the rest: best-view
 * ranking, the floating feed following the guard, and live camera handoffs
 * the moment the current camera loses sight. An open path is walked
 * ping-pong (out and back), matching a real guard tour.
 */
export default function PatrolPlayback({ map }: { map: maplibregl.Map }) {
  const playback = useStore((s) => s.patrolPlayback);
  const building = useStore((s) => s.building);
  const setProbe = useStore((s) => s.setProbe);
  const stopPlayback = useStore((s) => s.stopPatrolPlayback);

  const patrol = useMemo(
    () => (playback ? (building.patrols ?? []).find((p) => p.id === playback.patrolId) ?? null : null),
    [playback, building.patrols],
  );

  // Cumulative arc lengths for distance→position lookup.
  const arcs = useMemo(() => {
    if (!patrol) return null;
    const cum = [0];
    for (let i = 1; i < patrol.points.length; i++)
      cum.push(cum[i - 1] + distM(patrol.points[i - 1], patrol.points[i]));
    return cum;
  }, [patrol]);

  const distRef = useRef(0);
  const lastProbeRef = useRef<MetreXY | null>(null);
  const pushedRef = useRef(false);

  // Reset travel when the played route changes identity.
  useEffect(() => {
    distRef.current = 0;
    lastProbeRef.current = null;
    pushedRef.current = false;
  }, [playback?.patrolId]);

  // Closing the camera window (✕ or Esc clears the probe) ends the tour —
  // otherwise the next probe push would immediately reopen it.
  const probe = useStore((s) => s.probe);
  useEffect(() => {
    if (pushedRef.current && probe === null && playback) stopPlayback();
  }, [probe, playback, stopPlayback]);

  useEffect(() => {
    if (!patrol || !arcs || patrol.points.length < 2) return;
    const total = arcs[arcs.length - 1];
    if (total <= 0) return;

    const el = document.createElement("div");
    el.className = "guard-dot";
    el.title = "Guard (patrol playback)";
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat(m2ll(building.origin, patrol.points[0][0], patrol.points[0][1]))
      .addTo(map);

    const posAt = (dist: number): MetreXY => {
      // Ping-pong over the open path: 0..L forward, L..2L back.
      const cycle = dist % (2 * total);
      const s = cycle <= total ? cycle : 2 * total - cycle;
      let i = 1;
      while (i < arcs.length - 1 && arcs[i] < s) i++;
      const segLen = arcs[i] - arcs[i - 1] || 1;
      const t = (s - arcs[i - 1]) / segLen;
      const a = patrol.points[i - 1];
      const b = patrol.points[i];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const pb = useStore.getState().patrolPlayback;
      if (pb?.playing) distRef.current += WALK_MPS * pb.speed * dt;
      const p = posAt(distRef.current);
      marker.setLngLat(m2ll(building.origin, p[0], p[1]));
      const lastP = lastProbeRef.current;
      if (!lastP || Math.hypot(p[0] - lastP[0], p[1] - lastP[1]) >= PROBE_STEP_M) {
        lastProbeRef.current = p;
        pushedRef.current = true;
        setProbe({ point: p });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      marker.remove();
    };
  }, [patrol, arcs, building.origin, map, setProbe]);

  // Route deleted / floor switched away mid-tour: nothing to animate.
  useEffect(() => {
    if (playback && !patrol) stopPlayback();
  }, [playback, patrol, stopPlayback]);

  return null;
}
