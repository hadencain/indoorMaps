import { useMemo } from "react";
import { useStore } from "../store";
import { buildGraph } from "../graph";
import { findRoute, findNearestRoute } from "../astar";
import { routeToGeometry } from "../render";
import type { RouteGeometry } from "../render";
import { routeSteps } from "../directions";
import type { RouteStep } from "../directions";

export interface RouteInfo {
  geom: RouteGeometry | null;
  /** In egress mode, the chosen nearest exit (else null). */
  exit: { nodeId: string; name: string } | null;
  /** Turn-by-turn steps from the raw node path; [] when no route. */
  steps: RouteStep[];
}

export function useRoute(): RouteInfo {
  const building = useStore((s) => s.building);
  const startId = useStore((s) => s.startId);
  const goalId = useStore((s) => s.goalId);
  const routeMode = useStore((s) => s.routeMode);
  const stepFree = useStore((s) => s.stepFree);

  return useMemo<RouteInfo>(() => {
    try {
      if (routeMode === "egress") {
        const graph = buildGraph(building, { stepFree });
        const exitNodes = [...graph.nodes.values()].filter((n) => n.kind === "entrance");
        const route = findNearestRoute(
          graph,
          startId,
          exitNodes.map((n) => n.id),
        );
        if (!route) return { geom: null, exit: null, steps: [] };
        // Node id is `entrance:<openingId>`; name the exit by its owning unit.
        const openingId = route.goalId.slice("entrance:".length);
        const op = building.openings.find((o) => o.id === openingId);
        const owner = op && building.units.find((u) => u.id === op.unit);
        return {
          geom: routeToGeometry(graph, route.path, building),
          exit: { nodeId: route.goalId, name: owner?.name ?? "Exit" },
          steps: routeSteps(graph, route.path, building),
        };
      }

      const graph = buildGraph(building, { stepFree });
      const route = findRoute(graph, startId, goalId);
      return {
        geom: route ? routeToGeometry(graph, route.path, building) : null,
        exit: null,
        steps: route ? routeSteps(graph, route.path, building) : [],
      };
    } catch {
      // Authoring can transiently leave a floor with a door but no corridor
      // (mid-edit, or a corridor deleted while other rooms still have doors) —
      // buildGraph throws in that case. Degrade to "no route" instead of
      // white-screening the whole app.
      return { geom: null, exit: null, steps: [] };
    }
  }, [building, startId, goalId, routeMode, stepFree]);
}
