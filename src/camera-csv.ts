/** CAMERA SCHEDULE (CSV) PARSER — pure, UI-free, no deps.
 *
 *  Integrators keep the plant in a spreadsheet: one row per camera with name,
 *  model, mount height, channel number, IP, serial. That file is the real
 *  source of truth on a bid, so importing it is the bulk path onboarding
 *  needs — the catalogue maps model strings to optics, and a schedule row
 *  either ENRICHES an existing camera (matched by name) or creates a new one.
 *
 *  Real schedules almost never carry map coordinates, so x/y columns are
 *  honoured when present and everything else is created on a visible staging
 *  line for the operator to drag into place — cameras that exist but are not
 *  yet positioned must LOOK unpositioned, not be scattered or hidden.
 *
 *  Header sniffing is deliberately liberal (a schedule is whatever Excel
 *  exported that day), but the RESULT is shown to the user in a preview
 *  dialog before anything is imported — liberal parsing with a silent apply
 *  would be the same failure class as the letterboxed calibration.
 */

import { CAMERA_MODELS, modelLabel, type CameraModelSpec } from "./camera-models";

export interface CameraScheduleRow {
  name: string;
  model?: string;
  /** Catalogue entry the model string resolved to, if any. */
  spec?: CameraModelSpec;
  opNumber?: number;
  x?: number;
  y?: number;
  mountM?: number;
  ipAddress?: string;
  serial?: string;
  streamRef?: string;
  notes?: string;
}

export interface CameraCsvResult {
  rows: CameraScheduleRow[];
  /** field -> the source header it was read from. */
  mapping: Partial<Record<MappedField, string>>;
  /** Headers that matched nothing (shown so a mis-export is visible). */
  unmapped: string[];
  /** Rows dropped for having no name. */
  skipped: number;
  delimiter: string;
}

export type MappedField =
  | "name"
  | "model"
  | "opNumber"
  | "x"
  | "y"
  | "mountM"
  | "ipAddress"
  | "serial"
  | "streamRef"
  | "notes";

/** Field detectors, first match wins per header, first header wins per field. */
const SNIFFERS: ReadonlyArray<[MappedField, RegExp]> = [
  ["name", /^(camera ?name|cam ?name|name|camera|label|device ?name)$/i],
  ["model", /^(make ?[/&]? ?model|model|product|device ?type|type)$/i],
  ["opNumber", /^(cam(era)? ?(no|num|number|#)|channel|ch|no|num|number|#)$/i],
  ["x", /^(x|x ?\(?m\)?|x ?pos(ition)?|easting)$/i],
  ["y", /^(y|y ?\(?m\)?|y ?pos(ition)?|northing)$/i],
  ["mountM", /^(mount(ing)? ?(height|ht)?|height|install ?height|elevation|z)( ?\(?(m|ft)\)?)?$/i],
  ["ipAddress", /^(ip( ?address)?|address|host(name)?|mgmt ?ip)$/i],
  ["serial", /^(serial( ?(no|number|#))?|s\/?n|asset( ?tag)?)$/i],
  ["streamRef", /^(rtsp|stream( ?url)?|url|uri|feed)$/i],
  ["notes", /^(notes?|comments?|remarks?|location|area|zone|room)$/i],
];

/** One CSV line -> cells, honouring double-quoted fields with "" escapes. */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Pick the delimiter that splits the header into the most columns. */
function detectDelimiter(header: string): string {
  let best = ",";
  let bestN = 0;
  for (const d of [",", ";", "\t"]) {
    const n = splitCsvLine(header, d).length;
    if (n > bestN) {
      bestN = n;
      best = d;
    }
  }
  return best;
}

/** "3.5 m" | "12ft" | "42" -> metres/number; undefined when not numeric.
 *  Feet convert; a bare number is taken as already metres. */
function num(raw: string | undefined, feetToM = false): number | undefined {
  if (!raw) return undefined;
  const m = /-?\d+(?:\.\d+)?/.exec(raw.replace(",", "."));
  if (!m) return undefined;
  let v = parseFloat(m[0]);
  if (!Number.isFinite(v)) return undefined;
  if (feetToM && /ft|feet|'/i.test(raw)) v = v / 3.28084;
  return v;
}

/** Resolve a schedule's model string against the catalogue: exact label,
 *  case-insensitive label, or the row containing the catalogue model token
 *  ("Axis P3265-LVE Mk II" still resolves to P3265-LVE). */
export function resolveModel(raw: string | undefined): CameraModelSpec | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  return (
    CAMERA_MODELS.find((m) => modelLabel(m).toLowerCase() === s) ??
    CAMERA_MODELS.find((m) => s.includes(m.model.toLowerCase()))
  );
}

export function parseCameraCsv(text: string): { ok: true; result: CameraCsvResult } | { ok: false; error: string } {
  const lines = text
    .replace(/^﻿/, "") // Excel BOM
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return { ok: false, error: "Need a header row and at least one camera row." };

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const mapping: Partial<Record<MappedField, string>> = {};
  const colOf: Partial<Record<MappedField, number>> = {};
  const unmapped: string[] = [];
  headers.forEach((h, i) => {
    const hit = SNIFFERS.find(([field, re]) => colOf[field] === undefined && re.test(h.trim()));
    if (hit) {
      mapping[hit[0]] = h.trim();
      colOf[hit[0]] = i;
    } else if (h.trim()) unmapped.push(h.trim());
  });
  if (colOf.name === undefined)
    return { ok: false, error: `No name column found. Headers seen: ${headers.filter(Boolean).join(", ")}` };

  const cell = (cells: string[], f: MappedField): string | undefined => {
    const i = colOf[f];
    const v = i !== undefined ? cells[i] : undefined;
    return v && v.trim() !== "" ? v.trim() : undefined;
  };

  const rows: CameraScheduleRow[] = [];
  let skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const cells = splitCsvLine(lines[li], delimiter);
    const name = cell(cells, "name");
    if (!name) {
      skipped++;
      continue;
    }
    const model = cell(cells, "model");
    const opRaw = num(cell(cells, "opNumber"));
    rows.push({
      name,
      model,
      spec: resolveModel(model),
      // Call-up numbers are positive integers; a fractional or negative
      // channel field is somebody's spreadsheet formula, not a number.
      opNumber: opRaw !== undefined && Number.isInteger(opRaw) && opRaw > 0 ? opRaw : undefined,
      x: num(cell(cells, "x")),
      y: num(cell(cells, "y")),
      mountM: num(cell(cells, "mountM"), true),
      ipAddress: cell(cells, "ipAddress"),
      serial: cell(cells, "serial"),
      streamRef: cell(cells, "streamRef"),
      notes: cell(cells, "notes"),
    });
  }
  if (rows.length === 0) return { ok: false, error: "Every row was missing a camera name." };

  return { ok: true, result: { rows, mapping, unmapped, skipped, delimiter } };
}
