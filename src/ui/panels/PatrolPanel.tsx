import { useStore } from "../../store";
import { distM } from "../../geo";
import { formatLength } from "../../format";
import type { MetreXY } from "../../types";

/** Length of an OPEN polyline (no wrap-around, unlike polygonPerimeter). */
function pathLength(points: MetreXY[]): number {
  let d = 0;
  for (let i = 0; i < points.length - 1; i++) d += distM(points[i], points[i + 1]);
  return d;
}

export default function PatrolPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const unit = useStore((s) => s.unit);
  const patrolDraft = useStore((s) => s.patrolDraft);
  const beginPatrol = useStore((s) => s.beginPatrol);
  const autoPatrol = useStore((s) => s.autoPatrol);
  const commitPatrol = useStore((s) => s.commitPatrol);
  const cancelPatrol = useStore((s) => s.cancelPatrol);
  const renamePatrol = useStore((s) => s.renamePatrol);
  const deletePatrol = useStore((s) => s.deletePatrol);

  const level = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const floorPatrols = (building.patrols ?? []).filter((p) => p.ordinal === ordinal);
  const drafting = patrolDraft !== null;

  return (
    <div className="panel">
      <div className="panel-title">Patrol paths</div>

      {drafting ? (
        <>
          <p className="hint">
            Click to add waypoints on {level}. Enter / double-click to finish, Esc / right-click to
            cancel. {patrolDraft?.length ?? 0} point(s).
          </p>
          <button
            className="wide active"
            onClick={commitPatrol}
            disabled={(patrolDraft?.length ?? 0) < 2}
          >
            Finish patrol
          </button>
          <button className="wide ghost" style={{ marginTop: 6 }} onClick={cancelPatrol}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="hint">Draw a guard path, or auto-generate one over the floor's rooms.</p>
          <button className="wide" onClick={() => beginPatrol(ordinal)}>
            Draw patrol
          </button>
          <button className="wide" style={{ marginTop: 6 }} onClick={() => autoPatrol(ordinal)}>
            Auto-generate
          </button>
        </>
      )}

      <div className="panel-subtitle" style={{ marginTop: 14 }}>
        On {level} ({floorPatrols.length})
      </div>
      {floorPatrols.length === 0 ? (
        <p className="hint">No patrol paths on this floor.</p>
      ) : (
        <div className="roomlist">
          {floorPatrols.map((p) => (
            <div className="roomrow" key={p.id}>
              <input
                value={p.name}
                onChange={(e) => renamePatrol(p.id, e.target.value)}
                title="Rename patrol"
              />
              <span className="unitlabel" style={{ marginRight: 6 }}>
                {formatLength(pathLength(p.points), unit)}
              </span>
              <button className="del" title="Delete" onClick={() => deletePatrol(p.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
