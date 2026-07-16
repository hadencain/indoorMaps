import { useMemo } from "react";
import { useStore } from "../store";
import { guideStages, guideComplete, activeStage, type GuideStage } from "../interaction/guide";

/** Staged authoring guide for freshly created user properties: live done-marks
 *  derived from the building (never stored), one instruction at a time, each
 *  stage pre-arming the right tool. Dismiss persists per property; Data →
 *  "Setup guide" re-opens it. Demos never see this. */
export default function SetupGuide() {
  const building = useStore((s) => s.building);
  const propertyId = useStore((s) => s.propertyId);
  const userProperties = useStore((s) => s.userProperties);
  const guideDismissed = useStore((s) => s.guideDismissed);
  const dismissGuide = useStore((s) => s.dismissGuide);
  const setTool = useStore((s) => s.setTool);
  const setDraftCategory = useStore((s) => s.setDraftCategory);

  const isUserProperty = userProperties.some((u) => u.id === propertyId);
  const stages = useMemo(() => guideStages(building), [building]);
  if (!isUserProperty || guideDismissed[propertyId]) return null;

  const active = activeStage(stages);
  const complete = guideComplete(stages);
  const act = (s: GuideStage) => {
    if (s.id === "rooms") setTool("rect");
    else if (s.id === "doors") {
      setDraftCategory("corridor");
      setTool("rect");
    } else if (s.id === "occupants") setTool("select");
    else if (s.id === "review") setTool("review");
    // underlay/floors: no tool — the instruction names the affordance.
  };

  return (
    <div className="setup-guide">
      <div className="setup-guide-head">
        <span>Setup guide</span>
        <button className="del" title="Dismiss (Data → Setup guide re-opens)" onClick={() => dismissGuide(propertyId)}>
          ✕
        </button>
      </div>
      <div className="setup-guide-steps">
        {stages.map((s) => (
          <div key={s.id} className={`setup-step ${s.done ? "done" : ""} ${active?.id === s.id ? "active" : ""}`}>
            <span className="setup-mark">{s.done ? "✓" : "○"}</span>
            <span className="setup-label">
              {s.label}
              {s.optional && <span className="setup-opt"> · optional</span>}
            </span>
          </div>
        ))}
      </div>
      {complete ? (
        <div className="setup-guide-foot">
          <span className="setup-done-msg">Setup complete — the building reviews clean.</span>
          <button className="wide ghost" onClick={() => dismissGuide(propertyId)}>
            Done
          </button>
        </div>
      ) : (
        active && (
          <div className="setup-guide-foot">
            <p className="setup-instruction">{active.instruction}</p>
            {(active.id === "rooms" || active.id === "doors" || active.id === "occupants" || active.id === "review") && (
              <button className="wide" onClick={() => act(active)}>
                {active.id === "rooms" && "Start tracing"}
                {active.id === "doors" && "Draw the corridor"}
                {active.id === "occupants" && "Add tenants"}
                {active.id === "review" && "Open review"}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
