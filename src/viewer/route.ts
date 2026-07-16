import { useMemo } from "react";
import type { Building } from "../types";
import { buildGraph } from "../graph";
import { findRoute } from "../astar";
import { routeToGeometry } from "../render";
import type { RouteGeometry } from "../render";
import { routeSteps } from "../directions";
import type { RouteStep } from "../directions";

export interface ViewerRouteInfo {
  geom: RouteGeometry | null;
  steps: RouteStep[];
}

/**
 * Pure re-implementation of `src/ui/route.ts`'s direct-mode path — that hook
 * reads from the zustand store, which the viewer never imports. Same chain
 * (buildGraph → findRoute → routeToGeometry + routeSteps), driven by plain
 * React state instead of store selectors. Egress mode is an authoring/
 * operator concept (nearest-exit routing) and out of scope for a read-only
 * visitor viewer — only direct A→B routing is offered here.
 */
export function useViewerRoute(
  building: Building,
  startId: string,
  goalId: string,
  stepFree = false,
): ViewerRouteInfo {
  return useMemo<ViewerRouteInfo>(() => {
    if (!startId || !goalId) return { geom: null, steps: [] };
    try {
      const graph = buildGraph(building, { stepFree });
      const route = findRoute(graph, startId, goalId);
      return {
        geom: route ? routeToGeometry(graph, route.path, building) : null,
        steps: route ? routeSteps(graph, route.path, building) : [],
      };
    } catch {
      // Mid-authoring buildings can transiently have a door but no corridor;
      // buildGraph throws in that case. A visitor export should never hit
      // this (it's already valid), but degrade to "no route" rather than
      // crash if a hand-edited file slips through.
      return { geom: null, steps: [] };
    }
  }, [building, startId, goalId, stepFree]);
}
