import { useState } from "react";
import type { Building, MetreXY, Occupant, OccupantCategory } from "../types";
import { OCCUPANT_CATEGORY_LABELS, occupantAnchor } from "../occupants";
import { isSpace } from "../categories";
import { polygonCentroid } from "../geo";

/** True when an occupant carries any of the detail fields the expanded row
 *  can show — a row with none of these renders exactly as before (name +
 *  unit, no toggle). */
function hasDetails(o: Occupant): boolean {
  return Boolean(o.logo || o.hours || o.phone || o.website);
}

/** `example.com` → `https://example.com`. Occupant.website is freeform (same
 *  authoring input as PropertiesPanel's OccupantRow, no protocol enforced),
 *  so a bare domain would otherwise resolve as a relative link from a
 *  file:// export. */
function websiteHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Tenant directory (display-mode's FloorContentsPanel "Tenants" view, minus
 *  authoring). Occupants grouped by OCCUPANT_CATEGORY_LABELS, building-wide
 *  (not floor-scoped — a visitor browsing the directory shouldn't have to
 *  hunt floor by floor); clicking one flies the map to its unit and switches
 *  floor if needed. Vacant selectable spaces list separately below. A second
 *  small toggle button (only present when the occupant has detail fields)
 *  expands that row in place to show logo/hours/phone/website — the visitor
 *  export keeps this data on the occupant record, so the viewer should
 *  actually surface it. Single-expand, mirroring PropertiesPanel's
 *  OccupantRow idiom. Site info (hours + photos) is a collapsible block at
 *  the top of the panel, shown only when the building has any to show. */
export default function Directory({
  building,
  onGo,
}: {
  building: Building;
  onGo: (unitId: string, ordinal: number, center: MetreXY) => void;
}) {
  const unitById = new Map(building.units.map((u) => [u.id, u]));
  const occupants = building.occupants ?? [];
  const occupiedUnitIds = new Set(occupants.map((o) => o.unitId));
  const vacant = building.units.filter(
    (u) => isSpace(u.category) && u.category !== "outside" && !occupiedUnitIds.has(u.id),
  );

  const [expandedOcc, setExpandedOcc] = useState<string | null>(null);
  const [siteOpen, setSiteOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const siteInfo = building.siteInfo;
  const hasSiteInfo = Boolean(siteInfo && (siteInfo.hours || siteInfo.photos.length > 0));

  const go = (unitId: string, at: MetreXY) => {
    const u = unitById.get(unitId);
    if (!u) return;
    onGo(unitId, u.ordinal, at);
  };

  return (
    <div className="panel">
      <div className="panel-title">Directory</div>
      {hasSiteInfo && siteInfo && (
        <div className="siteinfo">
          <button className="siteinfo-toggle" onClick={() => setSiteOpen((v) => !v)}>
            <span>Site info</span>
            <span className="siteinfo-chev">{siteOpen ? "▴" : "▾"}</span>
          </button>
          {siteOpen && (
            <div className="siteinfo-body">
              {siteInfo.hours && <p className="siteinfo-hours">{siteInfo.hours}</p>}
              {siteInfo.photos.length > 0 && (
                <div className="siteinfo-photos">
                  {siteInfo.photos.map((p, i) => (
                    <img
                      key={i}
                      className="siteinfo-photo"
                      src={p}
                      alt={`site photo ${i + 1}`}
                      onClick={() => setLightbox(p)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {occupants.length === 0 && vacant.length === 0 && <p className="hint">No tenants listed.</p>}
      {(Object.keys(OCCUPANT_CATEGORY_LABELS) as OccupantCategory[]).map((cat) => {
        const group = occupants.filter((o) => o.category === cat);
        if (group.length === 0) return null;
        return (
          <div key={cat}>
            <div className="panel-subtitle" style={{ marginTop: 10 }}>
              {OCCUPANT_CATEGORY_LABELS[cat]}
            </div>
            <div className="roomlist">
              {group.map((o) => {
                const u = unitById.get(o.unitId);
                const expandable = hasDetails(o);
                const expanded = expandable && expandedOcc === o.id;
                return (
                  <div className={`occrow ${expanded ? "open" : ""}`} key={o.id}>
                    <div className="roomrow">
                      <button
                        className="occ-head"
                        onClick={() => go(o.unitId, occupantAnchor(building, o))}
                        title="Show on map"
                      >
                        <span className="vlabel">{o.name}</span>
                        <span className="occ-cat">{u?.name ?? ""}</span>
                      </button>
                      {expandable && (
                        <button
                          className="occ-toggle"
                          title={expanded ? "Hide details" : "Show details"}
                          onClick={() => setExpandedOcc(expanded ? null : o.id)}
                        >
                          {expanded ? "▴" : "▾"}
                        </button>
                      )}
                    </div>
                    {expanded && (
                      <div className="occ-detail">
                        {o.logo && <img className="occ-logo" src={o.logo} alt={`${o.name} logo`} />}
                        {o.hours && (
                          <div className="occ-detail-row">
                            <span className="k">Hours</span>
                            <span>{o.hours}</span>
                          </div>
                        )}
                        {o.phone && (
                          <div className="occ-detail-row">
                            <span className="k">Phone</span>
                            <a href={`tel:${o.phone}`}>{o.phone}</a>
                          </div>
                        )}
                        {o.website && (
                          <div className="occ-detail-row">
                            <span className="k">Web</span>
                            <a href={websiteHref(o.website)} target="_blank" rel="noopener noreferrer">
                              {o.website}
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {vacant.length > 0 && (
        <>
          <div className="panel-subtitle" style={{ marginTop: 10 }}>
            Other spaces
          </div>
          <div className="roomlist">
            {vacant.map((u) => (
              <div className="roomrow" key={u.id}>
                <button
                  className="occ-head"
                  onClick={() => go(u.id, polygonCentroid(u.polygon))}
                  title="Show on map"
                >
                  <span className="vlabel">{u.name}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {lightbox && (
        <div className="siteinfo-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="site photo" />
        </div>
      )}
    </div>
  );
}
