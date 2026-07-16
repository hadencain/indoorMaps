import type { Building, Category, Edge, Graph, MetreXY, NodeMeta, Unit, Vertical } from "./types";
import { distM, m2ll, polygonCentroid } from "./geo";
import { isNonRoutable } from "./categories";

/** Extra cost (metres-equivalent) to traverse one vertical connection. */
const VERTICAL_COST = 6;

/** Verticals named like a stair/escalator run, by author convention. */
const STAIR_LIKE_NAME = /\bstair|escalator/i;

/**
 * Whether a vertical connection can be traversed without steps (elevator/ramp)
 * vs. not (stairs/escalator). Two independent signals, either one disqualifies:
 *   - the name reads as a stair/escalator run (authors often mis-categorize an
 *     escalator's endpoint units as "elevator", so name is checked first-class,
 *     not just as a fallback), OR
 *   - either endpoint unit is category "stairs".
 * A missing endpoint unit (unknown id) is treated as not-stairs for that
 * endpoint — falls through to the name check alone.
 */
export function isStepFreeVertical(v: Vertical, unitById: Map<string, Unit>): boolean {
  if (STAIR_LIKE_NAME.test(v.name)) return false;
  const a = unitById.get(v.a);
  const b = unitById.get(v.b);
  if (a?.category === "stairs" || b?.category === "stairs") return false;
  return true;
}

/**
 * Build a routable navigation graph from the IMDF-flavored building:
 *   - one node per unit (at its centroid)
 *   - one node per opening/door (at the door point)
 *   - unit <-> door <-> corridor edges (so paths bend through doorways)
 *   - unit <-> unit vertical edges for stairs/elevators (cross-ordinal)
 *
 * Non-routable units (`isNonRoutable`, i.e. `security === "restricted"`) get no
 * node; their openings and verticals drop out silently rather than throwing.
 *
 * `opts.stepFree`: when true, verticals that aren't step-free (see
 * `isStepFreeVertical`) are skipped entirely — no edge, so no route can cross
 * on stairs/escalators. Omitted/false is byte-identical to the old behavior.
 */
export function buildGraph(b: Building, opts?: { stepFree?: boolean }): Graph {
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

  // Hub for a plain door: the corridor on the opening's ordinal.
  const hubOnOrdinal = (category: Category, ordinal: number) =>
    b.units.find((u) => u.category === category && u.ordinal === ordinal);

  // Hub for an entrance: the nearest outside patch (by centroid) on the ordinal.
  const nearestOutside = (ordinal: number, at: MetreXY): Unit | undefined => {
    const outs = b.units.filter((u) => u.category === "outside" && u.ordinal === ordinal);
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const o of outs) {
      const d = distM(at, polygonCentroid(o.polygon));
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  };

  // Door / entrance nodes + unit<->hub edges.
  //   door     → unit ↔ door ↔ corridor(ordinal)
  //   entrance → unit ↔ entrance ↔ nearest outside(ordinal)
  b.openings.forEach((op) => {
    const unit = nodes.get(op.unit);
    if (!unit) {
      // Owner missing from the graph: non-routable/known → silently skip;
      // truly unknown id → keep the guard.
      if (routableIds.has(op.unit) || b.units.some((u) => u.id === op.unit)) return;
      throw new Error(`opening references unknown unit: ${op.unit}`);
    }
    const isEntrance = op.kind === "entrance";

    // Non-destructive: an outside patch may still carry an auto-`door` opening
    // (kept in the data on recategorize). Outside connects to the interior via
    // *entrances* on interior units, not its own door — so ignore that door in
    // the graph. Entrances on an outside unit are still honored.
    if (!isEntrance && unit.category === "outside") return;

    const hub = isEntrance
      ? nearestOutside(unit.ordinal, op.at)
      : hubOnOrdinal("corridor", unit.ordinal);
    if (!hub) {
      // Entrance drawn before any outside area exists: interior node is inert,
      // no throw. A plain door still requires a corridor on its ordinal.
      if (isEntrance) return;
      throw new Error(`no corridor on ordinal ${unit.ordinal}`);
    }

    const nodeId = `${isEntrance ? "entrance" : "door"}:${op.id}`;
    const xy: MetreXY = op.at;
    nodes.set(nodeId, {
      id: nodeId,
      ordinal: unit.ordinal,
      xy,
      lnglat: m2ll(b.origin, xy[0], xy[1]),
      kind: isEntrance ? "entrance" : "door",
    });

    addEdge(unit.id, nodeId, distM(unit.xy, xy));
    addEdge(nodeId, hub.id, distM(xy, nodes.get(hub.id)!.xy));
  });

  // Vertical connections.
  const unitById = new Map(b.units.map((u) => [u.id, u]));
  for (const v of b.verticals) {
    if (!nodes.has(v.a) || !nodes.has(v.b)) {
      // A non-routable endpoint (both ids are real units) → skip; otherwise throw.
      if (b.units.some((u) => u.id === v.a) && b.units.some((u) => u.id === v.b)) continue;
      throw new Error(`vertical references unknown unit: ${v.a}/${v.b}`);
    }
    if (opts?.stepFree && !isStepFreeVertical(v, unitById)) continue;
    addEdge(v.a, v.b, VERTICAL_COST);
  }

  return { nodes, adj };
}
