import { preferences } from "./webos-mode";
// The Render dialog: quality, size, sun and light settings, and the progressive render.
import { useEffect, useRef, useState } from "react";
import { exec } from "./engine";
import { savedSettings } from "./skins";
import { pickSave } from "./files";
import type { Cam } from "./Viewport";
import { SheetHead, useEscapeToClose } from "./sheet";

/** Render settings past quality and sun (the dialog's "More settings"). */
interface RenderSettings {
  size: string;
  width: number;
  height: number;
  ev: number;
  sun: number;
  sky: number;
  warmth: number;
  bounces: number;
  backdrop: "sky" | "color";
  backdropColor: string;
  ground: boolean;
  groundColor: string;
  denoise: boolean;
}
const RENDER_DEFAULTS: RenderSettings = { size: "quality", width: 1920, height: 1080, ev: 0, sun: 2.4, sky: 1, warmth: 0, bounces: 6, backdrop: "sky", backdropColor: "#ffffff", ground: true, groundColor: "#94948c", denoise: true };
const RENDER_SIZES: { id: string; label: string; w?: number; h?: number }[] = [
  { id: "quality", label: "This view's shape, by quality" },
  { id: "hd", label: "HD 1920 × 1080", w: 1920, h: 1080 },
  { id: "4k", label: "4K 3840 × 2160", w: 3840, h: 2160 },
  { id: "square", label: "Square 2048 × 2048", w: 2048, h: 2048 },
  { id: "portrait", label: "Portrait 1080 × 1350", w: 1080, h: 1350 },
  { id: "custom", label: "Custom…" },
];
const clampSize = (n: number) => Math.max(16, Math.min(4096, Math.round(Number.isFinite(n) ? n : 1024)));

/** Photoreal render of the current view: quality, sun, then save. */
/** More settings: remembered between renders on this computer. */
function useRenderSettings() {
  const [adv, setAdvRaw] = useState<RenderSettings>(() => {
    return savedSettings("sketchcraft.render", RENDER_DEFAULTS, { size: RENDER_SIZES.map((s) => s.id), backdrop: ["sky", "color"] });
  });
  const setAdv = (patch: Partial<RenderSettings>) =>
    setAdvRaw((a) => {
      const n = { ...a, ...patch };
      try {
        preferences().setItem("sketchcraft.render", JSON.stringify(n));
      } catch {}
      return n;
    });
  return { adv, setAdv };
}

/** The sun for a render: placed for this view, set by hand, or the real sun at a date and time. */
function useSun() {
  const [sunMode, setSunMode] = useState<"view" | "manual" | "real">("view");
  const [az, setAz] = useState(200);
  const [alt, setAlt] = useState(35);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [minutes, setMinutes] = useState(15 * 60);
  const [real, setReal] = useState<{ azimuth: number; altitude: number; located: boolean; lon: number } | null>(null);
  // this Mac's clock offset on that date (daylight saving included); used when
  // the site is in roughly the same timezone, else the engine guesses from longitude
  const localOffset = -new Date(`${date}T12:00:00`).getTimezoneOffset() / 60;
  const offsetFor = (lon: number | undefined) => (lon != null && Math.abs(lon / 15 - localOffset) < 1.6 ? { utc_offset: localOffset } : {});
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const clock12 = `${((Math.floor(minutes / 60) + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")} ${minutes < 720 ? "am" : "pm"}`;
  useEffect(() => {
    if (sunMode !== "real") return;
    let live = true;
    (async () => {
      // first ask where the site is, then where the sun is on its clock
      const probe = await exec({ cmd: "sun", date, time: clock });
      if (!probe.ok) return;
      const r = await exec({ cmd: "sun", date, time: clock, ...offsetFor(probe.lon as number) });
      if (live && r.ok) setReal(r as unknown as { azimuth: number; altitude: number; located: boolean; lon: number });
    })();
    return () => {
      live = false;
    };
  }, [sunMode, date, clock]);
  const sunDown = sunMode === "real" && real != null && real.altitude < 1;
  return { sunMode, setSunMode, az, setAz, alt, setAlt, date, setDate, minutes, setMinutes, real, clock, clock12, sunDown, offsetFor };
}

