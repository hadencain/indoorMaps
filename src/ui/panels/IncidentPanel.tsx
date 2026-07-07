import { useStore } from "../../store";
import type { IncidentKind } from "../../types";

const KINDS: ReadonlyArray<IncidentKind> = [
  "trespass",
  "theft",
  "vandalism",
  "medical",
  "hazard",
  "alarm",
  "other",
];

const KIND_LABELS: Record<IncidentKind, string> = {
  trespass: "Trespass",
  theft: "Theft",
  vandalism: "Vandalism",
  medical: "Medical",
  hazard: "Hazard",
  alarm: "Alarm",
  other: "Other",
};

/** Marker color per kind — kept in sync with MapView's incident pins. */
export const INCIDENT_COLORS: Record<IncidentKind, string> = {
  trespass: "#ff5c5c",
  theft: "#f2a13d",
  vandalism: "#c678dd",
  medical: "#43d675",
  hazard: "#f2c14e",
  alarm: "#ff3b6b",
  other: "#8aa0b6",
};

export default function IncidentPanel() {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const incidentKind = useStore((s) => s.incidentKind);
  const selectedIncidentId = useStore((s) => s.selectedIncidentId);
  const setIncidentKind = useStore((s) => s.setIncidentKind);
  const setSelectedIncident = useStore((s) => s.setSelectedIncident);
  const updateIncident = useStore((s) => s.updateIncident);
  const deleteIncident = useStore((s) => s.deleteIncident);

  const level = building.levels.find((l) => l.ordinal === ordinal)?.name ?? `L${ordinal}`;
  const floorIncidents = (building.incidents ?? []).filter((i) => i.ordinal === ordinal);
  const selected = (building.incidents ?? []).find((i) => i.id === selectedIncidentId) ?? null;

  return (
    <div className="panel">
      <div className="panel-title">Incidents</div>
      <p className="hint">Click the canvas to drop a pin on {level}.</p>

      <label>New pin kind</label>
      <select value={incidentKind} onChange={(e) => setIncidentKind(e.target.value as IncidentKind)}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>

      {selected && (
        <>
          <div className="panel-subtitle" style={{ marginTop: 14 }}>
            Selected pin
          </div>
          <label>Kind</label>
          <select
            value={selected.kind}
            onChange={(e) =>
              updateIncident(selected.id, { kind: e.target.value as IncidentKind })
            }
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <label>Note</label>
          <textarea
            className="notearea"
            rows={3}
            value={selected.note}
            placeholder="What happened here…"
            onChange={(e) => updateIncident(selected.id, { note: e.target.value })}
          />
          <button
            className="wide danger"
            style={{ marginTop: 8 }}
            onClick={() => deleteIncident(selected.id)}
          >
            Delete pin
          </button>
        </>
      )}

      <div className="panel-subtitle" style={{ marginTop: 14 }}>
        On {level} ({floorIncidents.length})
      </div>
      {floorIncidents.length === 0 ? (
        <p className="hint">No incidents on this floor.</p>
      ) : (
        <div className="roomlist">
          {floorIncidents.map((i) => (
            <div className={`roomrow ${i.id === selectedIncidentId ? "selected" : ""}`} key={i.id}>
              <button
                className="camrow-select"
                onClick={() => setSelectedIncident(i.id)}
                title="Select incident"
              >
                <span
                  className="inc-dot"
                  style={{ background: INCIDENT_COLORS[i.kind] }}
                  aria-hidden
                />
                <span className="vlabel">{KIND_LABELS[i.kind]}</span>
                <span className="camrow-kind">{i.note ? i.note.slice(0, 18) : "—"}</span>
              </button>
              <button className="del" title="Delete" onClick={() => deleteIncident(i.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
