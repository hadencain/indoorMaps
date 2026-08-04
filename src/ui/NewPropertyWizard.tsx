import { useCallback, useEffect, useRef, useState } from "react";
import { Ruler, Upload, X } from "lucide-react";
import { useStore } from "../store";
import type { RasterUnderlay } from "../types";

/** Fraction-of-image point [0..1, 0..1] — resize-proof; converted to natural
 *  pixels only when measuring. Fractions are of the PAINTED picture, never of
 *  the element box (see paintedRect). */
type FracPt = [number, number];

/** Where the floorplan is actually painted inside its <img>, in box-local px.
 *  `object-fit: contain` letterboxes, so the element box is not the picture:
 *  a 2240x1520 plan in a 606x380 box paints 560 wide with 23px bars either
 *  side. Normalising a calibration click against the box instead of the
 *  picture stretches every measurement by the letterbox ratio — an 8% silent
 *  scale error on this fixture, and a different error on every window width. */
function paintedRect(img: HTMLImageElement, box: HTMLElement) {
  const ir = img.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const s = Math.min(ir.width / img.naturalWidth, ir.height / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  return { left: ir.left - br.left + (ir.width - w) / 2, top: ir.top - br.top + (ir.height - h) / 2, w, h };
}

const FT_PER_M = 3.28084;
/** Calibration fallback when the user skips drawing a line. */
const DEFAULT_WIDTH_M = 40;

interface Props {
  onClose: () => void;
}

/** "New property from image": name it, drop a floorplan image, then calibrate
 *  scale by drawing a line across a feature of known real-world length (a
 *  door bay, a parking row, a gridline span). The image lands as a correctly
 *  scaled underlay on Floor 1 of a fresh property, ready to trace. */
export default function NewPropertyWizard({ onClose }: Props) {
  const createProperty = useStore((s) => s.createProperty);
  const [name, setName] = useState("");
  const [img, setImg] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [pts, setPts] = useState<FracPt[]>([]);
  const [lenStr, setLenStr] = useState("10");
  const [lenUnit, setLenUnit] = useState<"m" | "ft">("m");
  const [readErr, setReadErr] = useState<string | null>(null);
  const imgBoxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Painted-picture rect, box-local. Re-measured on load and on resize because
  // `contain` re-letterboxes whenever the dialog changes width.
  const [paint, setPaint] = useState<{ left: number; top: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const measure = useCallback(() => {
    const i = imgRef.current;
    const b = imgBoxRef.current;
    setPaint(i && b ? paintedRect(i, b) : null);
  }, []);

  useEffect(() => {
    if (step !== 2) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, img, measure]);

  const readFile = useCallback(async (file: File) => {
    setReadErr(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
        el.onerror = () => reject(new Error("bad image"));
        el.src = dataUrl;
      });
      setImg({ dataUrl, ...dims });
      setPts([]);
    } catch {
      setReadErr("Couldn't read that image — try a PNG or JPEG.");
    }
  }, []);

  // Calibration math, all in NATURAL image pixels so display size is irrelevant.
  const lenVal = parseFloat(lenStr);
  const lenM = Number.isFinite(lenVal) && lenVal > 0 ? (lenUnit === "ft" ? lenVal / FT_PER_M : lenVal) : null;
  let pixLen: number | null = null;
  if (img && pts.length === 2) {
    const dx = (pts[1][0] - pts[0][0]) * img.w;
    const dy = (pts[1][1] - pts[0][1]) * img.h;
    const d = Math.hypot(dx, dy);
    pixLen = d >= 5 ? d : null; // sub-5px line = misclick, not a measurement
  }
  const widthM = img && pixLen && lenM ? (img.w * lenM) / pixLen : null;

  const placePoint = (e: React.MouseEvent) => {
    const box = imgBoxRef.current;
    // Measure lazily too: a click can beat the load/resize effect on a cached image.
    const rect = paint ?? (imgRef.current && box ? paintedRect(imgRef.current, box) : null);
    if (!box || !rect) return;
    const r = box.getBoundingClientRect();
    const p: FracPt = [
      Math.min(1, Math.max(0, (e.clientX - r.left - rect.left) / rect.w)),
      Math.min(1, Math.max(0, (e.clientY - r.top - rect.top) / rect.h)),
    ];
    setPts((cur) => (cur.length >= 2 ? [p] : [...cur, p]));
  };

  const create = (calibratedWidthM: number | null) => {
    let underlay: RasterUnderlay | null = null;
    if (img) {
      underlay = {
        ordinal: 0,
        dataUrl: img.dataUrl,
        naturalW: img.w,
        naturalH: img.h,
        widthM: calibratedWidthM ?? DEFAULT_WIDTH_M,
        offset: [0, 0],
        rotation: 0,
        opacity: 0.6,
      };
    }
    createProperty(name, underlay);
    onClose();
  };

  return (
    <div className="wiz-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wiz">
        <div className="wiz-head">
          <span className="wiz-title">New property from image</span>
          <span className="wiz-step">{step === 1 ? "1 · Floorplan" : "2 · Calibrate scale"}</span>
          <button className="wiz-x" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        {step === 1 && (
          <div className="wiz-body">
            <label className="wiz-label">Property name</label>
            <input
              className="wiz-input"
              autoFocus
              placeholder="e.g. Westside Distribution Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="wiz-label">Floorplan image</label>
            <label className={img ? "wiz-drop has-img" : "wiz-drop"}>
              {img ? (
                <img src={img.dataUrl} alt="floorplan preview" className="wiz-preview" />
              ) : (
                <span className="wiz-drop-hint">
                  <Upload size={16} /> Choose a PNG or JPEG floorplan…
                </span>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void readFile(f);
                }}
              />
            </label>
            {readErr && <div className="wiz-err">{readErr}</div>}
            <div className="wiz-actions">
              <button className="wiz-btn ghost" onClick={() => create(null)} title="Create an empty property with no floorplan">
                Start blank
              </button>
              <span className="wiz-spacer" />
              <button className="wiz-btn primary" disabled={!img} onClick={() => setStep(2)}>
                Next: calibrate scale
              </button>
            </div>
          </div>
        )}

        {step === 2 && img && (
          <div className="wiz-body">
            <p className="wiz-hint">
              <Ruler size={13} /> Click two points across something whose real length you know — a
              door bay, a parking row, a dimension line — then enter that length.
            </p>
            <div className="wiz-imgbox" ref={imgBoxRef} onClick={placePoint}>
              <img
                ref={imgRef}
                src={img.dataUrl}
                alt="floorplan"
                className="wiz-calimg"
                draggable={false}
                onLoad={measure}
              />
              {/* Overlay is pinned to the PAINTED picture, not the element box,
                  so the dots land where the click was measured. */}
              {paint && (
                <div
                  className="wiz-calpaint"
                  style={{ left: paint.left, top: paint.top, width: paint.w, height: paint.h }}
                >
                  <svg className="wiz-calsvg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {pts.length === 2 && (
                      <line
                        x1={pts[0][0] * 100}
                        y1={pts[0][1] * 100}
                        x2={pts[1][0] * 100}
                        y2={pts[1][1] * 100}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </svg>
                  {pts.map((p, i) => (
                    <span key={i} className="wiz-caldot" style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} />
                  ))}
                </div>
              )}
            </div>
            <div className="wiz-cal-row">
              <label className="wiz-label">That line is</label>
              <input
                className="wiz-input len"
                type="number"
                min={0.1}
                step="any"
                value={lenStr}
                onChange={(e) => setLenStr(e.target.value)}
              />
              <div className="wiz-unit" role="group" aria-label="Unit">
                <button className={lenUnit === "m" ? "active" : ""} onClick={() => setLenUnit("m")}>m</button>
                <button className={lenUnit === "ft" ? "active" : ""} onClick={() => setLenUnit("ft")}>ft</button>
              </div>
              <span className="wiz-derived">
                {widthM
                  ? `plan width ≈ ${widthM.toFixed(1)} m`
                  : pts.length === 2
                    ? "enter the real length"
                    : "draw the line first"}
              </span>
            </div>
            <div className="wiz-actions">
              <button className="wiz-btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <span className="wiz-spacer" />
              <button
                className="wiz-btn ghost"
                onClick={() => create(null)}
                title={`Skip calibration — assume the image spans ${DEFAULT_WIDTH_M} m`}
              >
                Skip — use {DEFAULT_WIDTH_M} m width
              </button>
              <button className="wiz-btn primary" disabled={!widthM} onClick={() => create(widthM)}>
                Create property
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
