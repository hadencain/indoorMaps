import { useMemo } from "react";
import { useStore } from "../store";
import { buildGraph } from "../graph";
import { findRoute } from "../astar";
import { routeToGeometry } from "../render";
import type { RouteGeometry } from "../render";

export function useRoute(): { geom: RouteGeometry | null } {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);

  const geom = useMemo<RouteGeometry | null>(() => {
    const graph = buildGraph(building);
    const route = findRoute(graph, startId, goalId);
    return route ? routeToGeometry(graph, route.path) : null;
  }, [building, startId, goalId]);

  return { geom };
}
