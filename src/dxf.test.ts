import { describe, expect, it } from "vitest";
import { parseDxfText, type DxfParseResult } from "./dxf";
import { polygonArea } from "./geo";

// Minimal, hand-built DXF text (well-formed group-code/value line pairs —
// dxf-parser is strict about pairing). Covers every entity kind the module
// handles: LWPOLYLINE (explicit-closed + implicit-closed-via-repeated-vertex
// + open-with-a-consecutive-duplicate-vertex), LINE, CIRCLE, ARC, one
// BLOCK/INSERT pair, and one SPLINE (unsupported -> skipped). Units are mm
// ($INSUNITS 4) so a 5000-unit square becomes a 5m square (area 25 m2).
const FULL_DXF = `0
SECTION
2
HEADER
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
DOORBLK
10
500.0
20
500.0
0
LWPOLYLINE
8
BLOCKLAYER
90
4
70
1
10
500.0
20
500.0
10
2500.0
20
500.0
10
2500.0
20
2500.0
10
500.0
20
2500.0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
ROOM
90
4
70
1
10
0.0
20
0.0
10
5000.0
20
0.0
10
5000.0
20
5000.0
10
0.0
20
5000.0
0
LWPOLYLINE
8
NOTES
90
4
70
0
10
0.0
20
0.0
10
0.0
20
0.0
10
2000.0
20
0.0
10
2000.0
20
2000.0
0
LWPOLYLINE
8
IMPLICITCLOSED
90
5
70
0
10
0.0
20
0.0
10
3000.0
20
0.0
10
3000.0
20
3000.0
10
0.0
20
3000.0
10
0.0
20
0.0
0
LINE
8
ROOM
10
0.0
20
0.0
11
1000.0
21
1000.0
0
CIRCLE
8
FIXTURES
10
9000.0
20
9000.0
40
1000.0
0
ARC
8
ARCLAYER
10
0.0
20
0.0
40
500.0
50
0.0
51
90.0
0
INSERT
8
INSERTS
2
DOORBLK
10
6000.0
20
0.0
30
0.0
41
1.0
42
1.0
50
0.0
0
SPLINE
8
SPLINELAYER
70
0
0
ENDSEC
0
EOF`;

// No HEADER section at all -> $INSUNITS absent -> unitsGuessed.
const NO_HEADER_DXF = `0
SECTION
2
ENTITIES
0
LINE
8
L1
10
0.0
20
0.0
11
1.0
21
1.0
0
ENDSEC
0
EOF`;

function layer(result: DxfParseResult, name: string) {
  return result.layers.find((l) => l.name === name);
}

describe("parseDxfText", () => {
  it("scales mm units and extracts a closed LWPOLYLINE as a room-sized shape", () => {
    const parsed = parseDxfText(FULL_DXF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.unitsCode).toBe(4);
    expect(parsed.result.unitsGuessed).toBe(false);
    const room = layer(parsed.result, "ROOM");
    expect(room).toBeDefined();
    expect(room!.closedShapes.length).toBe(1);
    expect(room!.closedShapes[0].length).toBe(4);
    expect(polygonArea(room!.closedShapes[0])).toBeCloseTo(25, 1);
  });

  it("keeps an open LWPOLYLINE as linework only, deduping a consecutive duplicate vertex", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const notes = layer(parsed.result, "NOTES");
    expect(notes).toBeDefined();
    expect(notes!.polylines.length).toBe(1);
    expect(notes!.polylines[0].length).toBe(3); // 4 raw verts, 1 consecutive dup removed
    expect(notes!.closedShapes.length).toBe(0);
  });

  it("closes a polyline via a repeated first/last vertex even without the closed flag", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const implicit = layer(parsed.result, "IMPLICITCLOSED");
    expect(implicit).toBeDefined();
    expect(implicit!.closedShapes.length).toBe(1);
    expect(implicit!.closedShapes[0].length).toBe(4); // repeated closing vertex dropped
    expect(polygonArea(implicit!.closedShapes[0])).toBeCloseTo(9, 1);
  });

  it("tessellates a CIRCLE into a 32-point closed shape", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const fixtures = layer(parsed.result, "FIXTURES");
    expect(fixtures).toBeDefined();
    expect(fixtures!.closedShapes.length).toBe(1);
    expect(fixtures!.closedShapes[0].length).toBe(32);
    expect(polygonArea(fixtures!.closedShapes[0])).toBeCloseTo(Math.PI, 1);
  });

  it("treats an ARC as linework only, never a closed shape", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const arcs = layer(parsed.result, "ARCLAYER");
    expect(arcs).toBeDefined();
    expect(arcs!.polylines.length).toBe(1);
    expect(arcs!.polylines[0].length).toBeGreaterThan(2);
    expect(arcs!.closedShapes.length).toBe(0);
  });

  it("counts a SPLINE as skipped, never fatal, and never materializes its own layer", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.result.skipped.SPLINE).toBe(1);
    expect(layer(parsed.result, "SPLINELAYER")).toBeUndefined();
  });

  it("expands one INSERT level, applying block basepoint + insert position", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const expanded = layer(parsed.result, "BLOCKLAYER");
    expect(expanded).toBeDefined();
    expect(expanded!.entityCount).toBe(1);
    expect(expanded!.closedShapes.length).toBe(1);
    expect(polygonArea(expanded!.closedShapes[0])).toBeCloseTo(4, 1);
    // The INSERT entity's own layer ("INSERTS") never gets geometry — only
    // the expanded block entities' authored layers do.
    expect(layer(parsed.result, "INSERTS")).toBeUndefined();
  });

  it("translates the bbox so its minimum sits at (1, 1) metres", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    let minX = Infinity;
    let minY = Infinity;
    for (const l of parsed.result.layers) {
      for (const line of l.polylines) {
        for (const [x, y] of line) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
        }
      }
    }
    expect(minX).toBeCloseTo(1, 5);
    expect(minY).toBeCloseTo(1, 5);
    expect(parsed.result.widthM).toBeGreaterThan(0);
    expect(parsed.result.heightM).toBeGreaterThan(0);
  });

  it("sorts layers by name", () => {
    const parsed = parseDxfText(FULL_DXF);
    if (!parsed.ok) throw new Error("parse failed");
    const names = parsed.result.layers.map((l) => l.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("lets a unit override beat $INSUNITS", () => {
    const mm = parseDxfText(FULL_DXF);
    const ft = parseDxfText(FULL_DXF, "ft");
    if (!mm.ok || !ft.ok) throw new Error("parse failed");
    expect(ft.result.unitsCode).toBe(4); // raw header value is still reported
    // ft (0.3048 m/unit) is ~305x mm (0.001 m/unit) -> drastically larger span.
    expect(ft.result.widthM).toBeGreaterThan(mm.result.widthM * 100);
  });

  it("flags unitsGuessed when $INSUNITS is absent", () => {
    const parsed = parseDxfText(NO_HEADER_DXF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.unitsCode).toBe(0);
    expect(parsed.result.unitsGuessed).toBe(true);
  });

  it("returns ok:false for unparseable garbage, never throws", () => {
    const parsed = parseDxfText("this is not a dxf file\nrandom garbage\n1234");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  });
});
