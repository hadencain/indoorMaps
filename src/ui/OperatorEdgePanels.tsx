import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  ImagePlus,
  LayoutGrid,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import Feed from "./panels/Feed";
import { useStore, ALL_AMENITY_KINDS } from "../store";
import { m2ll } from "../geo";
import { panStep, zoomStep, tiltStep } from "../security/ptz";
import { HoldButton } from "./CameraWindow";
import { fileToSmallDataUrl } from "./img";
import type { AmenityKind, Camera, CameraKind } from "../types";

/**
 * Display-mode edge panels for surveillance operators. Transparent arrows sit
 * flush on the map's left/right edges; each slides out a semi-transparent
 * overlay:
 *  - LEFT — camera finder: search by the site's numbering convention
 *    ("14-parkingGarage1"), filter by kind, floor scope, click to open the
 *    feed + fly the map to the mount, and quick FOV/range adjust for the
 *    selected camera.
 *  - RIGHT — site info: location photos, opening hours, and amenity search
 *    with click-to-locate (flies the map to the marker and pulses it).
 */

const KIND_CHIPS: { id: CameraKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "fixed", label: "Fixed" },
  { id: "dome", label: "Dome" },
  { id: "ptz", label: "PTZ" },
];

import { AmenityIcon, AMENITY_LABELS as AMENITY_LABEL } from "./amenity-icons";

