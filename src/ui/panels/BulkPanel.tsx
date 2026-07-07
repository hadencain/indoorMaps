import { useStore } from "../../store";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../../categories";
import { SECURITY_LEVELS, SECURITY_LABELS } from "../security";
import type { Category, SecurityLevel } from "../../types";

/** Shown when more than one unit is selected (shift-click). Applies a category
 *  or security level to every selected unit in ONE undoable step. The two
 *  <select>s are placeholder-controlled (value stays "") because the selection
 *  may hold mixed values — picking an option applies it and resets the control. */
export default function BulkPanel() {
  const selectedIds = useStore((s) => s.selectedIds);
  const bulkSetCategory = useStore((s) => s.bulkSetCategory);
  const bulkSetSecurity = useStore((s) => s.bulkSetSecurity);
  const clearSelection = useStore((s) => s.clearSelection);

  return (
    <div className="panel">
      <div className="panel-title">Bulk edit</div>
      <p className="hint">{selectedIds.length} units selected</p>

      <label>Set category</label>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) bulkSetCategory(selectedIds, e.target.value as Category);
        }}
      >
        <option value="">Choose a category…</option>
        {CATEGORY_ORDER.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>

      <label>Set security</label>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) bulkSetSecurity(selectedIds, e.target.value as SecurityLevel);
        }}
      >
        <option value="">Choose a level…</option>
        {SECURITY_LEVELS.map((lvl) => (
          <option key={lvl} value={lvl}>
            {SECURITY_LABELS[lvl]}
          </option>
        ))}
      </select>

      <button className="wide ghost" style={{ marginTop: 12 }} onClick={clearSelection}>
        Clear selection
      </button>
    </div>
  );
}
