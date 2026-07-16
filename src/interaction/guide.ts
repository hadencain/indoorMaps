import type { Building } from "../types";
import { floorHealth, reviewFloor } from "./health";
import { isSpace } from "../categories";

export type GuideStageId = "underlay" | "floors" | "rooms" | "doors" | "occupants" | "review";

export interface GuideStage {
  id: GuideStageId;
  label: string;        // "Trace rooms"
  instruction: string;  // one line shown when this is the active stage
  done: boolean;
  optional: boolean;
}

const floorsWithRooms = (b: Building): number[] => {
  const ords = new Set<number>();
  for (const u of b.units) if (isSpace(u.category) && u.category !== "outside") ords.add(u.ordinal);
  return [...ords];
};

export function guideStages(building: Building): GuideStage[] {
  const stages: GuideStage[] = [];

  // underlay: done if underlays exist, optional
  stages.push({
    id: "underlay",
    label: "Floorplan image",
    instruction: "Optional — import a floorplan to trace over: Data → Import floorplan image.",
    done: (building.underlays ?? []).length > 0,
    optional: true,
  });

  // floors: done if more than 1 level, optional
  stages.push({
    id: "floors",
    label: "Add floors",
    instruction: "Optional — add upper floors with the + button next to the floor pills.",
    done: building.levels.length > 1,
    optional: true,
  });

  // rooms: done if there are rooms (spaces with category !== "outside")
  const roomsDone = floorsWithRooms(building).length > 0;
  stages.push({
    id: "rooms",
    label: "Trace rooms",
    instruction: "Draw rooms with Rectangle or Polygon — walls snap to neighbors.",
    done: roomsDone,
    optional: false,
  });

  // doors: done if rooms done AND every ordinal in floorsWithRooms has no missing corridor and no doorless rooms
  const doorsDone = roomsDone && floorsWithRooms(building).every((ord) => {
    const health = floorHealth(building, ord);
    return !health.missingCorridor && health.doorlessRoomIds.length === 0;
  });
  stages.push({
    id: "doors",
    label: "Corridor & doors",
    instruction: "Draw a corridor (category pre-set), then drag each room's door dot onto a shared wall.",
    done: doorsDone,
    optional: false,
  });

  // occupants: done if occupants exist, optional
  stages.push({
    id: "occupants",
    label: "Add tenants",
    instruction: `Optional — select a room and use "+ Add occupant" for tenant names and details.`,
    done: (building.occupants ?? []).length > 0,
    optional: true,
  });

  // review: done if doors done AND every ordinal in floorsWithRooms has no error-severity issues
  const reviewDone = doorsDone && floorsWithRooms(building).every((ord) =>
    reviewFloor(building, ord).every((i) => i.severity !== "error"),
  );
  stages.push({
    id: "review",
    label: "Review",
    instruction: "Open the Review checklist and clear anything routing can't survive.",
    done: reviewDone,
    optional: false,
  });

  return stages;
}

export function guideComplete(stages: GuideStage[]): boolean {
  return stages.filter((s) => !s.optional).every((s) => s.done);
}

export function activeStage(stages: GuideStage[]): GuideStage | null {
  if (guideComplete(stages)) return null;

  // If any required stage is done, focus on the next required stage
  const anyRequiredDone = stages.some((s) => s.done && !s.optional);

  if (anyRequiredDone) {
    for (const stage of stages) {
      if (!stage.done && !stage.optional) {
        return stage;
      }
    }
  }

  // Otherwise (empty building, no progress yet), return first incomplete stage
  for (const stage of stages) {
    if (!stage.done) {
      return stage;
    }
  }

  return null;
}