const compassOf = (a: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((a % 360) + 360) % 360 / 45) % 8];

/** The Sun choices: which sun, and its direction, height, date or time. */
function SunControls({ sun, busy }: { sun: ReturnType<typeof useSun>; busy: boolean }) {
  const { sunMode, setSunMode, az, setAz, alt, setAlt, date, setDate, minutes, setMinutes, real, clock12, sunDown } = sun;
  const compass = compassOf(az);
  return (
    <>
        <div className="seg" role="radiogroup" aria-label="Sun">
          {([["view", "Sun for this view", "Lights the side you're looking at"], ["manual", "Set by hand", "Pick the direction and height"], ["real", "Real sun", "Where the sun really is at this place, date and time"]] as const).map(([id, label, tip]) => (
            <button key={id} className={sunMode === id ? "on" : ""} onClick={() => setSunMode(id)} title={tip} disabled={busy}>
              {label}
            </button>
          ))}
        </div>
        {sunMode === "manual" && (
          <label className="field">
            <span>Sun from {compass}</span>
            <input type="range" min={0} max={359} value={az} onChange={(e) => setAz(Number(e.target.value))} />
          </label>
        )}
        {sunMode !== "real" && (
          <label className="field">
            <span>Sun height {alt}°</span>
            <input type="range" min={5} max={85} value={alt} onChange={(e) => setAlt(Number(e.target.value))} />
          </label>
        )}
        {sunMode === "real" && (
          <>
            <label className="field">
              <span>Date</span>
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Time {clock12}</span>
              <input type="range" min={5 * 60} max={21 * 60} step={15} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </label>
            <span className={`muted small${sunDown ? " warn" : ""}`}>
              {real == null
                ? "Finding the sun…"
                : sunDown
                  ? "The sun is down then. Slide the time later or earlier."
                  : `Sun from the ${compassOf(real.azimuth)}, ${Math.round(real.altitude)}° up.`}
              {real && !real.located && " No location set, so this uses the central US (File ▸ Add location… for yours)."}
            </span>
          </>
        )}
    </>
  );
}

