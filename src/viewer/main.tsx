import React from "react";
import ReactDOM from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./viewer.css";
import { parseBuildingFileText, withBuildingDefaults } from "../persistence";
import type { Building } from "../types";
import Viewer from "./Viewer";

/** "casino-vault" -> "Casino Vault". Building carries no display-name field
 *  (see types.ts) and properties.ts (which maps a propertyId to a friendly
 *  demo/user name) pulls in the demo registry — off-limits here — so the
 *  viewer just title-cases the propertyId embedded alongside the building. */
function formatPropertyName(id: string): string {
  const words = id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : "Property";
}

function boot(): void {
  const root = ReactDOM.createRoot(document.getElementById("viewer-root")!);
  const text = document.getElementById("building-data")?.textContent ?? "";
  const parsed = parseBuildingFileText(text);

  if (!parsed) {
    root.render(
      <React.StrictMode>
        <div className="viewer-empty">
          <p>No building embedded in this file.</p>
        </div>
      </React.StrictMode>,
    );
    return;
  }

  const building = withBuildingDefaults(parsed.building) as unknown as Building;
  const propertyName = parsed.propertyId ? formatPropertyName(parsed.propertyId) : "Property";

  root.render(
    <React.StrictMode>
      <Viewer building={building} propertyName={propertyName} />
    </React.StrictMode>,
  );
}

boot();
