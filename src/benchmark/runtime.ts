import { apiUrl } from "../data/api";
import type { BenchmarkMode, ReferenceBenchmarkResult, ReferenceLogogramSample } from "../data/types";
import { BENCH_MIN_FPS_WINDOW_MS, BENCH_TARGET_FPS } from "../gpu/sim/constants";
import { computeMorphologyDistance } from "./distance";
import { extractGeneratedMaskStats } from "./generatedExtractor";
import { normalizeReferenceSamples } from "./referenceExtractor";

type RuntimeInput = {
  nowMs: number;
  benchmarkMode: BenchmarkMode;
  freezeToken: number | null;
  canonicalKey: string | null;
  sweepProgress: number;
  fps: number;
  taskStats: {
    ringCoverageRatio: number;
    ringSectorOccupancy: number[];
    sectorOccupancy: number[];
    ringBandOccupancyRatio: number;
    innerVoidPenalty: number;
    logogramChannelCounts: { ring: number; tendril: number; hook: number };
    generatedRadialProfile?: number[];
    generatedAngularHistogram12?: number[];
    generatedGapCount?: number;
    generatedFrayDensity?: number;
    generatedStrokeWidthMean?: number;
    generatedStrokeWidthVar?: number;
  };
};

type RuntimeOutput = {
  enabled: boolean;
  result: ReferenceBenchmarkResult | null;
  fpsGuardrailPass: boolean;
  candidateSetId: string;
  windowFrames: number;
  stabilityStdDev: number;
  overallPass: boolean;
};

const PASS_THRESHOLD = 0.22;
const STABILITY_STDDEV_MAX = 0.03;
const SCORE_WINDOW_FRAMES = 30;

export class BenchmarkRuntime {
  private loaded = false;
  private loading = false;
  private samples: ReferenceLogogramSample[] = [];
  private fpsWindow: Array<{ t: number; fps: number }> = [];
  private scoreWindow: number[] = [];
  private activeFreezeToken: number | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    try {
      const response = await fetch(apiUrl("/api/benchmark/references"));
      if (!response.ok) {
        this.samples = [];
        return;
      }
      const data = (await response.json()) as { entries?: ReferenceLogogramSample[] };
      this.samples = normalizeReferenceSamples(Array.isArray(data.entries) ? data.entries : []);
      this.loaded = true;
    } catch {
      this.samples = [];
    } finally {
      this.loading = false;
    }
  }

  async tick(input: RuntimeInput): Promise<RuntimeOutput> {
    await this.ensureLoaded();
    this.fpsWindow.push({ t: input.nowMs, fps: input.fps });
    const cutoff = input.nowMs - BENCH_MIN_FPS_WINDOW_MS;
    while (this.fpsWindow.length > 0 && this.fpsWindow[0].t < cutoff) this.fpsWindow.shift();
    const fpsGuardrailPass = this.fpsWindow.length > 0 && this.fpsWindow.every((entry) => entry.fps >= BENCH_TARGET_FPS);
    const fpsWindowMin = this.fpsWindow.length > 0 ? Math.min(...this.fpsWindow.map((v) => v.fps)) : 0;

    if (!this.loaded || this.samples.length === 0 || !input.canonicalKey || input.sweepProgress < 0.8) {
      this.scoreWindow = [];
      this.activeFreezeToken = null;
      return {
        enabled: this.loaded && this.samples.length > 0,
        result: null,
        fpsGuardrailPass,
        candidateSetId: "none",
        windowFrames: 0,
        stabilityStdDev: 0,
        overallPass: false,
      };
    }

    if (input.benchmarkMode === "frozen_eval") {
      if (this.activeFreezeToken === null) this.activeFreezeToken = input.freezeToken ?? Math.floor(input.nowMs);
    } else {
      this.activeFreezeToken = null;
    }

    const candidates = this.selectCandidates(input.canonicalKey);
    const candidateSetId = candidates.length === this.samples.length ? "all" : "narrowed";
    const generated = extractGeneratedMaskStats(input.taskStats);
    let best: ReferenceBenchmarkResult | null = null;
    for (const sample of candidates) {
      const distance = computeMorphologyDistance(generated, sample.maskStats);
      const result: ReferenceBenchmarkResult = {
        canonicalKey: input.canonicalKey,
        sampleId: sample.id,
        candidateSetId,
        distance,
        pass: distance.total <= PASS_THRESHOLD,
        stabilityStdDev: 0,
        fpsWindowMin,
        overallPass: false,
      };
      if (!best || result.distance.total < best.distance.total) best = result;
    }

    if (!best) {
      return {
        enabled: this.loaded && this.samples.length > 0,
        result: null,
        fpsGuardrailPass,
        candidateSetId,
        windowFrames: 0,
        stabilityStdDev: 0,
        overallPass: false,
      };
    }

    this.scoreWindow.push(best.distance.total);
    while (this.scoreWindow.length > SCORE_WINDOW_FRAMES) this.scoreWindow.shift();
    const mean = this.scoreWindow.reduce((acc, v) => acc + v, 0) / Math.max(1, this.scoreWindow.length);
    const variance = this.scoreWindow.reduce((acc, v) => {
      const d = v - mean;
      return acc + d * d;
    }, 0) / Math.max(1, this.scoreWindow.length);
    const stabilityStdDev = Math.sqrt(Math.max(0, variance));
    const stabilityPass = this.scoreWindow.length >= Math.min(10, SCORE_WINDOW_FRAMES) && stabilityStdDev <= STABILITY_STDDEV_MAX;
    const morphologyPass = best.distance.total <= PASS_THRESHOLD;
    const overallPass = morphologyPass && fpsGuardrailPass && stabilityPass;
    return {
      enabled: true,
      result: {
        ...best,
        pass: morphologyPass,
        stabilityStdDev,
        fpsWindowMin,
        overallPass,
      },
      fpsGuardrailPass,
      candidateSetId,
      windowFrames: this.scoreWindow.length,
      stabilityStdDev,
      overallPass,
    };
  }

  private selectCandidates(canonicalKey: string): ReferenceLogogramSample[] {
    const normKey = canonicalKey.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normKey) return this.samples;
    const tokens = normKey.split(/\s+/).filter((t) => t.length > 2);
    const direct = this.samples.filter((s) => {
      const fields = [s.id, s.label, ...(s.tags ?? []), ...(s.aliases ?? [])].join(" ").toLowerCase();
      return tokens.some((t) => fields.includes(t));
    });
    return direct.length >= 4 ? direct : this.samples;
  }
}
