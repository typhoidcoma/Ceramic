import { useEffect, useMemo, useRef, useState } from "react";
import { initWebGPU } from "./gpu/context";
import {
  BLEND_MODES,
  createLayer,
  EFFECT_BY_ID,
  EFFECT_REGISTRY,
  type BackgroundSource,
  type BlendMode,
  type EffectCategory,
  type EffectId,
  type EffectLayer,
  type GlobalOptions,
} from "./gpu/effectsRegistry";
import type { GlitchParams } from "./gpu/glitchPipeline";
import { PlaygroundRenderer } from "./gpu/playgroundRenderer";

const DATAMOSH_IDS = new Set<EffectId>(["dataMosh", "feedback", "softGlitch", "hardGlitch", "pixelSort", "decimate"]);
const EFFECT_DND_MIME = "application/x-ceramic-effect-id";

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function makeLayerId() {
  return `layer-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function effectIconText(label: string) {
  const words = label.split(/[\s/-]+/).filter(Boolean);
  if (words.length === 0) return "FX";
  if (words.length === 1) {
    const word = words[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    return word.slice(0, 2).padEnd(2, "X");
  }
  const joined = `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
  return joined.padEnd(2, "X");
}


function buildGlitchParams(layers: EffectLayer[]): GlitchParams {
  let blockSize = 1;
  const out: GlitchParams = {
    warpStrength: 0,
    blockSize,
    feedbackAmount: 0,
    feedbackDisplace: 0,
    rgbSplit: 0,
    glitchBurst: 0,
    decay: 0,
    blendToClean: 0,
    pixelSort: 0,
    blockRandom: 0,
    blockStretch: 1,
  };

  for (const layer of layers) {
    if (!layer.enabled || !DATAMOSH_IDS.has(layer.effectId)) continue;
    const strength = clamp(layer.amount, 0, 1) * clamp(layer.blend, 0, 1);
    switch (layer.effectId) {
      case "dataMosh": {
        out.feedbackAmount += strength * (layer.params.feedback ?? 0);
        out.decay += strength * (layer.params.decay ?? 0);
        out.blendToClean += strength * (layer.params.cleanBlend ?? 0);
        break;
      }
      case "feedback": {
        out.feedbackDisplace += strength * (layer.params.displace ?? 0);
        break;
      }
      case "softGlitch": {
        out.warpStrength += strength * (layer.params.warp ?? 0);
        break;
      }
      case "hardGlitch": {
        out.warpStrength += strength * 0.4;
        out.glitchBurst += strength * (layer.params.burst ?? 0);
        out.rgbSplit += strength * (layer.params.rgb ?? 0);
        break;
      }
      case "pixelSort": {
        const dir = clamp(layer.params.direction ?? 1, -1, 1);
        out.pixelSort += strength * dir;
        break;
      }
      case "decimate": {
        const targetSize = layer.params.blockSize ?? 1;
        const targetRandomSize = layer.params.randomSize ?? 0;
        const targetStretch = layer.params.stretch ?? 1;

        blockSize = Math.max(blockSize, 1 + (targetSize - 1) * strength);
        out.blockRandom = Math.max(out.blockRandom, targetRandomSize * strength);
        out.blockStretch += (targetStretch - 1) * strength;
        break;
      }
      default:
        break;
    }
  }

  out.blockSize = clamp(blockSize, 1, 128);
  out.feedbackAmount = clamp(out.feedbackAmount, 0, 0.995);
  out.feedbackDisplace = clamp(out.feedbackDisplace, 0, 0.45);
  out.warpStrength = clamp(out.warpStrength, 0, 4);
  out.rgbSplit = clamp(out.rgbSplit, 0, 64);
  out.glitchBurst = clamp(out.glitchBurst, 0, 4);
  out.decay = clamp(out.decay, 0, 0.6);
  out.blendToClean = clamp(out.blendToClean, 0, 1);
  out.pixelSort = clamp(out.pixelSort, -1, 1);
  out.blockRandom = clamp(out.blockRandom, 0, 1);
  out.blockStretch = clamp(out.blockStretch, 0.15, 6);
  return out;
}

