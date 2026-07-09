import type { Building } from "../types";
import { casinoBuilding } from "./casino";
import { venueSmallBuilding } from "./venue-small";

/** A shipped demo property. All demos are statically imported — bundle grows
 *  with each venue (accepted for a local-first app; lazy import() per property
 *  is the future knob if size ever matters). */
export interface DemoProperty {
  id: string;
  name: string;
  building: Building;
}

export const DEMOS: DemoProperty[] = [
  { id: "casino", name: "Grand Casino", building: casinoBuilding },
  { id: "venue-small", name: "The Basement", building: venueSmallBuilding },
];

export const DEFAULT_PROPERTY_ID = "casino";

export function demoById(id: string): DemoProperty {
  return DEMOS.find((d) => d.id === id) ?? DEMOS[0];
}
