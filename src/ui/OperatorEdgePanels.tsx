import { useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { ChevronLeft, ChevronRight, Crosshair, ImagePlus, X } from "lucide-react";
import { useStore, ALL_AMENITY_KINDS } from "../store";
import { m2ll } from "../geo";
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

const AMENITY_LABEL: Record<AmenityKind, string> = {
  restroom: "Restroom", atm: "ATM", exit: "Exit", info: "Info", firstaid: "First aid",
  ticketing: "Ticketing", dining: "Dining", bar: "Bar", coatcheck: "Coat check", smoking: "Smoking",
};

/** Downscale an image file to a small data URL (longest side <= 640px) so a
 *  handful of site photos can't blow the localStorage quota. */
async function fileToSmallDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("bad image"));
    el.src = raw;
  });
  const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1) return raw;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function CameraFinder({ map }: { map: maplibregl.Map }) {
  const building = useStore((s) => s.building);
  const ordinal = useStore((s) => s.ordinal);
  const setOrdinal = useStore((s) => s.setOrdinal);
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const setSelectedCamera = useStore((s) => s.setSelectedCamera);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<CameraKind | "all">("all");
  const [allFloors, setAllFloors] = useState(false);

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

  const selected = building.cameras.find((c) => c.id === selectedCameraId) ?? null;
  const beginGesture = useStore((s) => s.beginCameraGesture);
  const updateLive = useStore((s) => s.updateCameraLive);

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
          <button
            key={c.id}
            className={`edge-row ${c.id === selectedCameraId ? "on" : ""}`}
            onClick={() => open(c)}
            title="Open feed + fly to camera"
          >
            <span className="vlabel">{c.name}</span>
            <span className="edge-row-meta">
              {allFloors && <span>{levelName(c.ordinal)} · </span>}
              {c.kind === "dome" ? "360°" : `${Math.round(c.fovDeg)}°`}
            </span>
          </button>
        ))}
        {cams.length === 0 && <p className="hint">No cameras match.</p>}
      </div>

      {selected && (
        <div className="edge-camset">
          <div className="edge-subtitle">{selected.name}</div>
          {selected.kind !== "dome" ? (
            <>
              <label className="edge-label">
                FOV <span className="mono">{Math.round(selected.fovDeg)}°</span>
              </label>
              <input
                type="range"
                min={20}
                max={160}
                value={Math.round(selected.fovDeg)}
                onPointerDown={beginGesture}
                onChange={(e) => updateLive(selected.id, { fovDeg: Number(e.target.value) })}
              />
            </>
          ) : (
            <label className="edge-label">Dome · 360° view</label>
          )}
          <label className="edge-label">
            Range <span className="mono">{Math.round(selected.rangeM)} m</span>
          </label>
          <input
            type="range"
            min={4}
            max={60}
            value={Math.round(selected.rangeM)}
            onPointerDown={beginGesture}
            onChange={(e) => updateLive(selected.id, { rangeM: Number(e.target.value) })}
          />
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
              className={`edge-chip ${akind === k ? "on" : ""}`}
              onClick={() => setAkind(k)}
            >
              {AMENITY_LABEL[k]}
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
            <span className="vlabel">{a.name || AMENITY_LABEL[a.kind]}</span>
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

export default function OperatorEdgePanels({ map }: { map: maplibregl.Map }) {
  const [openLeft, setOpenLeft] = useState(false);
  const [openRight, setOpenRight] = useState(false);

  return (
    <>
      <div className={`edge-slide left ${openLeft ? "open" : ""}`}>
        <div className="edge-panel">
          <CameraFinder map={map} />
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
    </>
  );
}
