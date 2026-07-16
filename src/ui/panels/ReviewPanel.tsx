import { useMemo } from "react";
import { useStore } from "../../store";
import { reviewFloor, type ReviewIssue, type ReviewSeverity } from "../../interaction/health";

const SEV_GLYPH: Record<ReviewSeverity, string> = { error: "✕", warn: "!", info: "·" };

/** Authoring-health worklist for the active floor: every row is an actionable
 *  problem; clicking selects the offender and flies to it. Shares predicates
 *  with the on-canvas badges (badges = ambient signal, this panel = worklist). */
export default function ReviewPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setSelected = useStore((s) => s.setSelected);
  const requestFly = useStore((s) => s.requestFly);
  const issues = useMemo(() => reviewFloor(building, ordinal), [building, ordinal]);
  const level = building.levels.find((l) => l.ordinal === ordinal);

  const go = (issue: ReviewIssue) => {
    if (issue.unitId) setSelected(issue.unitId);
    if (issue.at) requestFly(issue.at, ordinal);
  };

  return (
    <div className="panel">
      <div className="panel-title">Review — {level?.name ?? `Floor ${ordinal}`}</div>
      {issues.length === 0 ? (
        <p className="hint">No issues on this floor. Routing, doors, names, and tenancy all check out.</p>
      ) : (
        <div className="roomlist">
          {issues.map((i) => (
            <div className="roomrow" key={i.id}>
              <button className={`review-row sev-${i.severity}`} onClick={() => go(i)}
                title={i.unitId || i.at ? "Show on map" : undefined}>
                <span className="review-glyph">{SEV_GLYPH[i.severity]}</span>
                <span className="vlabel">{i.message}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        Errors break routing. Warnings are reachability or data smells. Info is tenancy.
      </p>
    </div>
  );
}
