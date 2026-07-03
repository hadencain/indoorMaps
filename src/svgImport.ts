// Minimal, dependency-free SVG floorplan importer.
// Parses <rect>, <polygon>, <polyline>, and <path> into raw point-lists in the
// SVG's own coordinate space (Y-down). Curves are flattened to their endpoints
// (fine for line-drawn floorplans; note it in the UI). Element `transform`
// attributes are ignored for now.

export interface RawShape {
  name?: string;
  /** Points in SVG user units, Y-down, unclosed. */
  points: [number, number][];
}

export function parseSvgShapes(svgText: string): RawShape[] {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid SVG");

  const shapes: RawShape[] = [];
  const nameOf = (el: Element): string | undefined =>
    el.getAttribute("data-name") || el.getAttribute("id") || undefined;

  for (const el of Array.from(doc.querySelectorAll("rect, polygon, polyline, path"))) {
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    if (tag === "rect") {
      const x = num(el.getAttribute("x"));
      const y = num(el.getAttribute("y"));
      const w = num(el.getAttribute("width"));
      const h = num(el.getAttribute("height"));
      if (w > 0 && h > 0) {
        shapes.push({ name, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
      }
    } else if (tag === "polygon" || tag === "polyline") {
      const pts = parsePointList(el.getAttribute("points") || "");
      if (pts.length >= 3) shapes.push({ name, points: pts });
    } else if (tag === "path") {
      for (const sub of parsePath(el.getAttribute("d") || "")) {
        if (sub.length >= 3) shapes.push({ name, points: sub });
      }
    }
  }
  return shapes;
}

function num(s: string | null): number {
  const v = parseFloat(s ?? "0");
  return Number.isFinite(v) ? v : 0;
}

function parsePointList(s: string): [number, number][] {
  const nums = (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

/** Parse a path `d` into subpaths (split on M/Z). Curves -> endpoint only. */
function parsePath(d: string): [number, number][][] {
  const tokens = d.match(/[a-z][^a-z]*/gi) || [];
  const subs: [number, number][][] = [];
  let cur: [number, number][] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  const flush = () => {
    if (cur.length >= 2) subs.push(cur);
    cur = [];
  };

  for (const tok of tokens) {
    const cmd = tok[0];
    const args = (tok.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();

    if (c === "M") {
      flush();
      for (let i = 0; i + 1 < args.length; i += 2) {
        x = rel ? x + args[i] : args[i];
        y = rel ? y + args[i + 1] : args[i + 1];
        if (i === 0) {
          startX = x;
          startY = y;
        }
        cur.push([x, y]);
      }
    } else if (c === "L" || c === "T") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        x = rel ? x + args[i] : args[i];
        y = rel ? y + args[i + 1] : args[i + 1];
        cur.push([x, y]);
      }
    } else if (c === "H") {
      for (const a of args) {
        x = rel ? x + a : a;
        cur.push([x, y]);
      }
    } else if (c === "V") {
      for (const a of args) {
        y = rel ? y + a : a;
        cur.push([x, y]);
      }
    } else if (c === "C" || c === "S" || c === "Q" || c === "A") {
      const step = c === "C" ? 6 : c === "A" ? 7 : 4;
      for (let i = 0; i + step <= args.length; i += step) {
        const ex = args[i + step - 2];
        const ey = args[i + step - 1];
        x = rel ? x + ex : ex;
        y = rel ? y + ey : ey;
        cur.push([x, y]);
      }
    } else if (c === "Z") {
      x = startX;
      y = startY;
      flush();
    }
  }
  flush();
  return subs;
}
