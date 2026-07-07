import type { Building, Edge, Graph, MetreXY, NodeMeta } from "./types";
import { distM, m2ll, polygonCentroid } from "./geo";
import { isNonRoutable } from "./categories";

/** Extra cost (metres-equivalent) to traverse one vertical connection. */
const VERTICAL_COST = 6;

/**
 * Build a routable navigation graph from the IMDF-flavored building:
 *   - one node per unit (at its centroid)
 *   - one node per opening/door (at the door point)
 *   - unit <-> door <-> corridor edges (so paths bend through doorways)
 *   - unit <-> unit vertical edges for stairs/elevators (cross-ordinal)
 *
 * Non-routable units (`isNonRoutable`, i.e. `security === "restricted"`) get no
 * node; their openings and verticals drop out silently rather than throwing.
 */
export function buildGraph(b: Building): Graph {
  const nodes = new Map<string, NodeMeta>();
  const adj = new Map<string, Edge[]>();

  const addEdge = (from: string, to: string, w: number) => {
    if (!adj.has(from)) adj.set(from, []);
    if (!adj.has(to)) adj.set(to, []);
    adj.get(from)!.push({ to, w });
    adj.get(to)!.push({ to: from, w });
  };

  // Ids of units that are routable (get a node). Non-routable = restricted.
  const routableIds = new Set(b.units.filter((u) => !isNonRoutable(u)).map((u) => u.id));

  // Unit nodes (non-routable units are skipped — no node).
  for (const u of b.units) {
    if (isNonRoutable(u)) continue;
    const xy = polygonCentroid(u.polygon);
    nodes.set(u.id, {
      id: u.id,
      ordinal: u.ordinal,
      xy,
      lnglat: m2ll(b.origin, xy[0], xy[1]),
      kind: "unit",
      name: u.name,
      category: u.category,
    });
  }

  const corridorFor = (ordinal: number) =>
    b.units.find((u) => u.category === "corridor" && u.ordinal === ordinal);

  // Door nodes + unit<->door<->corridor edges.
  b.openings.forEach((op) => {
    const unit = nodes.get(op.unit);
    if (!unit) {
      // Owner missing from the graph: non-routable/known → silently skip;
      // truly unknown id → keep the guard.
      if (routableIds.has(op.unit) || b.units.some((u) => u.id === op.unit)) return;
      throw new Error(`opening references unknown unit: ${op.unit}`);
    }
    const corridor = corridorFor(unit.ordinal);
    if (!corridor) throw new Error(`no corridor on ordinal ${unit.ordinal}`);

    const doorId = `door:${op.id}`;
    const xy: MetreXY = op.at;
    nodes.set(doorId, {
      id: doorId,
      ordinal: unit.ordinal,
      xy,
      lnglat: m2ll(b.origin, xy[0], xy[1]),
      kind: "door",
    });

    addEdge(unit.id, doorId, distM(unit.xy, xy));
    addEdge(doorId, corridor.id, distM(xy, nodes.get(corridor.id)!.xy));
  });

  // Vertical connections.
  for (const v of b.verticals) {
    if (!nodes.has(v.a) || !nodes.has(v.b)) {
      // A non-routable endpoint (both ids are real units) → skip; otherwise throw.
      if (b.units.some((u) => u.id === v.a) && b.units.some((u) => u.id === v.b)) continue;
      throw new Error(`vertical references unknown unit: ${v.a}/${v.b}`);
    }
    addEdge(v.a, v.b, VERTICAL_COST);
  }

  return { nodes, adj };
}
