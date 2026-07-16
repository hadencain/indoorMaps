import type { Building, Graph, MetreXY, NodeMeta } from "./types";
import { distM } from "./geo";

export interface RouteStep {
  text: string; // "Exit Poker Room through the door and turn left"
  ordinal: number; // floor the step happens on
  at: MetreXY; // anchor (future: step highlighting)
}

const ENTRANCE_PREFIX = "entrance:";

/** Signed turn angle (degrees) between incoming (prev->node) and outgoing
 *  (node->next) vectors, in metre space (y-up). Positive = left (CCW). */
function turnAngleDeg(prev: MetreXY, node: MetreXY, next: MetreXY): number {
  const inx = node[0] - prev[0];
  const iny = node[1] - prev[1];
  const outx = next[0] - node[0];
  const outy = next[1] - node[1];
  const cross = inx * outy - iny * outx;
  const dot = inx * outx + iny * outy;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function turnSuffix(angle: number): string {
  if (angle > 30) return "and turn left";
  if (angle < -30) return "and turn right";
  return "and continue straight";
}

/** True for the floor's corridor-hub centroid node — the node the LOS-smoothed
 *  render line skips over when it has a clear shot past it (see losShortcut in
 *  route-smooth.ts). Turn geometry and leg distances below skip it the same
 *  way so prose matches the drawn line instead of the raw A* detour through
 *  the hub. */
function isHub(n: NodeMeta | undefined): boolean {
  return !!n && n.kind === "unit" && n.category === "corridor";
}

/** xy of the next path node after index i, skipping a mid-path corridor-hub
 *  node (never skips past the final node — arrival must stay anchored). */
function turnTarget(path: string[], i: number, meta: (id: string) => NodeMeta | undefined): MetreXY | undefined {
  let j = i + 1;
  while (j < path.length - 1 && isHub(meta(path[j]))) j++;
  return meta(path[j])?.xy;
}

/** xy of the path node before index i, skipping a mid-path corridor-hub node
 *  immediately behind it (never skips past the first/start node). */
function turnSource(path: string[], i: number, meta: (id: string) => NodeMeta | undefined): MetreXY | undefined {
  let j = i - 1;
  while (j > 0 && isHub(meta(path[j]))) j--;
  return meta(path[j])?.xy;
}

/** Turn-by-turn steps from the RAW A* node path (unit/door/entrance metas) —
 *  never re-runs A*, never reads smoothed geometry. */
export function routeSteps(graph: Graph, path: string[], building: Building): RouteStep[] {
  if (path.length < 2) return [];

  const meta = (id: string): NodeMeta | undefined => graph.nodes.get(id);
  const first = meta(path[0]);
  if (!first) return [];

  const steps: RouteStep[] = [
    { text: `Start at ${first.name ?? "Start"}`, ordinal: first.ordinal, at: first.xy },
  ];

  for (let i = 1; i < path.length; i++) {
    const node = meta(path[i]);
    if (!node) continue;
    const prev = meta(path[i - 1]);
    const next = i + 1 < path.length ? meta(path[i + 1]) : undefined;
    const isLast = i === path.length - 1;

    if (node.kind === "door") {
      const nextIsGoal = !!next && i === path.length - 2;
      if (nextIsGoal && next) {
        steps.push({
          text: `Go through the door into ${next.name ?? "the destination"}`,
          ordinal: node.ordinal,
          at: node.xy,
        });
      } else if (prev && next) {
        const sourceXY = turnSource(path, i, meta) ?? prev.xy;
        const targetXY = turnTarget(path, i, meta) ?? next.xy;
        const angle = turnAngleDeg(sourceXY, node.xy, targetXY);
        const suffix = turnSuffix(angle);
        const prefix =
          prev.kind === "unit" && prev.name ? `Exit ${prev.name} through the door` : "Go through the door";
        steps.push({ text: `${prefix} ${suffix}`, ordinal: node.ordinal, at: node.xy });
      } else {
        steps.push({ text: "Go through the door", ordinal: node.ordinal, at: node.xy });
      }
      continue;
    }

    if (node.kind === "entrance") {
      const openingId = node.id.startsWith(ENTRANCE_PREFIX) ? node.id.slice(ENTRANCE_PREFIX.length) : node.id;
      const opening = building.openings.find((o) => o.id === openingId);
      const owner = opening && building.units.find((u) => u.id === opening.unit);
      steps.push({
        text: `Exit the building via ${owner?.name ?? "the entrance"}`,
        ordinal: node.ordinal,
        at: node.xy,
      });
      continue;
    }

    // kind === "unit"
    if (isLast) {
      steps.push({ text: `Arrive at ${node.name ?? "the destination"}`, ordinal: node.ordinal, at: node.xy });
      continue;
    }

    if (!next) continue;

    if (next.ordinal !== node.ordinal) {
      const vertical = building.verticals.find(
        (v) => (v.a === node.id && v.b === next.id) || (v.b === node.id && v.a === next.id),
      );
      const levelName = building.levels.find((l) => l.ordinal === next.ordinal)?.name ?? `Floor ${next.ordinal}`;
      steps.push({
        text: `Take ${vertical?.name ?? "the stairs or elevator"} to ${levelName}`,
        ordinal: node.ordinal,
        at: node.xy,
      });
      continue;
    }

    if (!prev) continue;
    const legFrom = turnSource(path, i, meta) ?? prev.xy;
    const legTo = turnTarget(path, i, meta) ?? next.xy;
    const d = Math.round(distM(legFrom, legTo) / 5) * 5;
    if (d < 8) continue;
    steps.push({
      text: `Follow ${node.name ?? "the corridor"} for ~${d} m`,
      ordinal: node.ordinal,
      at: node.xy,
    });
  }

  return steps;
}
