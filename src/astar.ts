import type { Graph } from "./types";
import { distM } from "./geo";

export interface RouteResult {
  path: string[];
  /** Total edge cost along the path (metres, incl. vertical-connection cost). */
  cost: number;
}

/**
 * A* over the nav graph. Heuristic is straight-line metre distance to the goal
 * ignoring floor separation — admissible because every real edge (including
 * vertical connections) costs at least its horizontal span.
 */
export function findRoute(
  graph: Graph,
  startId: string,
  goalId: string,
): RouteResult | null {
  const { nodes, adj } = graph;
  if (!nodes.has(startId) || !nodes.has(goalId)) return null;
  if (startId === goalId) return { path: [startId], cost: 0 };

  const goalXY = nodes.get(goalId)!.xy;
  const h = (id: string) => distM(nodes.get(id)!.xy, goalXY);

  const g = new Map<string, number>([[startId, 0]]);
  const cameFrom = new Map<string, string>();
  const open = new Set<string>([startId]);

  while (open.size > 0) {
    // Pop the node with the lowest f = g + h (linear scan; graph is tiny).
    let current = "";
    let bestF = Infinity;
    for (const id of open) {
      const f = (g.get(id) ?? Infinity) + h(id);
      if (f < bestF) {
        bestF = f;
        current = id;
      }
    }

    if (current === goalId) {
      const path: string[] = [current];
      let c = current;
      while (cameFrom.has(c)) {
        c = cameFrom.get(c)!;
        path.unshift(c);
      }
      return { path, cost: g.get(goalId)! };
    }

    open.delete(current);
    const gCur = g.get(current)!;
    for (const edge of adj.get(current) ?? []) {
      const tentative = gCur + edge.w;
      if (tentative < (g.get(edge.to) ?? Infinity)) {
        cameFrom.set(edge.to, current);
        g.set(edge.to, tentative);
        open.add(edge.to);
      }
    }
  }

  return null;
}
