import { FUNCTION_LABELS, FUNCTION_COLORS } from "../categories";
import { useStore } from "../store";

/**
 * Display-mode map chrome: a north arrow + a legend keyed to the functional room
 * fills, security tints, and marker glyphs. Plan grammar every professional
 * top-down plan has (the metric scale bar is a MapLibre ScaleControl in MapView).
 * Bearing is locked to 0 (dragRotate off), so the plan is always true north-up.
 */

const FILL_KEYS = ["gaming", "circ", "premium", "fnb", "show", "sport", "cage", "boh"];

export default function MapChrome() {
  const view3d = useStore((s) => s.view3d);

  return (
    <>
      {!view3d && (
        <div className="north-badge" title="Plan is north-up">
          <span className="north-arrow">▲</span>
          <span className="north-n">N</span>
        </div>
      )}
      <div className="map-legend">
        <div className="legend-title">Legend</div>
        <div className="legend-grid">
          {FILL_KEYS.map((k) => (
            <div className="legend-row" key={k}>
              <span className="legend-swatch" style={{ background: FUNCTION_COLORS[k] }} />
              <span>{FUNCTION_LABELS[k]}</span>
            </div>
          ))}
        </div>
        <div className="legend-sep" />
        <div className="legend-grid">
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "rgba(242,193,78,0.5)", borderColor: "#f2c14e" }} />
            <span>Secure zone</span>
          </div>
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "rgba(255,92,92,0.55)", borderColor: "#ff5c5c" }} />
            <span>Restricted</span>
          </div>
          <div className="legend-row">
            <span className="legend-dot" />
            <span>Camera (dome)</span>
          </div>
          <div className="legend-row">
            <span className="legend-glyph" />
            <span>Fixed / PTZ</span>
          </div>
        </div>
      </div>
    </>
  );
}
