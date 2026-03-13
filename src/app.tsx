import { useEffect, useMemo, useRef, useState } from "react";
import { initWebGPU } from "./gpu/context";
import { PlaygroundRenderer } from "./gpu/playgroundRenderer";
import { DEFAULT_GLITCH_PARAMS, type GlitchParams } from "./gpu/glitchPipeline";
import { DEFAULT_STYLE_PARAMS, type StyleParams } from "./gpu/stylePipeline";

type GlitchKey = "dataMosh" | "feedback" | "softGlitch" | "hardGlitch" | "pixelSort" | "decimate";
type StyleKey = keyof StyleParams;
type EffectKey = GlitchKey | StyleKey;

type EffectDef = {
  key: EffectKey;
  label: string;
  min: number;
  max: number;
  step: number;
};

type EffectGroup = {
  title: string;
  effects: EffectDef[];
};

const GROUPS: EffectGroup[] = [
  {
    title: "Datamosh / Glitch",
    effects: [
      { key: "dataMosh", label: "Data-Mosh", min: 0, max: 1, step: 0.01 },
      { key: "feedback", label: "Feedback", min: 0, max: 1, step: 0.01 },
      { key: "softGlitch", label: "Soft Glitch", min: 0, max: 1, step: 0.01 },
      { key: "hardGlitch", label: "Hard Glitch", min: 0, max: 1, step: 0.01 },
      { key: "pixelSort", label: "Pixel Sort", min: 0, max: 1, step: 0.01 },
      { key: "decimate", label: "Decimate", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Distortion / Spatial",
    effects: [
      { key: "stretch", label: "Stretch", min: 0, max: 1, step: 0.01 },
      { key: "wave", label: "Wave", min: 0, max: 1, step: 0.01 },
      { key: "pushAmount", label: "Push", min: 0, max: 1, step: 0.01 },
      { key: "bulge", label: "Bulge", min: 0, max: 1, step: 0.01 },
      { key: "transformAmt", label: "Transform", min: 0, max: 1, step: 0.01 },
      { key: "transform3d", label: "3D Transform", min: 0, max: 1, step: 0.01 },
      { key: "splitter", label: "Splitter", min: 0, max: 1, step: 0.01 },
      { key: "tile", label: "Tile", min: 0, max: 1, step: 0.01 },
      { key: "kaleidoscope", label: "Kaleidoscope", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Retro / Analog",
    effects: [
      { key: "vhs", label: "VHS", min: 0, max: 1, step: 0.01 },
      { key: "super8", label: "Super 8", min: 0, max: 1, step: 0.01 },
      { key: "crt", label: "CRT", min: 0, max: 1, step: 0.01 },
      { key: "cga", label: "8-Bit CGA", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Lighting / Stylization",
    effects: [
      { key: "lightStreak", label: "Light Streak", min: 0, max: 1, step: 0.01 },
      { key: "bleach", label: "Bleach", min: 0, max: 1, step: 0.01 },
      { key: "watercolor", label: "Watercolor", min: 0, max: 1, step: 0.01 },
      { key: "grain", label: "Grain", min: 0, max: 1, step: 0.01 },
      { key: "sharpen", label: "Sharpen", min: 0, max: 1, step: 0.01 },
      { key: "blur", label: "Blur", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Procedural / Experimental",
    effects: [
      { key: "lumaMesh", label: "Luma-Mesh", min: 0, max: 1, step: 0.01 },
      { key: "opticalFlow", label: "Optical-Flow", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Image Processing",
    effects: [
      { key: "asciiFx", label: "Ascii", min: 0, max: 1, step: 0.01 },
      { key: "dither", label: "Dither", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Composition / Masking",
    effects: [
      { key: "overlay", label: "Overlay", min: 0, max: 1, step: 0.01 },
      { key: "mask", label: "Mask", min: 0, max: 1, step: 0.01 },
      { key: "maskBlocks", label: "Mask Blocks", min: 0, max: 1, step: 0.01 },
      { key: "chromaKey", label: "Chroma Key", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: "Utility",
    effects: [
      { key: "audioViz", label: "Audio Visualizer", min: 0, max: 1, step: 0.01 },
      { key: "colorCorrection", label: "Color Correction", min: 0, max: 1, step: 0.01 },
      { key: "strobe", label: "Strobe", min: 0, max: 1, step: 0.01 },
    ],
  },
];

const PRESETS = [
  { name: "Soft Melt", data: { dataMosh: 0.35, feedback: 0.28, softGlitch: 0.35, wave: 0.2, blur: 0.25, grain: 0.2 } },
  { name: "Codec Collapse", data: { dataMosh: 0.9, feedback: 0.9, hardGlitch: 0.9, decimate: 0.88, pixelSort: 0.6, vhs: 0.4 } },
  { name: "VHS Ghost", data: { vhs: 0.8, crt: 0.5, grain: 0.35, softGlitch: 0.35, feedback: 0.2 } },
  { name: "Pixel Ruin", data: { hardGlitch: 1, decimate: 1, pixelSort: 0.9, dither: 0.45, cga: 0.6, maskBlocks: 0.35 } },
] as const;

const ALL_KEYS = GROUPS.flatMap((g) => g.effects.map((e) => e.key));

function buildDefaultEffects(): Record<EffectKey, number> {
  const base: Partial<Record<EffectKey, number>> = {};
  for (const key of ALL_KEYS) base[key] = 0;
  return base as Record<EffectKey, number>;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function randomizeEffects(prev: Record<EffectKey, number>): Record<EffectKey, number> {
  const next = { ...prev };
  for (const key of ALL_KEYS) {
    next[key] = clamp(Math.random() * 1.1, 0, 1);
  }
  return next;
}

function mapToGlitch(e: Record<EffectKey, number>): GlitchParams {
  const g = { ...DEFAULT_GLITCH_PARAMS };
  g.feedbackAmount = clamp(e.dataMosh * 0.98, 0, 0.99);
  g.feedbackDisplace = clamp(e.feedback * 0.2, 0, 0.2);
  g.warpStrength = clamp(e.softGlitch * 1.6 + e.hardGlitch * 0.4, 0, 2.2);
  g.glitchBurst = clamp(e.hardGlitch * 2.0, 0, 2);
  g.rgbSplit = clamp(e.hardGlitch * 20, 0, 24);
  g.blockSize = clamp(1 + e.decimate * 63, 1, 64);
  g.decay = clamp(e.dataMosh * 0.18, 0, 0.3);
  g.blendToClean = clamp(1 - Math.max(e.hardGlitch, e.dataMosh) * 0.95, 0, 1);
  g.pixelSort = clamp(e.pixelSort, 0, 1);
  return g;
}

function mapToStyle(e: Record<EffectKey, number>): StyleParams {
  return {
    ...DEFAULT_STYLE_PARAMS,
    stretch: e.stretch,
    wave: e.wave,
    pushAmount: e.pushAmount,
    bulge: e.bulge,
    transformAmt: e.transformAmt,
    transform3d: e.transform3d,
    splitter: e.splitter,
    tile: e.tile,
    kaleidoscope: e.kaleidoscope,
    vhs: e.vhs,
    super8: e.super8,
    crt: e.crt,
    cga: e.cga,
    lightStreak: e.lightStreak,
    bleach: e.bleach,
    watercolor: e.watercolor,
    grain: e.grain,
    sharpen: e.sharpen,
    blur: e.blur,
    lumaMesh: e.lumaMesh,
    opticalFlow: e.opticalFlow,
    asciiFx: e.asciiFx,
    dither: e.dither,
    overlay: e.overlay,
    mask: e.mask,
    maskBlocks: e.maskBlocks,
    chromaKey: e.chromaKey,
    audioViz: e.audioViz,
    colorCorrection: e.colorCorrection,
    strobe: e.strobe,
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PlaygroundRenderer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const pendingBackgroundRef = useRef<ImageBitmap | null>(null);
  const pendingVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const selfTestTimerRef = useRef<number | null>(null);
  const selfTestStartRef = useRef(0);
  const selfTestSavedRef = useRef<Record<EffectKey, number> | null>(null);

  const [effects, setEffects] = useState<Record<EffectKey, number>>(buildDefaultEffects);
  const [backgroundName, setBackgroundName] = useState("No media loaded");
  const [error, setError] = useState<string | null>(null);
  const [selfTestActive, setSelfTestActive] = useState(false);
  const [selfTestKey, setSelfTestKey] = useState<EffectKey | null>(null);

  const glitchParams = useMemo(() => mapToGlitch(effects), [effects]);
  const styleParams = useMemo(() => mapToStyle(effects), [effects]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: PlaygroundRenderer | null = null;
    let destroyed = false;

    const init = async () => {
      try {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);

        const gpu = await initWebGPU(canvas);
        if (destroyed) return;

        renderer = new PlaygroundRenderer(gpu);
        rendererRef.current = renderer;
        renderer.setGlitchParams(glitchParams);
        renderer.setStyleParams(styleParams);
        if (pendingBackgroundRef.current) {
          renderer.setBackgroundImage(pendingBackgroundRef.current);
          pendingBackgroundRef.current = null;
        } else if (pendingVideoRef.current) {
          renderer.setBackgroundVideo(pendingVideoRef.current);
          pendingVideoRef.current = null;
        }
        renderer.start();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to initialize WebGPU");
      }
    };

    init();

    const onResize = () => {
      if (!canvas || !renderer) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      renderer.resize(canvas.width, canvas.height);
    };

    window.addEventListener("resize", onResize);

    return () => {
      destroyed = true;
      renderer?.stop();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setGlitchParams(glitchParams);
  }, [glitchParams]);

  useEffect(() => {
    rendererRef.current?.setStyleParams(styleParams);
  }, [styleParams]);

  const setEffect = (key: EffectKey, value: number) => {
    setEffects((prev) => ({ ...prev, [key]: value }));
  };

  const resetDefaults = () => setEffects(buildDefaultEffects());
  const randomize = () => setEffects((prev) => randomizeEffects(prev));
  const applyPreset = (name: string) => {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return;
    setEffects((prev) => ({ ...prev, ...preset.data }));
  };

  const pickBackground = () => fileInputRef.current?.click();
  const pickVideo = () => videoInputRef.current?.click();

  const stopVideoSource = () => {
    const video = videoElementRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      videoElementRef.current = null;
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    pendingVideoRef.current = null;
  };

  const clearBackground = () => {
    stopVideoSource();
    rendererRef.current?.setBackgroundVideo(null);
    rendererRef.current?.setBackgroundImage(null);
    pendingBackgroundRef.current = null;
    setBackgroundName("No media loaded");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const onImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      stopVideoSource();
      const bitmap = await createImageBitmap(file);
      if (rendererRef.current) {
        rendererRef.current.setBackgroundImage(bitmap);
      } else {
        pendingBackgroundRef.current = bitmap;
      }
      pendingVideoRef.current = null;
      setBackgroundName(`${file.name} (image)`);
      if (videoInputRef.current) videoInputRef.current.value = "";
    } catch {
      setError("Failed to read image file.");
    }
  };

  const onVideoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      stopVideoSource();

      const url = URL.createObjectURL(file);
      videoUrlRef.current = url;

      const video = document.createElement("video");
      video.src = url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Failed to load video file"));
        };
        const cleanup = () => {
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("error", onError);
        };
        video.addEventListener("loadeddata", onLoaded);
        video.addEventListener("error", onError);
      });

      await video.play().catch(() => undefined);

      videoElementRef.current = video;
      pendingBackgroundRef.current = null;

      if (rendererRef.current) {
        rendererRef.current.setBackgroundVideo(video);
      } else {
        pendingVideoRef.current = video;
      }

      setBackgroundName(`${file.name} (looping video)`);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      stopVideoSource();
      setError("Failed to read video file.");
    }
  };

  useEffect(() => {
    return () => {
      stopVideoSource();
    };
  }, []);

  const stopSelfTest = (restore = true) => {
    if (selfTestTimerRef.current !== null) {
      window.clearInterval(selfTestTimerRef.current);
      selfTestTimerRef.current = null;
    }
    if (restore && selfTestSavedRef.current) {
      setEffects(selfTestSavedRef.current);
    }
    selfTestSavedRef.current = null;
    setSelfTestKey(null);
    setSelfTestActive(false);
  };

  const startSelfTest = () => {
    if (selfTestActive) return;
    selfTestSavedRef.current = { ...effects };
    selfTestStartRef.current = performance.now();
    setSelfTestActive(true);
    setEffects(buildDefaultEffects());

    const perControlMs = 1100;
    selfTestTimerRef.current = window.setInterval(() => {
      const elapsed = performance.now() - selfTestStartRef.current;
      const phase = Math.floor(elapsed / perControlMs);
      const key = ALL_KEYS[phase % ALL_KEYS.length];
      const t = (elapsed % perControlMs) / perControlMs;
      const v = Math.sin(t * Math.PI);

      setSelfTestKey(key);
      setEffects((prev) => {
        const next = buildDefaultEffects();
        next[key] = v;
        if (prev[key] === next[key]) return prev;
        return next;
      });
    }, 33);
  };

  useEffect(() => {
    return () => {
      if (selfTestTimerRef.current !== null) {
        window.clearInterval(selfTestTimerRef.current);
        selfTestTimerRef.current = null;
      }
    };
  }, []);

  if (error) {
    return <div className="error-msg">{error}</div>;
  }

  return (
    <div className="app">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
      </div>

      <aside className="control-panel">
        <header className="panel-head">
          <h1>Datamosh Lab</h1>
          <p>Stacked effect playground (image/video-first)</p>
        </header>

        <input ref={fileInputRef} type="file" accept="image/*" className="file-input" onChange={onImageSelected} />
        <input ref={videoInputRef} type="file" accept="video/*" className="file-input" onChange={onVideoSelected} />

        <div className="asset-row">
          <button type="button" onClick={pickBackground} disabled={selfTestActive}>Load Image</button>
          <button type="button" onClick={pickVideo} disabled={selfTestActive}>Load Video</button>
          <button type="button" onClick={clearBackground} disabled={selfTestActive}>Clear Media</button>
        </div>
        <p className="asset-name">Background: {backgroundName}</p>

        <div className="preset-row">
          {PRESETS.map((p) => (
            <button key={p.name} type="button" onClick={() => applyPreset(p.name)} disabled={selfTestActive}>{p.name}</button>
          ))}
        </div>

        <div className="button-row">
          <button type="button" onClick={randomize} disabled={selfTestActive}>Randomize</button>
          <button type="button" onClick={resetDefaults} disabled={selfTestActive}>Reset</button>
        </div>
        <div className="button-row">
          <button type="button" onClick={startSelfTest} disabled={selfTestActive}>Start Self-Test</button>
          <button type="button" onClick={() => stopSelfTest(true)} disabled={!selfTestActive}>Stop Self-Test</button>
        </div>
        <p className="asset-name">
          Self-Test: {selfTestActive ? `Active (${selfTestKey ?? "..."})` : "Off"}
        </p>

        {GROUPS.map((group) => (
          <section className="control-section" key={group.title}>
            <h2>{group.title}</h2>
            {group.effects.map((ctrl) => (
              <label key={ctrl.key} className="control">
                <span>{ctrl.label}</span>
                <input
                  type="range"
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.step}
                  value={effects[ctrl.key]}
                  disabled={selfTestActive}
                  onChange={(e) => setEffect(ctrl.key, Number(e.target.value))}
                />
                <output>{effects[ctrl.key].toFixed(3)}</output>
              </label>
            ))}
          </section>
        ))}
      </aside>
    </div>
  );
}
