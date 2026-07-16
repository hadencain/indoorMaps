// Pure DXF -> normalized layer/geometry module (no DOM/store/MapLibre). Feeds
// the CAD import wizard (Task 3): every DXF layer's linework becomes a
// vector underlay to trace over, and closed polylines/circles become
// room-ready polygons a user can convert straight into units. See
// docs/superpowers/plans/2026-07-16-pdxf-import.md ("Phase B: DXF / CAD
// Import" -> Global Constraints) for the exact contract this implements.
import DxfParser from "dxf-parser";
import type { MetreXY } from "./types";
import { polygonArea } from "./geo";

export interface DxfLayer {
  name: string;
  polylines: MetreXY[][]; // ALL linework incl. the outlines of closed shapes
  closedShapes: MetreXY[][]; // open rings (no repeated last vertex), deduped, area>=1m²
  entityCount: number;
}

export interface DxfParseResult {
  layers: DxfLayer[]; // sorted by name; empty layers omitted
  unitsCode: number; // raw $INSUNITS (0 when absent)
  unitsGuessed: boolean;
  widthM: number; // bbox width after scaling+translation
  heightM: number;
  skipped: Record<string, number>; // entity type -> count
}

const TESSELLATION_SEGMENTS = 32;

// $INSUNITS code -> metres-per-drawing-unit. 0/unknown falls back to 1 (m)
// and flags unitsGuessed so the import dialog can prompt the user.
const UNIT_FACTORS: Record<number, number> = {
  1: 0.0254, // inches
  2: 0.3048, // feet
  4: 0.001, // millimetres
  5: 0.01, // centimetres
  6: 1, // metres
};

const OVERRIDE_FACTORS: Record<"mm" | "cm" | "m" | "in" | "ft", number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

type RawPoint = { x: number; y: number };
// dxf-parser's own types are loose about optional fields across entity kinds
// (see node_modules/dxf-parser/dist/entities/*.d.ts) — read defensively here
// rather than fighting the library's typings with casts everywhere.
type RawEntity = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Drop consecutive duplicate points (exact match — DXF coordinates that are
 *  genuinely the same vertex repeat with identical text). */
function dedupeConsecutive(pts: RawPoint[]): RawPoint[] {
  const out: RawPoint[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) out.push(p);
  }
  return out;
}

