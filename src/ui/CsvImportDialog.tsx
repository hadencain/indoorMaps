import { useEffect, useMemo } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import type { CameraCsvResult } from "../camera-csv";

interface Props {
  result: CameraCsvResult;
  onClose: () => void;
}

/** Camera-schedule preview: what the sniffer decided, shown BEFORE anything is
 *  imported. Liberal header matching with a silent apply would be the same
 *  silent-wrong class as the letterboxed calibration — the mapping table is
 *  the operator's chance to see "Location" landed in notes, not on the map. */
export default function CsvImportDialog({ result, onClose }: Props) {
  const importCameraSchedule = useStore((s) => s.importCameraSchedule);
  const building = useStore((s) => s.building);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stats = useMemo(() => {
    const names = new Set(building.cameras.map((c) => c.name.trim().toLowerCase()));
    const enrich = result.rows.filter((r) => names.has(r.name.trim().toLowerCase())).length;
    return {
      enrich,
      create: result.rows.length - enrich,
      rated: result.rows.filter((r) => r.spec).length,
      placed: result.rows.filter((r) => r.x != null && r.y != null).length,
    };
  }, [result.rows, building.cameras]);

  const doImport = () => {
    const s = importCameraSchedule(result.rows);
    useStore.setState({
      importMsg:
        `Schedule imported: ${s.created} created (${s.staged} on the staging line), ` +
        `${s.enriched} enriched, ${s.rated} catalogue-rated` +
        (s.numberCollisions ? `, ${s.numberCollisions} number collision${s.numberCollisions === 1 ? "" : "s"} dropped` : ""),
    });
    onClose();
  };

  return (
    <div className="wiz-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wiz">
        <div className="wiz-head">
          <span className="wiz-title">Import camera schedule (CSV)</span>
          <button className="wiz-x" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
        <div className="wiz-body">
          <div className="csv-mapping mono">
            {(Object.entries(result.mapping) as [string, string][]).map(([field, header]) => (
              <div key={field} className="csv-map-row">
                <span className="csv-field">{field}</span>
                <span className="csv-arrow">←</span>
                <span className="csv-header">{header}</span>
              </div>
            ))}
            {result.unmapped.length > 0 && (
              <div className="csv-map-row dim">
                <span className="csv-field">ignored</span>
                <span className="csv-arrow">←</span>
                <span className="csv-header">{result.unmapped.join(", ")}</span>
              </div>
            )}
          </div>

          <p className="hint" style={{ marginTop: 10 }}>
            {result.rows.length} camera{result.rows.length === 1 ? "" : "s"}
            {result.skipped > 0 ? ` (${result.skipped} nameless row${result.skipped === 1 ? "" : "s"} skipped)` : ""} ·{" "}
            {stats.enrich} match existing by name · {stats.create} new ·{" "}
            {stats.rated} catalogue-rated ·{" "}
            {stats.placed} with coordinates
            {stats.create - stats.placed > 0
              ? ` — the other ${stats.create - stats.placed} land on a staging line to drag into place`
              : ""}
          </p>

          <div className="csv-preview mono">
            {result.rows.slice(0, 4).map((r, i) => (
              <div key={i} className="csv-prev-row">
                {r.name}
                {r.model ? ` · ${r.model}${r.spec ? " ✓" : " (unknown model)"}` : ""}
                {r.opNumber != null ? ` · #${r.opNumber}` : ""}
                {r.mountM != null ? ` · ${r.mountM.toFixed(1)} m` : ""}
              </div>
            ))}
            {result.rows.length > 4 && <div className="csv-prev-row dim">… {result.rows.length - 4} more</div>}
          </div>

          <div className="wiz-actions">
            <button className="wiz-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <span className="wiz-spacer" />
            <button className="wiz-btn primary" onClick={doImport}>
              Import {result.rows.length} camera{result.rows.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
