// IMDF-flavored data model (simplified for the viewer-core spike).
// Real IMDF is a set of GeoJSON FeatureCollections per feature type
// (venue, building, level, unit, opening, ...). We keep the same *concepts*
// — levels with an ordinal, units (rooms/corridors), openings (doors),
// and vertical connections — authored in local metres and projected to lng/lat.

export type LngLat = [number, number];
export type MetreXY = [number, number];

export type Category = "room" | "corridor" | "elevator";

export interface Level {
  ordinal: number;
  name: string;
}

export interface Unit {
  id: string;
  ordinal: number;
  name: string;
  category: Category;
  /** Polygon outline in local metres, as an open ring (no repeated last point). */
  polygon: MetreXY[];
}

/** A door: connects `unit` to the corridor on the same ordinal at point `at`. */
export interface Opening {
  unit: string;
  at: MetreXY;
}

/** A stair/elevator run connecting two units across ordinals. */
export interface Vertical {
  a: string;
  b: string;
  name: string;
}

export interface Building {
  /** SW origin of the local metre grid, as [lng, lat]. */
  origin: LngLat;
  levels: Level[];
  units: Unit[];
  openings: Opening[];
  verticals: Vertical[];
}

export interface NodeMeta {
  id: string;
  ordinal: number;
  xy: MetreXY;
  lnglat: LngLat;
  kind: "unit" | "door";
  name?: string;
  category?: Category;
}

export interface Edge {
  to: string;
  w: number;
}

export interface Graph {
  nodes: Map<string, NodeMeta>;
  adj: Map<string, Edge[]>;
}
