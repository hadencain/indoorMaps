import { useStore } from "../../store";
import { polygonArea } from "../../geo";
import { formatArea } from "../../format";
import { WALK_UNDER_M } from "../../coverage";
import {
  MIN_COLUMN_RADIUS_M,
  MAX_COLUMN_RADIUS_M,
} from "../../interaction/structures";
import type { StructureKind } from "../../types";

const KINDS: ReadonlyArray<StructureKind> = ["column", "obstacle"];
const KIND_LABELS: Record<StructureKind, string> = {
  column: "Column",
  obstacle: "Obstacle",
};

/** Property editor for the selected Structure (column tool / select-tool click),
 *  or the placement hint while the column tool is armed with nothing selected.
 *  Inputs commit onChange straight to the store (CameraPanel idiom) — the
 *  per-structure coalesce key in updateStructure folds a typing burst into one
 *  undo entry. */
export default function StructurePanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const unit = useStore((s) => s.unit);
  const selectedStructureId = useStore((s) => s.selectedStructureId);
  const updateStructure = useStore((s) => s.updateStructure);
  const deleteStructure = useStore((s) => s.deleteStructure);

  const level = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const selected =
    (building.structures ?? []).find((s) => s.id === selectedStructureId) ?? null;

  // ---- No structure selected: placement hint (column tool armed) ----
  if (!selected) {
    return (
      <div className="panel">
        <div className="panel-title">Structures</div>
        <p className="hint">
          Click the canvas to place a column on {level}. Structures are solid —
          they block camera sightlines (unlike fixtures) and extrude in the 3D
          view. Select one with the Select tool to edit it.
        </p>
      </div>
    );
  }

  // ---- Structure selected: property editor ----
  // Captured as a const so the narrowing survives into the input closures.
  const round = selected.round;

  return (
    <div className="panel">
      <div className="panel-title">Structure</div>

      <label>Kind</label>
      <select
        value={selected.kind}
        onChange={(e) =>
          updateStructure(selected.id, { kind: e.target.value as StructureKind })
        }
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>

      {round && (
        <>
          <label>Radius (m)</label>
          <input
            type="number"
            min={MIN_COLUMN_RADIUS_M}
            max={MAX_COLUMN_RADIUS_M}
            step={0.05}
            value={round.radiusM}
            onChange={(e) => {
              // Clamp into [MIN, MAX]; the store regenerates the 12-gon
              // footprint from the round hint in the same commit.
              const v = Math.min(
                MAX_COLUMN_RADIUS_M,
                Math.max(MIN_COLUMN_RADIUS_M, Number(e.target.value) || MIN_COLUMN_RADIUS_M),
              );
              updateStructure(selected.id, { round: { center: round.center, radiusM: v } });
            }}
          />
        </>
      )}

      <label>Height (m · blank = full height)</label>
      <input
        type="number"
        min={0}
        step={0.1}
        placeholder="full height"
        value={selected.heightM ?? ""}
        onChange={(e) => {
          // Blank restores the absent-semantics default: the level's ceiling.
          const raw = e.target.value;
          updateStructure(selected.id, {
            heightM: raw === "" ? undefined : Math.max(0, Number(raw) || 0),
          });
        }}
      />

      <label>Base height (m)</label>
      <input
        type="number"
        min={0}
        step={0.1}
        value={selected.baseM ?? 0}
        onChange={(e) =>
          updateStructure(selected.id, { baseM: Math.max(0, Number(e.target.value) || 0) })
        }
      />
      <p className="hint">
        Above {WALK_UNDER_M} m it stops blocking 2D sightlines (walk-under).
      </p>

      <div className="readout mono" style={{ marginTop: 12 }}>
        footprint {formatArea(polygonArea(selected.polygon), unit)}
      </div>

      <button
        className="wide danger"
        style={{ marginTop: 12 }}
        onClick={() => deleteStructure(selected.id)}
      >
        Delete structure
      </button>
    </div>
  );
}