function tessellateCircle(cx: number, cy: number, r: number): RawPoint[] {
  const pts: RawPoint[] = [];
  for (let i = 0; i < TESSELLATION_SEGMENTS; i++) {
    const a = (2 * Math.PI * i) / TESSELLATION_SEGMENTS;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Arc sweep always runs CCW from start to end (DXF convention); wraps
 *  through 2π when end < start. Sampled at the same 32-segment resolution
 *  as a full circle, regardless of the arc's actual angular span. */
function tessellateArc(cx: number, cy: number, r: number, startRad: number, endRad: number): RawPoint[] {
  let sweep = ((endRad - startRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep === 0) sweep = 2 * Math.PI;
  const pts: RawPoint[] = [];
  for (let i = 0; i <= TESSELLATION_SEGMENTS; i++) {
    const a = startRad + (sweep * i) / TESSELLATION_SEGMENTS;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** INSERT transform: local block-space point -> world space. Basepoint
 *  offset, then scale, then rotate (degrees, CCW), then translate to the
 *  insert position — standard DXF block-reference pipeline. */
function makeInsertTransform(
  basepoint: RawPoint,
  scaleX: number,
  scaleY: number,
  rotationDeg: number,
  insertPos: RawPoint,
): (p: RawPoint) => RawPoint {
  const rot = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return (p: RawPoint): RawPoint => {
    const lx = (p.x - basepoint.x) * scaleX;
    const ly = (p.y - basepoint.y) * scaleY;
    return {
      x: lx * cos - ly * sin + insertPos.x,
      y: lx * sin + ly * cos + insertPos.y,
    };
  };
}

interface LayerAccum {
  polylines: RawPoint[][];
  // Deduped OPEN rings (no repeated last vertex) with >=3 distinct vertices,
  // pending the post-scale area>=1m² filter applied in parseDxfText.
  closedCandidates: RawPoint[][];
  entityCount: number;
}

function layerBucket(map: Map<string, LayerAccum>, name: string): LayerAccum {
  let l = map.get(name);
  if (!l) {
    l = { polylines: [], closedCandidates: [], entityCount: 0 };
    map.set(name, l);
  }
  return l;
}

/** Adds a (LWPOLYLINE | POLYLINE)-shaped entity's already-transformed
 *  vertices to a layer bucket. Closed = explicit closed flag OR first
 *  vertex === last vertex (post-dedupe). `polylines` always gets the full
 *  outline (closed rings get the first point duplicated at the end so line
 *  rendering draws a complete loop); `closedCandidates` gets the deduped
 *  OPEN ring, only when it has >=3 distinct vertices. */
function addPolylineVertices(bucket: LayerAccum, rawVerts: RawPoint[], explicitClosed: boolean) {
  let verts = dedupeConsecutive(rawVerts);
  let closed = explicitClosed;
  if (verts.length >= 2) {
    const first = verts[0];
    const last = verts[verts.length - 1];
    if (first.x === last.x && first.y === last.y) {
      closed = true;
      verts = verts.slice(0, -1); // drop the repeated closing vertex
    }
  }
  bucket.entityCount++;
  if (verts.length < 2) return; // degenerate — nothing drawable
  if (closed) {
    bucket.polylines.push([...verts, verts[0]]);
    if (verts.length >= 3) bucket.closedCandidates.push(verts);
  } else {
    bucket.polylines.push(verts);
  }
}

export function parseDxfText(
  text: string,
  unitOverride?: "mm" | "cm" | "m" | "in" | "ft",
): { ok: true; result: DxfParseResult } | { ok: false; error: string } {
  let dxf: RawEntity | null;
  try {
    dxf = new DxfParser().parseSync(text) as unknown as RawEntity | null;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!dxf || !Array.isArray(dxf.entities)) {
    return { ok: false, error: "not a readable DXF file (no ENTITIES section)" };
  }

  const header = (dxf.header ?? {}) as Record<string, unknown>;
  const unitsCodeRaw = header["$INSUNITS"];
  const unitsCode = typeof unitsCodeRaw === "number" ? unitsCodeRaw : 0;
  const unitsGuessed = !(unitsCode in UNIT_FACTORS);
  const factor = unitOverride ? OVERRIDE_FACTORS[unitOverride] : UNIT_FACTORS[unitsCode] ?? 1;

  const blocks = (dxf.blocks ?? {}) as Record<string, RawEntity>;
  const layersMap = new Map<string, LayerAccum>();
  const skipped: Record<string, number> = {};
  const skip = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };

  // depth: 0 = top-level entity, 1 = inside a one-level-expanded block. An
  // INSERT encountered at depth 1 is a nested INSERT — counted skipped, not
  // expanded further (Global Constraints: "one level").
  function processEntity(entity: RawEntity, transform: (p: RawPoint) => RawPoint, depth: number) {
    const type = entity.type as string | undefined;
    switch (type) {
      case "LINE": {
        const bucket = layerBucket(layersMap, entity.layer ?? "0");
        const pts: RawPoint[] = (entity.vertices ?? []).map((v: RawPoint) => transform(v));
        bucket.entityCount++;
        if (pts.length >= 2) bucket.polylines.push(pts);
        break;
      }
      case "LWPOLYLINE":
      case "POLYLINE": {
        const bucket = layerBucket(layersMap, entity.layer ?? "0");
        const pts: RawPoint[] = (entity.vertices ?? []).map((v: RawPoint) => transform(v));
        addPolylineVertices(bucket, pts, !!entity.shape);
        break;
      }
      case "CIRCLE": {
        const bucket = layerBucket(layersMap, entity.layer ?? "0");
        if (!entity.center || typeof entity.center.x !== "number" || typeof entity.center.y !== "number" || typeof entity.radius !== "number" || !(entity.radius > 0)) {
          skip("CIRCLE");
          break;
        }
        const raw = tessellateCircle(entity.center.x, entity.center.y, entity.radius);
        const pts = raw.map(transform);
        bucket.entityCount++;
        bucket.polylines.push([...pts, pts[0]]);
        bucket.closedCandidates.push(pts);
        break;
      }
      case "ARC": {
        const bucket = layerBucket(layersMap, entity.layer ?? "0");
        if (!entity.center || typeof entity.center.x !== "number" || typeof entity.center.y !== "number" || typeof entity.radius !== "number" || !(entity.radius > 0) || typeof entity.startAngle !== "number" || typeof entity.endAngle !== "number") {
          skip("ARC");
          break;
        }
        const raw = tessellateArc(entity.center.x, entity.center.y, entity.radius, entity.startAngle, entity.endAngle);
        const pts = raw.map(transform);
        bucket.entityCount++;
        bucket.polylines.push(pts); // ARCs are polylines only, never closed shapes
        break;
      }
      case "INSERT": {
        if (depth > 0) {
          skip("INSERT"); // nested INSERT inside a block — one-level expansion only
          break;
        }
        const block = blocks[entity.name as string];
        if (!block) {
          skip("INSERT"); // unresolved block reference
          break;
        }
        const basepoint: RawPoint = block.position ? { x: block.position.x, y: block.position.y } : { x: 0, y: 0 };
        const insertPos: RawPoint = entity.position ? { x: entity.position.x, y: entity.position.y } : { x: 0, y: 0 };
        const sx = typeof entity.xScale === "number" ? entity.xScale : 1;
        const sy = typeof entity.yScale === "number" ? entity.yScale : 1;
        const rot = typeof entity.rotation === "number" ? entity.rotation : 0;
        const localTransform = makeInsertTransform(basepoint, sx, sy, rot, insertPos);
        const composed = (p: RawPoint) => transform(localTransform(p));
        for (const nested of (block.entities ?? []) as RawEntity[]) {
          processEntity(nested, composed, depth + 1);
        }
        break;
      }
      default:
        skip(type ?? "UNKNOWN"); // SPLINE, HATCH, DIMENSION, TEXT, MTEXT, ... — counted, never fatal
    }
  }

  for (const e of dxf.entities as RawEntity[]) {
    processEntity(e, (p) => p, 0);
  }

  // Global bbox (in scaled, pre-translation metres) across every layer's
  // linework — `polylines` is a superset of every point drawn (closed-shape
  // outlines and tessellated circles/arcs are already included there).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const acc of layersMap.values()) {
    for (const line of acc.polylines) {
      for (const p of line) {
        const sx = p.x * factor;
        const sy = p.y * factor;
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx > maxX) maxX = sx;
        if (sy > maxY) maxY = sy;
      }
    }
  }
  const hasGeometry = minX !== Infinity;
  const dx = hasGeometry ? 1 - minX : 0;
  const dy = hasGeometry ? 1 - minY : 0;
  const widthM = hasGeometry ? maxX - minX : 0;
  const heightM = hasGeometry ? maxY - minY : 0;
  const toMetre = (p: RawPoint): MetreXY => [p.x * factor + dx, p.y * factor + dy];

  const layers: DxfLayer[] = [];
  for (const [name, acc] of layersMap) {
    if (acc.polylines.length === 0 && acc.closedCandidates.length === 0) continue;
    const polylines = acc.polylines.map((line) => line.map(toMetre));
    const closedShapes: MetreXY[][] = [];
    for (const ring of acc.closedCandidates) {
      const scaled = ring.map(toMetre);
      if (polygonArea(scaled) >= 1) closedShapes.push(scaled);
    }
    layers.push({ name, polylines, closedShapes, entityCount: acc.entityCount });
  }
  layers.sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, result: { layers, unitsCode, unitsGuessed, widthM, heightM, skipped } };
}