function CameraFinder({ map, onOpenWall }: { map: maplibregl.Map; onOpenWall: (viewId: string) => void }) {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<CameraKind | "all">("all");
  const [allFloors, setAllFloors] = useState(false);
  // Preset-view authoring state (which view is being edited, new-view name).
  const views = building.cameraViews ?? [];
  const addCameraView = useStore((s) => s.addCameraView);
  const deleteCameraView = useStore((s) => s.deleteCameraView);
  const addCameraToView = useStore((s) => s.addCameraToView);
  const removeCameraFromView = useStore((s) => s.removeCameraFromView);
  const moveCameraInView = useStore((s) => s.moveCameraInView);
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [dropHot, setDropHot] = useState(false);
  const editingView = views.find((v) => v.id === editingViewId) ?? null;

  const { cams, matchTotal } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = building.cameras
      .filter((c) => allFloors || c.ordinal === ordinal)
      .filter((c) => kind === "all" || c.kind === kind)
      .filter((c) => needle === "" || c.name.toLowerCase().includes(needle));
    return { cams: all.slice(0, 200), matchTotal: all.length };
  }, [building.cameras, ordinal, allFloors, kind, q]);

  const levelName = (o: number) =>
    building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  const open = (cam: Camera) => {
    // Cross-floor pick: switch floors first (this clears selection), then
    // select — the operator sidebar opens the feed, the map flies to the mount.
    if (cam.ordinal !== ordinal) setOrdinal(cam.ordinal);
    setSelectedCamera(cam.id);
    map.easeTo({ center: m2ll(building.origin, cam.at[0], cam.at[1]), duration: 450 });
  };

  // PTZ-only live controls for the selected camera (operators aim and zoom —
  // they don't re-spec hardware, so there is no FOV/range configuration here).
  // Same mechanics as the camera window's pad: getState per tick, one undo
  // snapshot per hold via beginCameraGesture.
  const selected = building.cameras.find((c) => c.id === selectedCameraId) ?? null;
  const ptzFire = (patch: (c: Camera) => Partial<Camera>) => () => {
    const s = useStore.getState();
    const cam = s.building.cameras.find((c) => c.id === s.selectedCameraId);
    if (cam) s.updateCameraLive(cam.id, patch(cam));
  };
  const beginGesture = () => useStore.getState().beginCameraGesture();

  return (
    <>
      <div className="edge-title">Camera finder</div>
      <input
        className="edge-search"
        placeholder="Search… e.g. 14-parkingGarage1"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="edge-chips">
        {KIND_CHIPS.map((k) => (
          <button
            key={k.id}
            className={`edge-chip ${kind === k.id ? "on" : ""}`}
            onClick={() => setKind(k.id)}
          >
            {k.label}
          </button>
        ))}
        <button
          className={`edge-chip scope ${allFloors ? "on" : ""}`}
          title="Include cameras on every floor"
          onClick={() => setAllFloors((v) => !v)}
        >
          {allFloors ? "All floors" : levelName(ordinal)}
        </button>
      </div>
      <div className="edge-count mono">
        {matchTotal > cams.length
          ? `first ${cams.length} of ${matchTotal} cameras — refine the search`
          : `${matchTotal} camera${matchTotal === 1 ? "" : "s"}`}
      </div>
      <div className="edge-list">
        {cams.map((c) => (
          <div
            key={c.id}
            className={`edge-row ${c.id === selectedCameraId ? "on" : ""}`}
            role="button"
            tabIndex={0}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/camera-id", c.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => open(c)}
            onKeyDown={(e) => e.key === "Enter" && open(c)}
            title="Open feed + fly to camera · drag onto a view to add it"
          >
            <span className="vlabel">{c.name}</span>
            <span className="edge-row-meta">
              {allFloors && <span>{levelName(c.ordinal)} · </span>}
              {c.kind === "dome" ? "360°" : `${Math.round(c.fovDeg)}°`}
              {editingView && (
                <button
                  className="edge-mini-add"
                  title={`Add to "${editingView.name}"`}
                  disabled={editingView.cameraIds.includes(c.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    addCameraToView(editingView.id, c.id);
                  }}
                >
                  <Plus size={11} />
                </button>
              )}
            </span>
          </div>
        ))}
        {cams.length === 0 && <p className="hint">No cameras match.</p>}
      </div>

      <div className="edge-views">
        <div className="edge-subtitle views-head">
          Preset views
          {!naming && (
            <button className="edge-mini-add" title="New preset view" onClick={() => setNaming(true)}>
              <Plus size={11} />
            </button>
          )}
        </div>
        {naming && (
          <div className="edge-newview">
            <input
              className="edge-search"
              autoFocus
              placeholder="View name… e.g. Loading-dock route"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingViewId(addCameraView(newName));
                  setNewName("");
                  setNaming(false);
                } else if (e.key === "Escape") {
                  setNaming(false);
                  setNewName("");
                }
              }}
            />
            <button
              className="edge-chip on"
              onClick={() => {
                setEditingViewId(addCameraView(newName));
                setNewName("");
                setNaming(false);
              }}
            >
              Create
            </button>
          </div>
        )}
        {views.length === 0 && !naming && (
          <p className="hint">Group cameras that belong together — a route, a shift, a handoff chain — and open them as one wall.</p>
        )}
        {views.map((v) => (
          <div className="edge-viewrow" key={v.id}>
            <button
              className="edge-row grow"
              title="Open this view as a feed wall"
              onClick={() => onOpenWall(v.id)}
            >
              <span className="edge-row-meta"><LayoutGrid size={11} /></span>
              <span className="vlabel">{v.name}</span>
              <span className="edge-row-meta">{v.cameraIds.length}</span>
            </button>
            <button
              className={`edge-mini-add ${editingViewId === v.id ? "on" : ""}`}
              title={editingViewId === v.id ? "Done editing" : "Edit — drag or + cameras into it"}
              onClick={() => setEditingViewId(editingViewId === v.id ? null : v.id)}
            >
              <Pencil size={11} />
            </button>
            <button className="edge-mini-add danger" title="Delete view" onClick={() => deleteCameraView(v.id)}>
              <X size={11} />
            </button>
          </div>
        ))}
        {editingView && (
          <div
            className={`edge-dropzone ${dropHot ? "hot" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropHot(true);
            }}
            onDragLeave={() => setDropHot(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDropHot(false);
              const id = e.dataTransfer.getData("text/camera-id");
              if (id) addCameraToView(editingView.id, id);
            }}
          >
            <div className="edge-dropzone-hint">
              Drag cameras here (or use +) — <strong>{editingView.name}</strong>
            </div>
            {editingView.cameraIds.map((cid, idx) => {
              const c = building.cameras.find((x) => x.id === cid);
              return (
                <div className="edge-viewcam" key={cid}>
                  <span className="vlabel">{c?.name ?? cid}</span>
                  <button
                    className="edge-mini-add"
                    title="Move up"
                    disabled={idx === 0}
                    onClick={() => moveCameraInView(editingView.id, cid, -1)}
                  >
                    <ChevronUp size={11} />
                  </button>
                  <button
                    className="edge-mini-add"
                    title="Move down"
                    disabled={idx === editingView.cameraIds.length - 1}
                    onClick={() => moveCameraInView(editingView.id, cid, 1)}
                  >
                    <ChevronDown size={11} />
                  </button>
                  <button
                    className="edge-mini-add danger"
                    title="Remove from view"
                    onClick={() => removeCameraFromView(editingView.id, cid)}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <button className="edge-chip on done" onClick={() => setEditingViewId(null)}>
              Done
            </button>
          </div>
        )}
      </div>

      {selected && selected.kind === "ptz" && (
        <div className="edge-camset">
          <div className="edge-subtitle">{selected.name} · PTZ</div>
          <div className="ptz-pad">
            <span className="ptz-label">Pan</span>
            <HoldButton
              label="◀"
              title="Pan left (hold to sweep)"
              onFire={ptzFire((c) => ({ heading: panStep(c.heading, 1) }))}
              onBegin={beginGesture}
            />
            <HoldButton
              label="▶"
              title="Pan right (hold to sweep)"
              onFire={ptzFire((c) => ({ heading: panStep(c.heading, -1) }))}
              onBegin={beginGesture}
            />
            <span className="ptz-label">Tilt</span>
            <HoldButton
              label="▲"
              title="Tilt up (see farther)"
              onFire={ptzFire((c) => ({ tiltDeg: tiltStep(c.tiltDeg, -1) }))}
              onBegin={beginGesture}
            />
            <HoldButton
              label="▼"
              title="Tilt down (pull the view in close)"
              onFire={ptzFire((c) => ({ tiltDeg: tiltStep(c.tiltDeg, 1) }))}
              onBegin={beginGesture}
            />
            <span className="ptz-label">Zoom</span>
            <HoldButton
              label="−"
              title="Zoom out (wider view)"
              onFire={ptzFire((c) => zoomStep(c.fovDeg, c.rangeM, -1))}
              onBegin={beginGesture}
            />
            <HoldButton
              label="+"
              title="Zoom in (narrower, longer reach)"
              onFire={ptzFire((c) => zoomStep(c.fovDeg, c.rangeM, 1))}
              onBegin={beginGesture}
            />
          </div>
        </div>
      )}
    </>
  );
}

function SiteInfo({ map }: { map: maplibregl.Map }) {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const updateSiteInfo = useStore((s) => s.updateSiteInfo);
  const [q, setQ] = useState("");
  const [akind, setAkind] = useState<AmenityKind | "all">("all");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [hoursDraft, setHoursDraft] = useState<string | null>(null);
  // One transient locate-pulse marker at a time.
  const pulseRef = useRef<maplibregl.Marker | null>(null);

  const photos = building.siteInfo?.photos ?? [];
  const hours = building.siteInfo?.hours ?? "";

  const kindsPresent = ALL_AMENITY_KINDS.filter((k) =>
    (building.amenities ?? []).some((a) => a.kind === k),
  );
  const amenities = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (building.amenities ?? [])
      .filter((a) => akind === "all" || a.kind === akind)
      .filter(
        (a) =>
          needle === "" ||
          (a.name ?? "").toLowerCase().includes(needle) ||
          a.kind.includes(needle) ||
          AMENITY_LABEL[a.kind].toLowerCase().includes(needle),
      )
      .slice(0, 100);
  }, [building.amenities, akind, q]);

  const levelName = (o: number) =>
    building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  const locate = (a: { ordinal: number; at: [number, number] }) => {
    if (!layers.amenities) setLayer("amenities", true);
    if (a.ordinal !== ordinal) setOrdinal(a.ordinal);
    const ll = m2ll(building.origin, a.at[0], a.at[1]);
    map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 18.2), duration: 500 });
    pulseRef.current?.remove();
    const el = document.createElement("div");
    el.className = "locate-pulse";
    const marker = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
    pulseRef.current = marker;
    window.setTimeout(() => {
      if (pulseRef.current === marker) pulseRef.current = null;
      marker.remove();
    }, 2600);
  };

  const addPhoto = async (file: File) => {
    try {
      const dataUrl = await fileToSmallDataUrl(file);
      updateSiteInfo({ photos: [...photos, dataUrl] });
    } catch {
      /* unreadable image — ignore */
    }
  };

  return (
    <>
      <div className="edge-title">Site info</div>

      <div className="edge-subtitle">Location photos</div>
      <div className="edge-photos">
        {photos.map((p, i) => (
          <div className="edge-photo" key={i}>
            <img src={p} alt={`site photo ${i + 1}`} onClick={() => setLightbox(p)} />
            <button
              className="edge-photo-del"
              title="Remove photo"
              onClick={() => updateSiteInfo({ photos: photos.filter((_, j) => j !== i) })}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <label className="edge-photo add" title="Add a location photo">
          <ImagePlus size={16} />
          <input
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void addPhoto(f);
            }}
          />
        </label>
      </div>

      <div className="edge-subtitle">Hours</div>
      <textarea
        className="edge-hours"
        placeholder={"Mon–Thu 10:00–02:00\nFri–Sun 24h"}
        value={hoursDraft ?? hours}
        onChange={(e) => setHoursDraft(e.target.value)}
        onBlur={() => {
          if (hoursDraft !== null && hoursDraft !== hours) updateSiteInfo({ hours: hoursDraft });
          setHoursDraft(null);
        }}
        rows={3}
      />

      <div className="edge-subtitle">Find amenities</div>
      <input
        className="edge-search"
        placeholder="Search… atm, exit, first aid"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {kindsPresent.length > 0 && (
        <div className="edge-chips wrap">
          <button className={`edge-chip ${akind === "all" ? "on" : ""}`} onClick={() => setAkind("all")}>
            All
          </button>
          {kindsPresent.map((k) => (
            <button
              key={k}
              className={`edge-chip icon ${akind === k ? "on" : ""}`}
              onClick={() => setAkind(k)}
            >
              <AmenityIcon kind={k} size={10} /> {AMENITY_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      <div className="edge-list">
        {amenities.map((a) => (
          <button
            key={a.id}
            className="edge-row"
            onClick={() => locate(a)}
            title="Fly to this amenity"
          >
            <AmenityIcon kind={a.kind} size={11} />
            <span className="vlabel grow">{a.name || AMENITY_LABEL[a.kind]}</span>
            <span className="edge-row-meta">
              {levelName(a.ordinal)} <Crosshair size={11} />
            </span>
          </button>
        ))}
        {amenities.length === 0 && <p className="hint">No amenities match.</p>}
      </div>

      {lightbox && (
        <div className="edge-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="site photo" />
        </div>
      )}
    </>
  );
}

/** Feed wall: every camera of a preset view as one tile grid — the route's
 *  cameras side by side even when their mounts are floors apart. Tile click
 *  selects the camera and flies the map to its mount. */
function ViewWall({ map, viewId, onClose }: { map: maplibregl.Map; viewId: string; onClose: () => void }) {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const view = (building.cameraViews ?? []).find((v) => v.id === viewId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // View deleted (or undone away) while the wall is open.
  useEffect(() => {
    if (!view) onClose();
  }, [view, onClose]);
  if (!view) return null;

  const cams = view.cameraIds
    .map((id) => building.cameras.find((c) => c.id === id))
    .filter((c): c is Camera => !!c);
  const levelName = (o: number) =>
    building.levels.find((l) => l.ordinal === o)?.name ?? `L${o}`;

  const jump = (cam: Camera) => {
    if (cam.ordinal !== ordinal) setOrdinal(cam.ordinal);
    setSelectedCamera(cam.id);
    map.easeTo({ center: m2ll(building.origin, cam.at[0], cam.at[1]), duration: 450 });
  };

  return (
    <div className="viewwall">
      <div className="viewwall-head">
        <LayoutGrid size={14} />
        <span className="viewwall-title">{view.name}</span>
        <span className="viewwall-count mono">{cams.length} camera{cams.length === 1 ? "" : "s"}</span>
        <button className="wiz-x" title="Close (Esc)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {cams.length === 0 ? (
        <p className="hint" style={{ padding: "0 12px 12px" }}>
          This view is empty — edit it (✎) and drag cameras in from the finder list.
        </p>
      ) : (
        <div className="viewwall-grid">
          {cams.map((c) => (
            <div
              key={c.id}
              className="viewwall-tile"
              role="button"
              tabIndex={0}
              title="Select + fly to this camera"
              onClick={() => jump(c)}
              onKeyDown={(e) => e.key === "Enter" && jump(c)}
            >
              <Feed camera={c} />
              <div className="viewwall-cap">
                <span className="vlabel">{c.name}</span>
                <span className="edge-row-meta">{levelName(c.ordinal)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OperatorEdgePanels({ map }: { map: maplibregl.Map }) {
  const [openLeft, setOpenLeft] = useState(false);
  const [openRight, setOpenRight] = useState(false);
  const [wallViewId, setWallViewId] = useState<string | null>(null);

  return (
    <>
      <div className={`edge-slide left ${openLeft ? "open" : ""}`}>
        <div className="edge-panel">
          <CameraFinder map={map} onOpenWall={setWallViewId} />
        </div>
        <button
          className="edge-arrow"
          title={openLeft ? "Close camera finder" : "Camera finder"}
          onClick={() => setOpenLeft((v) => !v)}
        >
          {openLeft ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </div>
      <div className={`edge-slide right ${openRight ? "open" : ""}`}>
        <button
          className="edge-arrow"
          title={openRight ? "Close site info" : "Site info & amenities"}
          onClick={() => setOpenRight((v) => !v)}
        >
          {openRight ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
        <div className="edge-panel">
          <SiteInfo map={map} />
        </div>
      </div>
      {wallViewId && <ViewWall map={map} viewId={wallViewId} onClose={() => setWallViewId(null)} />}
    </>
  );
}
