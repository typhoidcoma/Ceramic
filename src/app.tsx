import { useRef, useEffect, useState, useCallback } from "react";
import { initWebGPU } from "./gpu/context";
import { Renderer } from "./gpu/renderer";
import { generateGrammar } from "./logogram/grammar";
import { rasterizeLogogram } from "./logogram/rasterize";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [word, setWord] = useState("human");
  const [error, setError] = useState<string | null>(null);
  const isFirstLogogram = useRef(true);
  const debounceRef = useRef<number>(0);

  // Initialize WebGPU
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: Renderer | null = null;
    let destroyed = false;

    const init = async () => {
      try {
        // Size canvas to device pixels
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);

        const gpu = await initWebGPU(canvas);
        if (destroyed) return;

        renderer = new Renderer(gpu);
        rendererRef.current = renderer;

        // Generate initial logogram
        const grammar = generateGrammar("human");
        const imageData = rasterizeLogogram(grammar);
        renderer.uploadLogogram(imageData, "A");
        renderer.uploadLogogram(imageData, "B"); // both same initially
        renderer.startReveal();
        renderer.start();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to initialize WebGPU");
      }
    };

    init();

    // Handle resize
    const onResize = () => {
      if (!canvas || !renderer) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    window.addEventListener("resize", onResize);

    return () => {
      destroyed = true;
      renderer?.stop();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Handle word changes
  const updateLogogram = useCallback((newWord: string) => {
    const renderer = rendererRef.current;
    if (!renderer || !newWord.trim()) return;

    const grammar = generateGrammar(newWord.trim());
    const imageData = rasterizeLogogram(grammar);

    if (isFirstLogogram.current) {
      renderer.uploadLogogram(imageData, "A");
      renderer.uploadLogogram(imageData, "B");
      renderer.startReveal();
      isFirstLogogram.current = false;
    } else {
      renderer.uploadLogogram(imageData, "B");
      renderer.startTransition();
    }
  }, []);

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setWord(val);

      // Debounce
      clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        if (val.trim()) {
          updateLogogram(val);
        }
      }, 500);
    },
    [updateLogogram],
  );

  if (error) {
    return (
      <div className="app">
        <div className="error-msg">{error}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="input-wrap">
        <input
          type="text"
          value={word}
          onChange={onInputChange}
          placeholder="type a word..."
          spellCheck={false}
          autoFocus
        />
      </div>
    </div>
  );
}