function randomizeLayer(layer: EffectLayer): EffectLayer {
  const def = EFFECT_BY_ID[layer.effectId];
  const params: Record<string, number> = {};
  for (const p of def.paramDefs) {
    params[p.id] = clamp(p.min + Math.random() * (p.max - p.min), p.min, p.max);
  }
  return {
    ...layer,
    amount: Math.random(),
    blend: 0.5 + Math.random() * 0.5,
    params,
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PlaygroundRenderer | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const videoUrlRef = useRef<string | null>(null);

  const imageRef = useRef<ImageBitmap | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingBackgroundRef = useRef<BackgroundSource | null>(null);
  const pendingLayersRef = useRef<EffectLayer[] | null>(null);
  const pendingGlobalsRef = useRef<GlobalOptions | null>(null);

  const selfTestTimerRef = useRef<number | null>(null);
  const selfTestIndexRef = useRef(0);
  const selfTestSavedRef = useRef<EffectLayer[] | null>(null);

  const [layers, setLayers] = useState<EffectLayer[]>([]);
  const [underlayHex, setUnderlayHex] = useState("#142030");
  const [underlayOpacity, setUnderlayOpacity] = useState(1);
  const [backgroundMode, setBackgroundMode] = useState<"solidColor" | "image" | "video">("solidColor");
  const [backgroundName, setBackgroundName] = useState("Solid color");
  const [globalOptions, setGlobalOptions] = useState<GlobalOptions>({ quality: 1, pause: false, seed: 1 });
  const [soloLayerId, setSoloLayerId] = useState<string | null>(null);
  const [selfTestActive, setSelfTestActive] = useState(false);
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [draggingEffectId, setDraggingEffectId] = useState<EffectId | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const [dragOverStack, setDragOverStack] = useState(false);
  const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [rendererEpoch, setRendererEpoch] = useState(0);

  const libraryGroups = useMemo(() => {
    const groups = new Map<EffectCategory, typeof EFFECT_REGISTRY>();
    for (const effect of EFFECT_REGISTRY) {
      if (!groups.has(effect.category)) groups.set(effect.category, []);
      groups.get(effect.category)?.push(effect);
    }
    return Array.from(groups.entries());
  }, []);

  useEffect(() => {
    const onReinit = () => {
      setRendererEpoch((v) => v + 1);
    };
    window.addEventListener("ceramic:force-renderer-reinit", onReinit);
    return () => {
      window.removeEventListener("ceramic:force-renderer-reinit", onReinit);
    };
  }, []);

  const effectiveLayers = useMemo(() => {
    if (!soloLayerId) return layers;
    return layers.map((layer) => ({ ...layer, enabled: layer.enabled && layer.layerId === soloLayerId }));
  }, [layers, soloLayerId]);

  const glitchParams = useMemo(() => buildGlitchParams(effectiveLayers), [effectiveLayers]);
  const styleLayers = useMemo(
    () => effectiveLayers.filter((layer) => !DATAMOSH_IDS.has(layer.effectId)),
    [effectiveLayers],
  );

  const buildBackgroundSource = (): BackgroundSource => ({
    mode: backgroundMode,
    underlayColor: hexToRgb01(underlayHex),
    underlayOpacity,
    image: backgroundMode === "image" ? imageRef.current : null,
    video: backgroundMode === "video" ? videoRef.current : null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: PlaygroundRenderer | null = null;
    let destroyed = false;

    const init = async () => {
      try {
        if (rendererRef.current) {
          rendererRef.current.stop();
          rendererRef.current = null;
        }

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);

        const gpu = await initWebGPU(canvas);
        if (destroyed) return;

        renderer = new PlaygroundRenderer(gpu);
        rendererRef.current = renderer;

        const bg = pendingBackgroundRef.current ?? buildBackgroundSource();
        const pendingLayers = pendingLayersRef.current ?? styleLayers;
        const pendingGlobals = pendingGlobalsRef.current ?? globalOptions;

        renderer.setBackgroundSource(bg);
        renderer.setGlitchParams(glitchParams);
        renderer.setEffectStack(pendingLayers);
        renderer.setGlobalOptions(pendingGlobals);
        renderer.start();
        setError(null);
      } catch (e) {
        rendererRef.current = null;
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
  }, [rendererEpoch]);

  useEffect(() => {
    const bg = buildBackgroundSource();
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setBackgroundSource(bg);
    } else {
      pendingBackgroundRef.current = bg;
    }
  }, [backgroundMode, underlayHex, underlayOpacity, backgroundName]);

  useEffect(() => {
    rendererRef.current?.setGlitchParams(glitchParams);
  }, [glitchParams]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setEffectStack(styleLayers);
    } else {
      pendingLayersRef.current = styleLayers;
    }
  }, [styleLayers]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setGlobalOptions(globalOptions);
    } else {
      pendingGlobalsRef.current = globalOptions;
    }
  }, [globalOptions]);

  const stopVideoSource = () => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      videoRef.current = null;
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopVideoSource();
      if (selfTestTimerRef.current !== null) {
        window.clearInterval(selfTestTimerRef.current);
      }
    };
  }, []);

  const onImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      stopVideoSource();
      const bitmap = await createImageBitmap(file);
      imageRef.current = bitmap;
      setBackgroundMode("image");
      setBackgroundName(`${file.name} (image)`);
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
          reject(new Error("Failed to load video"));
        };
        const cleanup = () => {
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("error", onError);
        };
        video.addEventListener("loadeddata", onLoaded);
        video.addEventListener("error", onError);
      });

      await video.play().catch(() => undefined);
      videoRef.current = video;
      imageRef.current = null;
      setBackgroundMode("video");
      setBackgroundName(`${file.name} (looping video)`);
    } catch {
      stopVideoSource();
      setError("Failed to read video file.");
    }
  };

  const clearMedia = () => {
    stopVideoSource();
    imageRef.current = null;
    setBackgroundMode("solidColor");
    setBackgroundName("Solid color");
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const appendEffectLayer = (effectId: EffectId) => {
    setLayers((prev) => [...prev, createLayer(effectId, makeLayerId())]);
  };

  const insertEffectLayerBefore = (effectId: EffectId, targetLayerId: string) => {
    setLayers((prev) => {
      const index = prev.findIndex((layer) => layer.layerId === targetLayerId);
      if (index < 0) return [...prev, createLayer(effectId, makeLayerId())];
      const next = [...prev];
      next.splice(index, 0, createLayer(effectId, makeLayerId()));
      return next;
    });
  };

  const clearStack = () => {
    setLayers([]);
    setSoloLayerId(null);
    setExpandedLayerIds(new Set());
  };

  const updateLayer = (layerId: string, updater: (layer: EffectLayer) => EffectLayer) => {
    setLayers((prev) => prev.map((layer) => (layer.layerId === layerId ? updater(layer) : layer)));
  };

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    setLayers((prev) => {
      const idx = prev.findIndex((layer) => layer.layerId === layerId);
      if (idx < 0) return prev;
      const nextIdx = idx + direction;
      if (nextIdx < 0 || nextIdx >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(nextIdx, 0, item);
      return next;
    });
  };

  const moveLayerTo = (dragLayerId: string, targetLayerId: string) => {
    if (dragLayerId === targetLayerId) return;
    setLayers((prev) => {
      const from = prev.findIndex((layer) => layer.layerId === dragLayerId);
      const to = prev.findIndex((layer) => layer.layerId === targetLayerId);
      if (from < 0 || to < 0 || from === to) return prev;

      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const duplicateLayer = (layerId: string) => {
    setLayers((prev) => {
      const idx = prev.findIndex((layer) => layer.layerId === layerId);
      if (idx < 0) return prev;
      const layer = prev[idx];
      const clone: EffectLayer = { ...layer, layerId: makeLayerId() };
      const next = [...prev];
      next.splice(idx + 1, 0, clone);
      return next;
    });
  };

  const removeLayer = (layerId: string) => {
    setLayers((prev) => prev.filter((layer) => layer.layerId !== layerId));
    if (soloLayerId === layerId) setSoloLayerId(null);
    setExpandedLayerIds((prev) => {
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });
  };

  const toggleLayerExpanded = (layerId: string) => {
    setExpandedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const resetLayer = (layerId: string) => {
    updateLayer(layerId, (layer) => {
      const def = EFFECT_BY_ID[layer.effectId];
      return { ...layer, amount: def.defaultAmount, blend: 1, blendMode: "normal", params: { ...def.neutralParams } };
    });
  };

  const randomizeAll = () => {
    setLayers((prev) => prev.map((layer) => randomizeLayer(layer)));
  };

  const resetAll = () => {
    setLayers((prev) => prev.map((layer) => {
      const def = EFFECT_BY_ID[layer.effectId];
      return { ...layer, amount: def.defaultAmount, blend: 1, blendMode: "normal", params: { ...def.neutralParams }, enabled: true };
    }));
    setSoloLayerId(null);
  };


  const startSelfTest = () => {
    if (selfTestActive || layers.length === 0) return;
    selfTestSavedRef.current = layers;
    selfTestIndexRef.current = 0;
    setSelfTestActive(true);

    selfTestTimerRef.current = window.setInterval(() => {
      setLayers((prev) => {
        if (prev.length === 0) return prev;
        const index = selfTestIndexRef.current % prev.length;
        selfTestIndexRef.current += 1;
        const layerId = prev[index]?.layerId;
        return prev.map((layer) => {
          if (layer.layerId !== layerId) return { ...layer, amount: 0 };
          const nextAmount = layer.amount > 0.9 ? 0 : 1;
          return { ...layer, amount: nextAmount };
        });
      });
    }, 700);
  };

  const stopSelfTest = () => {
    if (selfTestTimerRef.current !== null) {
      window.clearInterval(selfTestTimerRef.current);
      selfTestTimerRef.current = null;
    }
    if (selfTestSavedRef.current) {
      setLayers(selfTestSavedRef.current);
      selfTestSavedRef.current = null;
    }
    setSelfTestActive(false);
  };

  if (error) {
    return <div className="error-msg">{error}</div>;
  }

  return (
    <div className="app layered-app">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
      </div>

      <aside className="control-panel panel-left">
        <header className="panel-head">
          <h1>Datamosh Lab</h1>
          <p>Layered WebGPU glitch stack with fine controls</p>
        </header>

        <section className="control-section">
          <h2>Background</h2>
          <input ref={imageInputRef} type="file" accept="image/*" className="file-input" onChange={onImageSelected} />
          <input ref={videoInputRef} type="file" accept="video/*" className="file-input" onChange={onVideoSelected} />
          <div className="asset-row">
            <button type="button" onClick={() => imageInputRef.current?.click()}>Load Image</button>
            <button type="button" onClick={() => videoInputRef.current?.click()}>Load Video</button>
            <button type="button" onClick={clearMedia}>Clear Media</button>
          </div>
          <p className="asset-name">Source: {backgroundName}</p>

          <label className="control">
            <span>Mode</span>
            <select value={backgroundMode} onChange={(e) => setBackgroundMode(e.target.value as typeof backgroundMode)}>
              <option value="solidColor">Solid Color</option>
              <option value="image" disabled={!imageRef.current}>Image</option>
              <option value="video" disabled={!videoRef.current}>Video</option>
            </select>
          </label>

          <label className="control">
            <span>Underlay Color</span>
            <input type="color" value={underlayHex} onChange={(e) => setUnderlayHex(e.target.value)} />
          </label>

          <label className="control">
            <span>Underlay Opacity</span>
            <input type="range" min={0} max={1} step={0.01} value={underlayOpacity} onChange={(e) => setUnderlayOpacity(Number(e.target.value))} />
            <output>{underlayOpacity.toFixed(2)}</output>
          </label>
        </section>

        <section className="control-section">
          <h2>Global</h2>
          <div className="button-row">
            <button type="button" onClick={() => setGlobalOptions((g) => ({ ...g, pause: !g.pause }))}>
              {globalOptions.pause ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => setGlobalOptions((g) => ({ ...g, seed: Math.random() * 1000 }))}>New Seed</button>
          </div>
          <label className="control">
            <span>Quality</span>
            <input type="range" min={0.5} max={1} step={0.01} value={globalOptions.quality} onChange={(e) => setGlobalOptions((g) => ({ ...g, quality: Number(e.target.value) }))} />
            <output>{globalOptions.quality.toFixed(2)}</output>
          </label>
        </section>

        <section className="control-section">
          <h2>Tools</h2>
          <div className="button-row">
            <button type="button" onClick={randomizeAll} disabled={layers.length === 0}>Randomize</button>
            <button type="button" onClick={resetAll} disabled={layers.length === 0}>Reset</button>
          </div>
          <div className="button-row">
            <button type="button" onClick={startSelfTest} disabled={selfTestActive || layers.length === 0}>Start Self-Test</button>
            <button type="button" onClick={stopSelfTest} disabled={!selfTestActive}>Stop Self-Test</button>
          </div>
        </section>

        <section className="control-section">
          <h2>Effects Library</h2>
          <p className="asset-name">Drag into stack or double-click to add</p>
          {libraryGroups.map(([category, effects]) => (
            <div key={category} className="library-group">
              <h2>{category}</h2>
              <div className="library-grid">
                {effects.map((effect) => (
                  <button
                    key={effect.id}
                    className={`library-item${draggingEffectId === effect.id ? " is-dragging" : ""}`}
                    type="button"
                    draggable
                    onDoubleClick={() => appendEffectLayer(effect.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(EFFECT_DND_MIME, effect.id);
                      e.dataTransfer.effectAllowed = "copyMove";
                      setDraggingEffectId(effect.id);
                    }}
                    onDragEnd={() => {
                      setDraggingEffectId(null);
                      setDragOverStack(false);
                    }}
                  >
                    <span className="library-icon" aria-hidden>{effectIconText(effect.label)}</span>
                    <span>{effect.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </aside>

      <aside className="control-panel panel-right">
        <header className="panel-head">
          <h1>Effect Stack</h1>
          <p>Start empty. Drag effects from library.</p>
        </header>

        <section className="control-section">
          <div className="button-row">
            <button type="button" onClick={clearStack} disabled={layers.length === 0}>Clear Stack</button>
            <button type="button" onClick={() => setSoloLayerId(null)} disabled={!soloLayerId}>Clear Solo</button>
          </div>
        </section>

        <div
          className={`stack-dropzone${dragOverStack ? " is-drag-over" : ""}${layers.length === 0 ? " is-empty" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(EFFECT_DND_MIME)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragOverStack(true);
            }
          }}
          onDragLeave={() => setDragOverStack(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const effectId = e.dataTransfer.getData(EFFECT_DND_MIME) as EffectId;
            if (effectId && EFFECT_BY_ID[effectId]) {
              appendEffectLayer(effectId);
            }
            setDragOverStack(false);
            setDraggingEffectId(null);
          }}
        >
          {layers.length === 0 && (
            <p className="empty-stack-note">Drop effects here to build a clean stack.</p>
          )}

          {layers.map((layer, idx) => {
            const def = EFFECT_BY_ID[layer.effectId];
            const isExpanded = expandedLayerIds.has(layer.layerId);
            return (
              <section
                className={`layer-card${soloLayerId === layer.layerId ? " is-solo" : ""}${!layer.enabled ? " is-bypassed" : ""}${draggingLayerId === layer.layerId ? " is-dragging" : ""}${dragOverLayerId === layer.layerId ? " is-drag-over" : ""}`}
                key={layer.layerId}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (draggingLayerId && draggingLayerId !== layer.layerId) {
                    e.dataTransfer.dropEffect = "move";
                    setDragOverLayerId(layer.layerId);
                  }
                  if (draggingEffectId) {
                    e.dataTransfer.dropEffect = "copy";
                    setDragOverLayerId(layer.layerId);
                  }
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragOverLayerId(layer.layerId);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const effectId = e.dataTransfer.getData(EFFECT_DND_MIME) as EffectId;
                  if (effectId && EFFECT_BY_ID[effectId]) {
                    insertEffectLayerBefore(effectId, layer.layerId);
                  } else {
                    const dragId = e.dataTransfer.getData("text/plain") || draggingLayerId;
                    if (dragId) moveLayerTo(dragId, layer.layerId);
                  }
                  setDragOverLayerId(null);
                  setDraggingLayerId(null);
                  setDraggingEffectId(null);
                }}
              >
                <div className="layer-row">
                  <button
                    className={`layer-chevron${isExpanded ? " is-open" : ""}`}
                    type="button"
                    onClick={() => toggleLayerExpanded(layer.layerId)}
                    aria-label={isExpanded ? "Collapse layer" : "Expand layer"}
                  >
                    &gt;
                  </button>
                  <strong className="layer-name">{def.label}</strong>
                  <button
                    className={`layer-chip${soloLayerId === layer.layerId ? " is-solo-toggle" : ""}`}
                    type="button"
                    onClick={() => setSoloLayerId((id) => (id === layer.layerId ? null : layer.layerId))}
                  >
                    S
                  </button>
                  <button
                    className={`layer-toggle${layer.enabled ? " is-on" : ""}`}
                    type="button"
                    onClick={() => updateLayer(layer.layerId, (l) => ({ ...l, enabled: !l.enabled }))}
                    aria-label={layer.enabled ? "Disable layer" : "Enable layer"}
                  >
                    <span />
                  </button>
                  <button className="layer-x" type="button" onClick={() => removeLayer(layer.layerId)} aria-label="Remove layer">x</button>
                  <div
                    className="layer-grab"
                    draggable
                    title="Drag to reorder"
                    aria-label="Drag layer"
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", layer.layerId);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingLayerId(layer.layerId);
                    }}
                    onDragEnd={() => {
                      setDragOverLayerId(null);
                      setDraggingLayerId(null);
                    }}
                  >
                    |||
                  </div>
                </div>

                {isExpanded && (
                  <div className="layer-body">
                    <div className="layer-actions">
                      <button className={!layer.enabled ? "is-active is-bypassed-toggle" : ""} type="button" onClick={() => updateLayer(layer.layerId, (l) => ({ ...l, enabled: !l.enabled }))}>{layer.enabled ? "Bypass" : "Enable"}</button>
                      <button className={soloLayerId === layer.layerId ? "is-active is-solo-toggle" : ""} type="button" onClick={() => setSoloLayerId((id) => (id === layer.layerId ? null : layer.layerId))}>{soloLayerId === layer.layerId ? "Unsolo" : "Solo"}</button>
                      <button type="button" onClick={() => moveLayer(layer.layerId, -1)} disabled={idx === 0}>Up</button>
                      <button type="button" onClick={() => moveLayer(layer.layerId, 1)} disabled={idx === layers.length - 1}>Down</button>
                      <button type="button" onClick={() => duplicateLayer(layer.layerId)}>Duplicate</button>
                      <button type="button" onClick={() => resetLayer(layer.layerId)}>Reset</button>
                    </div>

                    <label className="control">
                      <span>Amount</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={layer.amount}
                        onChange={(e) => updateLayer(layer.layerId, (l) => ({ ...l, amount: Number(e.target.value) }))}
                      />
                      <output>{layer.amount.toFixed(2)}</output>
                    </label>

                    <label className="control">
                      <span>Blend</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={layer.blend}
                        onChange={(e) => updateLayer(layer.layerId, (l) => ({ ...l, blend: Number(e.target.value) }))}
                      />
                      <output>{layer.blend.toFixed(2)}</output>
                    </label>

                    <label className="control">
                      <span>Blend Mode</span>
                      <select
                        value={layer.blendMode}
                        onChange={(e) => updateLayer(layer.layerId, (l) => ({ ...l, blendMode: e.target.value as BlendMode }))}
                      >
                        {BLEND_MODES.map((mode) => (
                          <option key={mode.id} value={mode.id}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    {def.paramDefs.length > 0 && (
                      <details>
                        <summary>Advanced</summary>
                        {def.paramDefs.map((param) => (
                          <label key={param.id} className="control">
                            <span>{param.label}</span>
                            <input
                              type="range"
                              min={param.min}
                              max={param.max}
                              step={param.step}
                              value={layer.params[param.id]}
                              onChange={(e) => updateLayer(layer.layerId, (l) => ({
                                ...l,
                                params: { ...l.params, [param.id]: Number(e.target.value) },
                              }))}
                            />
                            <output>{layer.params[param.id].toFixed(2)}</output>
                          </label>
                        ))}
                      </details>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}




















