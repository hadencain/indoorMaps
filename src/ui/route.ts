import { useMemo } from "react";
import { useStore } from "../store";
import { buildGraph } from "../graph";
import { findRoute, findNearestRoute } from "../astar";
import { routeToGeometry } from "../render";
import type { RouteGeometry } from "../render";

export interface RouteInfo {
  geom: RouteGeometry | null;
  /** In egress mode, the chosen nearest exit (else null). */
  exit: { nodeId: string; name: string } | null;
}

export function useRoute(): RouteInfo {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const routeMode = useStore((s) => s.routeMode);

  return useMemo<RouteInfo>(() => {
    const graph = buildGraph(building);

    if (routeMode === "egress") {
      const exitNodes = [...graph.nodes.values()].filter((n) => n.kind === "entrance");
      const route = findNearestRoute(
        graph,
        startId,
        exitNodes.map((n) => n.id),
      );
      if (!route) return { geom: null, exit: null };
      // Node id is `entrance:<openingId>`; name the exit by its owning unit.
      const openingId = route.goalId.slice("entrance:".length);
      const op = building.openings.find((o) => o.id === openingId);
      const owner = op && building.units.find((u) => u.id === op.unit);
      return {
        geom: routeToGeometry(graph, route.path),
        exit: { nodeId: route.goalId, name: owner?.name ?? "Exit" },
      };
    }

    const route = findRoute(graph, startId, goalId);
    return { geom: route ? routeToGeometry(graph, route.path) : null, exit: null };
  }, [building, startId, goalId, routeMode]);
}
