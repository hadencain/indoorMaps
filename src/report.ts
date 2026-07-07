// Security report generator — pure module, consumes coverage.ts (no React).
// Produces a Markdown document: per-floor camera inventory + coverage % +
// blind-spot summary, using the real coverage API (collectWalls +
// computeVisibility + computeCoverage). Graceful when a floor has no cameras.

import type { Building } from "./types";
import { collectWalls, computeVisibility, computeCoverage } from "./coverage";
import type { VisibilityPolygon } from "./coverage";

function round(n: number, d = 1): string {
  return n.toFixed(d);
}

/** Build a Markdown security report for the whole building. */
export function buildSecurityReport(building: Building): string {
  const lines: string[] = [];
  lines.push("# Security Report");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push("");

  const totalCams = building.cameras.length;
  lines.push(
    `**${building.levels.length}** floor(s) · **${building.units.length}** units · ` +
      `**${totalCams}** camera(s)`,
  );
  lines.push("");

  const levels = [...building.levels].sort((a, b) => a.ordinal - b.ordinal);

  for (const lv of levels) {
    lines.push(`## ${lv.name} (ordinal ${lv.ordinal})`);
    lines.push("");

    const cams = building.cameras.filter((c) => c.ordinal === lv.ordinal);

    // Camera inventory.
    if (cams.length === 0) {
      lines.push("_No cameras on this floor._");
      lines.push("");
    } else {
      lines.push("### Cameras");
      lines.push("");
      lines.push("| id | kind | heading | fov | range | name |");
      lines.push("|----|------|---------|-----|-------|------|");
      for (const c of cams) {
        const heading = c.kind === "dome" ? "—" : `${Math.round(c.heading)}°`;
        const fov = c.kind === "dome" ? "360°" : `${Math.round(c.fovDeg)}°`;
        lines.push(
          `| ${c.id} | ${c.kind} | ${heading} | ${fov} | ${round(c.rangeM)} m | ${c.name} |`,
        );
      }
      lines.push("");
    }

    // Coverage / blind-spot analysis via the real coverage API.
    const walls = collectWalls(building, lv.ordinal);
    const visPolys: VisibilityPolygon[] = cams.map((c) => ({
      cameraId: c.id,
      ordinal: lv.ordinal,
      ring: computeVisibility(c, walls),
    }));
    const cov = computeCoverage(building, lv.ordinal, visPolys);
    const blindAreaM2 = Math.max(0, cov.floorAreaM2 - cov.coveredAreaM2);

    lines.push("### Coverage");
    lines.push("");
    lines.push(`- Floor area: **${round(cov.floorAreaM2)} m²**`);
    lines.push(
      `- Covered: **${round(cov.coveredAreaM2)} m²** (**${round(cov.coveragePct * 100, 0)}%**)`,
    );
    lines.push(
      `- Blind spots: **${cov.blindRings.length}** region(s), **${round(blindAreaM2)} m²**`,
    );
    lines.push("");
  }

  return lines.join("\n");
}