/** The "More settings" fieldset: size, light, background and ground. */
function MoreSettings({ adv, setAdv, busy }: { adv: RenderSettings; setAdv: (patch: Partial<RenderSettings>) => void; busy: boolean }) {
  return (
      <fieldset className="render-more" disabled={busy}>
        <label className="field">
          <span>Size</span>
          <select value={adv.size} onChange={(e) => setAdv({ size: e.target.value })}>
            {RENDER_SIZES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {adv.size === "custom" && (
          <div className="row gap">
            <label className="field">
              <span>Width</span>
              <input type="number" min={16} max={4096} value={adv.width} onChange={(e) => setAdv({ width: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Height</span>
              <input type="number" min={16} max={4096} value={adv.height} onChange={(e) => setAdv({ height: Number(e.target.value) })} />
            </label>
          </div>
        )}
        <label className="field" title="Brighter or darker overall, in camera stops">
          <span>Exposure {adv.ev > 0 ? "+" : ""}{adv.ev.toFixed(1)}</span>
          <input type="range" min={-3} max={3} step={0.1} value={adv.ev} onChange={(e) => setAdv({ ev: Number(e.target.value) })} />
        </label>
        <label className="field" title="How strong direct sunlight is (and how dark the shadows look next to it)">
          <span>Sunlight {adv.sun.toFixed(1)}</span>
          <input type="range" min={0} max={8} step={0.1} value={adv.sun} onChange={(e) => setAdv({ sun: Number(e.target.value) })} />
        </label>
        <label className="field" title="The sky's soft light: it fills in the shadows">
          <span>Sky light {adv.sky.toFixed(1)}</span>
          <input type="range" min={0} max={4} step={0.1} value={adv.sky} onChange={(e) => setAdv({ sky: Number(e.target.value) })} />
        </label>
        <label className="field" title="The sun's color: cool overcast to warm golden hour">
          <span>Sun color {adv.warmth < -0.15 ? "cool" : adv.warmth > 0.15 ? "warm" : "daylight"}</span>
          <input type="range" min={-1} max={1} step={0.05} value={adv.warmth} onChange={(e) => setAdv({ warmth: Number(e.target.value) })} />
        </label>
        <label className="field" title="How many times light bounces between surfaces. More: brighter, truer interiors; slower">
          <span>Light bounces {adv.bounces}</span>
          <input type="range" min={1} max={12} step={1} value={adv.bounces} onChange={(e) => setAdv({ bounces: Number(e.target.value) })} />
        </label>
        <div className="field">
          <span>Background</span>
          <div className="row gap">
            <div className="seg">
              <button className={adv.backdrop === "sky" ? "on" : ""} onClick={() => setAdv({ backdrop: "sky" })}>
                Sky
              </button>
              <button className={adv.backdrop === "color" ? "on" : ""} onClick={() => setAdv({ backdrop: "color" })} title="A plain color behind the model (the sky still lights it)">
                Color
              </button>
            </div>
            {adv.backdrop === "color" && <input type="color" aria-label="Background color" value={adv.backdropColor} onChange={(e) => setAdv({ backdropColor: e.target.value })} />}
          </div>
        </div>
        <div className="field">
          <span>Ground</span>
          <div className="row gap">
            <label className="field check">
              <input type="checkbox" checked={adv.ground} onChange={(e) => setAdv({ ground: e.target.checked })} /> Show the ground
            </label>
            {adv.ground && <input type="color" aria-label="Ground color" value={adv.groundColor} onChange={(e) => setAdv({ groundColor: e.target.value })} />}
          </div>
        </div>
        <label className="field check" title="Smooths the grain while the picture sharpens. Off: the raw samples">
          <input type="checkbox" checked={adv.denoise} onChange={(e) => setAdv({ denoise: e.target.checked })} /> Remove grain (denoise)
        </label>
        <button className="btn small ghost" onClick={() => setAdv(RENDER_DEFAULTS)}>
          Reset to defaults
        </button>
      </fieldset>
  );
}

export function RenderDialog({ camera, aspect, name, onClose, onToast }: { camera: () => Cam; aspect: number; name: string; onClose: () => void; onToast: (t: string, bad?: boolean) => void }) {
  const QUALITY = [
    { id: "preview", label: "Preview", samples: 16, long: 960, about: "a few seconds" },
    { id: "good", label: "Good", samples: 64, long: 1600, about: "under a minute" },
    { id: "final", label: "Final", samples: 256, long: 2400, about: "a few minutes" },
  ];
  const [q, setQ] = useState("preview");
  const { adv, setAdv } = useRenderSettings();
  const [more, setMore] = useState(false);
  const sun = useSun();
  const { sunMode, offsetFor, real, date, clock, az, alt, sunDown } = sun;
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  const [secs, setSecs] = useState<number | null>(null);
  const cam = useRef(camera());
  // renders sharpen in passes: a rough picture in a moment, finer each pass
  const stopRef = useRef(false);
  const [progress, setProgress] = useState<{ done: number; goal: number } | null>(null);
  const go = async (more = false) => {
    const preset = QUALITY.find((x) => x.id === q)!;
    const size = RENDER_SIZES.find((x) => x.id === adv.size);
    const [w, h] =
      adv.size === "custom"
        ? [clampSize(adv.width), clampSize(adv.height)]
        : size?.w
          ? [size.w, size.h]
          : aspect >= 1
            ? [preset.long, Math.round(preset.long / aspect)]
            : [Math.round(preset.long * aspect), preset.long];
    const look = {
      bounces: adv.bounces,
      exposure: Math.pow(2, adv.ev),
      sun_strength: adv.sun,
      sky_strength: adv.sky,
      warmth: adv.warmth,
      denoise: adv.denoise,
      ground: adv.ground,
      ground_color: adv.groundColor,
      ...(adv.backdrop === "color" ? { background: adv.backdropColor } : {}),
    };
    stopRef.current = false;
    setBusy(true);
    const sun = sunMode === "real" ? { date, time: clock, ...offsetFor(real?.lon) } : sunMode === "manual" ? { sun_azimuth: az, sun_altitude: alt } : { sun_altitude: alt };
    const t0 = performance.now();
    // the goal: this quality's samples (on top of what's there, for "more")
    const goal = (more && progress ? progress.done : 0) + preset.samples;
    let per = 1;
    let base = -1;
    while (!stopRef.current) {
      const r = await exec({ cmd: "photoreal", width: w, height: h, samples: per, progressive: true, camera: cam.current, ...sun, ...look });
      if (!r.ok) {
        onToast(r.error ?? "The render didn't work", true);
        break;
      }
      const spp = r.spp as number;
      // a fresh start or carrying on from an earlier render of the same view
      if (base < 0) base = more ? 0 : spp - per;
      const done = spp - base;
      setImg(r.data as string);
      setSecs((performance.now() - t0) / 1000);
      setProgress({ done, goal });
      if (done >= goal) break;
      // bigger passes as it goes (fewer round trips), never past the goal
      per = Math.max(1, Math.min(16, goal - done, Math.max(2, done)));
    }
    setBusy(false);
  };
  const save = async () => {
    if (!img) return;
    const path = await pickSave(`${name} render.png`, "png", "PNG image");
    if (!path) return;
    const r = await exec({ cmd: "save_image", path, data: img });
    if (r.ok) onToast(`Saved ${path.split("/").pop()}`);
  };
  const dismiss = () => {
    stopRef.current = true;
    onClose();
  };
  useEscapeToClose(dismiss);
  return (
    <div className="sheet-backdrop" onClick={dismiss}>
      <div className={`sheet render-dlg${more ? " more" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Render">
        <SheetHead title="Render" note="Photoreal: sunlight, sky, soft shadows, reflections." />
        <div className="render-view">
          {img ? <img src={img} alt="Render" /> : <div className="render-empty">{busy ? "Starting…" : "Pick a quality and press Render."}</div>}
          {progress && (
            <div className="render-progress" aria-live="polite">
              <i style={{ width: `${Math.min(100, (progress.done / progress.goal) * 100)}%` }} />
              <span>
                {busy ? "Sharpening" : progress.done >= progress.goal ? "Done" : "Stopped"}: {progress.done} of {progress.goal} samples{secs != null ? ` · ${secs.toFixed(1)} s` : ""}
              </span>
            </div>
          )}
        </div>
        <div className="render-controls">
          <div className="seg">
            {QUALITY.map((x) => (
              <button key={x.id} className={q === x.id ? "on" : ""} onClick={() => setQ(x.id)} title={x.about} disabled={busy}>
                {x.label}
              </button>
            ))}
          </div>
          <SunControls sun={sun} busy={busy} />
          <button className="btn small ghost render-more-toggle" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? "▾" : "▸"} More settings
          </button>
          {more && <MoreSettings adv={adv} setAdv={setAdv} busy={busy} />}
          <div className="row gap">
            {busy ? (
              <button className="btn small" onClick={() => (stopRef.current = true)} title="Keep the picture as it is now">
                Stop
              </button>
            ) : (
              <>
                <button className="btn small" onClick={() => go(false)} disabled={sunDown}>
                  {img ? "Render again" : "Render"}
                </button>
                {img && progress && (
                  <button className="btn small ghost" onClick={() => go(true)} disabled={sunDown} title="Keep adding samples to this picture: less grain, finer shadows">
                    Sharpen more
                  </button>
                )}
              </>
            )}
            <button className="btn small ghost" onClick={save} disabled={!img || busy}>
              Save PNG…
            </button>
            <button
              className="btn small ghost"
              onClick={() => {
                stopRef.current = true;
                onClose();
              }}
            >
              Close
            </button>

          </div>
        </div>
      </div>
    </div>
  );
}
