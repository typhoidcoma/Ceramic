import { ATOM_TYPES, type Atom, type AtomPatch, type AtomState, type AtomType, type BenchmarkMode, type LogogramSolveBreakdown, type TimelineBucket, type TimelineSortMode, enrichAtom } from "../data/types";
import { assignSmokeTargets, easePosition, type LayoutMode } from "../layout/layout";

export type Filters = {
  types: Set<AtomType>;
  states: Set<AtomState>;
  query: string;
};

export type QualityTierOverride = "auto" | "safe" | "balanced" | "high";

export type ActiveMessageState = {
  activeMessageAtomId: string | null;
  activeMessagePrevAtomId: string | null;
  activeMessageBlend: number;
  activeMessageUpdatedAt: number;
  activeMessageMatchSource: "dictionary" | "unknown" | "none";
  activeMessageMatchedPhrase: string | null;
  activeMessageCanonicalKey: string | null;
};

type Snapshot = {
  selectedId: string | null;
  hoveredId: string | null;
  totalCount: number;
  visibleCount: number;
  fps: number;
  filters: Filters;
  layoutMode: LayoutMode;
  overlayMinimized: boolean;
  inspectorOpen: boolean;
  qualityTierOverride: QualityTierOverride;
  showDiagnostics: boolean;
  activeMessageAtomId: string | null;
  activeMessagePrevAtomId: string | null;
  activeMessageBlend: number;
  activeMessageUpdatedAt: number;
  activeMessageMatchSource: "dictionary" | "unknown" | "none";
  activeMessageMatchedPhrase: string | null;
  activeMessageCanonicalKey: string | null;
  taskPointCount: number;
  promptLatencyMs: number | null;
  showLumaHistogram: boolean;
  inkFieldMean: number;
  inkFieldMax: number;
  brightPixelRatio: number;
  lumaHistogram: number[];
  frameLumaMeanActual: number;
  frameLumaMaxActual: number;
  brightPixelRatioActual: number;
  frameLumaHistogramActual: number[];
  sseStatus: "connecting" | "open" | "stale" | "closed";
  lastEventAtMs: number;
  activeMessagePresent: boolean;
  hasTaskPoints: boolean;
  zeroPointFrames: number;
  logogramChannelCounts: { ring: number; tendril: number; hook: number };
  maskPointCountRing: number;
  maskPointCountBlob: number;
  maskPointCountTendril: number;
  maskContinuityScore: number;
  maskArcOccupancy12: number[];
  ringContinuityScore: number;
  sweepProgress: number;
  injectorBBoxArea: number;
  ringCoverageRatio: number;
  ringBandOccupancyRatio: number;
  innerVoidRatio: number;
  innerVoidPenalty: number;
  centerMassRatio: number;
  sectorOccupancy: number[];
  ringSectorOccupancy: number[];
  solveEnergy: number;
  solveBreakdown: LogogramSolveBreakdown;
  unwrapProfiles: { activationTheta: number[]; thicknessTheta: number[]; spurTheta: number[] };
  gapCountSolved: number;
  constraintViolationCount: number;
  shapeSignature: number[];
  signatureDistanceToCanonical: number;
  textureEntropy: number;
  radialVariance: number;
  arcSpacingVariance: number;
  repeatScore: number;
  generatedRadialProfile: number[];
  generatedAngularHistogram12: number[];
  generatedGapCount: number;
  generatedFrayDensity: number;
  generatedStrokeWidthMean: number;
  generatedStrokeWidthVar: number;
  benchmarkEnabled: boolean;
  benchmarkMode: BenchmarkMode;
  benchmarkSampleId: string | null;
  benchmarkCandidateSetId: string | null;
  benchmarkScoreTotal: number;
  benchmarkScoreStdDev: number;
  benchmarkPass: boolean;
  benchmarkOverallPass: boolean;
  benchmarkFpsWindowMin: number;
  benchmarkDistanceBreakdown: { radial: number; angular: number; gaps: number; fray: number; width: number };
  fpsGuardrailPass: boolean;
};

type Listener = () => void;

export class AtomStore {
  private atomMap = new Map<string, Atom>();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private listeners = new Set<Listener>();
  private viewListeners = new Set<Listener>();
  private visibleAtomsCache: Atom[] = [];
  private visibleDirty = true;
  private layoutDirty = true;
  private fps = 0;
  private viewVersion = 0;
  private layoutMode: LayoutMode = "smoke_field";
  private overlayMinimized = false;
  private inspectorOpen = true;
  private qualityTierOverride: QualityTierOverride = "auto";
  private showDiagnostics = true;
  private activeMessageAtomId: string | null = null;
  private activeMessagePrevAtomId: string | null = null;
  private activeMessageStartAt = 0;
  private activeMessageBlend = 1;
  private activeMessageUpdatedAt = 0;
  private readonly activeMessageDurationMs = 800;
  private activeMessageMatchSource: "dictionary" | "unknown" | "none" = "none";
  private activeMessageMatchedPhrase: string | null = null;
  private activeMessageCanonicalKey: string | null = null;
  private taskPointCount = 0;
  private promptLatencyMs: number | null = null;
  private showLumaHistogram = false;
  private inkFieldMean = 0;
  private inkFieldMax = 0;
  private brightPixelRatio = 0;
  private lumaHistogram = [0, 0, 0, 0, 0, 0, 0, 0];
  private frameLumaMeanActual = 0;
  private frameLumaMaxActual = 0;
  private brightPixelRatioActual = 0;
  private frameLumaHistogramActual = [0, 0, 0, 0, 0, 0, 0, 0];
  private sseStatus: "connecting" | "open" | "stale" | "closed" = "connecting";
  private lastEventAtMs = 0;
  private zeroPointFrames = 0;
  private logogramChannelCounts = { ring: 0, tendril: 0, hook: 0 };
  private maskPointCountRing = 0;
  private maskPointCountBlob = 0;
  private maskPointCountTendril = 0;
  private maskContinuityScore = 0;
  private maskArcOccupancy12 = Array.from({ length: 12 }, () => 0);
  private ringContinuityScore = 0;
  private sweepProgress = 0;
  private injectorBBoxArea = 0;
  private ringCoverageRatio = 0;
  private ringBandOccupancyRatio = 0;
  private innerVoidRatio = 1;
  private innerVoidPenalty = 0;
  private centerMassRatio = 0;
  private sectorOccupancy = Array.from({ length: 12 }, () => 0);
  private ringSectorOccupancy = Array.from({ length: 12 }, () => 0);
  private solveEnergy = 0;
  private solveBreakdown: LogogramSolveBreakdown = { eMask: 0, eContinuity: 0, eGap: 0, eThickness: 0, eVoid: 0, eRadius: 0, eSparsity: 0, total: 0 };
  private unwrapProfiles = { activationTheta: Array.from({ length: 192 }, () => 0), thicknessTheta: Array.from({ length: 192 }, () => 0), spurTheta: Array.from({ length: 192 }, () => 0) };
  private gapCountSolved = 0;
  private constraintViolationCount = 0;
  private shapeSignature = Array.from({ length: 24 }, () => 0);
  private signatureDistanceToCanonical = 0;
  private textureEntropy = 0;
  private radialVariance = 0;
  private arcSpacingVariance = 0;
  private repeatScore = 0;
  private generatedRadialProfile = Array.from({ length: 24 }, () => 0);
  private generatedAngularHistogram12 = Array.from({ length: 12 }, () => 0);
  private generatedGapCount = 0;
  private generatedFrayDensity = 0;
  private generatedStrokeWidthMean = 0;
  private generatedStrokeWidthVar = 0;
  private benchmarkEnabled = false;
  private benchmarkMode: BenchmarkMode = "disabled_by_plan";
  private benchmarkSampleId: string | null = null;
  private benchmarkCandidateSetId: string | null = null;
  private benchmarkScoreTotal = 0;
  private benchmarkScoreStdDev = 0;
  private benchmarkPass = false;
  private benchmarkOverallPass = false;
  private benchmarkFpsWindowMin = 0;
  private benchmarkDistanceBreakdown = { radial: 0, angular: 0, gaps: 0, fray: 0, width: 0 };
  private fpsGuardrailPass = true;
  private filters: Filters = {
    types: new Set(ATOM_TYPES),
    states: new Set(["new", "active", "snoozed", "done"]),
    query: "",
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeView(listener: Listener): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  getSnapshot(): Snapshot {
    return {
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      totalCount: this.atomMap.size,
      visibleCount: this.getVisibleAtoms().length,
      fps: this.fps,
      filters: this.filters,
      layoutMode: this.layoutMode,
      overlayMinimized: this.overlayMinimized,
      inspectorOpen: this.inspectorOpen,
      qualityTierOverride: this.qualityTierOverride,
      showDiagnostics: this.showDiagnostics,
      activeMessageAtomId: this.activeMessageAtomId,
      activeMessagePrevAtomId: this.activeMessagePrevAtomId,
      activeMessageBlend: this.activeMessageBlend,
      activeMessageUpdatedAt: this.activeMessageUpdatedAt,
      activeMessageMatchSource: this.activeMessageMatchSource,
      activeMessageMatchedPhrase: this.activeMessageMatchedPhrase,
      activeMessageCanonicalKey: this.activeMessageCanonicalKey,
      taskPointCount: this.taskPointCount,
      promptLatencyMs: this.promptLatencyMs,
      showLumaHistogram: this.showLumaHistogram,
      inkFieldMean: this.inkFieldMean,
      inkFieldMax: this.inkFieldMax,
      brightPixelRatio: this.brightPixelRatio,
      lumaHistogram: [...this.lumaHistogram],
      frameLumaMeanActual: this.frameLumaMeanActual,
      frameLumaMaxActual: this.frameLumaMaxActual,
      brightPixelRatioActual: this.brightPixelRatioActual,
      frameLumaHistogramActual: [...this.frameLumaHistogramActual],
      sseStatus: this.sseStatus,
      lastEventAtMs: this.lastEventAtMs,
      activeMessagePresent: this.activeMessageAtomId !== null,
      hasTaskPoints: this.taskPointCount > 0,
      zeroPointFrames: this.zeroPointFrames,
      logogramChannelCounts: { ...this.logogramChannelCounts },
      maskPointCountRing: this.maskPointCountRing,
      maskPointCountBlob: this.maskPointCountBlob,
      maskPointCountTendril: this.maskPointCountTendril,
      maskContinuityScore: this.maskContinuityScore,
      maskArcOccupancy12: [...this.maskArcOccupancy12],
      ringContinuityScore: this.ringContinuityScore,
      sweepProgress: this.sweepProgress,
      injectorBBoxArea: this.injectorBBoxArea,
      ringCoverageRatio: this.ringCoverageRatio,
      ringBandOccupancyRatio: this.ringBandOccupancyRatio,
      innerVoidRatio: this.innerVoidRatio,
      innerVoidPenalty: this.innerVoidPenalty,
      centerMassRatio: this.centerMassRatio,
      sectorOccupancy: [...this.sectorOccupancy],
      ringSectorOccupancy: [...this.ringSectorOccupancy],
      solveEnergy: this.solveEnergy,
      solveBreakdown: { ...this.solveBreakdown },
      unwrapProfiles: {
        activationTheta: [...this.unwrapProfiles.activationTheta],
        thicknessTheta: [...this.unwrapProfiles.thicknessTheta],
        spurTheta: [...this.unwrapProfiles.spurTheta],
      },
      gapCountSolved: this.gapCountSolved,
      constraintViolationCount: this.constraintViolationCount,
      shapeSignature: [...this.shapeSignature],
      signatureDistanceToCanonical: this.signatureDistanceToCanonical,
      textureEntropy: this.textureEntropy,
      radialVariance: this.radialVariance,
      arcSpacingVariance: this.arcSpacingVariance,
      repeatScore: this.repeatScore,
      generatedRadialProfile: [...this.generatedRadialProfile],
      generatedAngularHistogram12: [...this.generatedAngularHistogram12],
      generatedGapCount: this.generatedGapCount,
      generatedFrayDensity: this.generatedFrayDensity,
      generatedStrokeWidthMean: this.generatedStrokeWidthMean,
      generatedStrokeWidthVar: this.generatedStrokeWidthVar,
      benchmarkEnabled: this.benchmarkEnabled,
      benchmarkMode: this.benchmarkMode,
      benchmarkSampleId: this.benchmarkSampleId,
      benchmarkCandidateSetId: this.benchmarkCandidateSetId,
      benchmarkScoreTotal: this.benchmarkScoreTotal,
      benchmarkScoreStdDev: this.benchmarkScoreStdDev,
      benchmarkPass: this.benchmarkPass,
      benchmarkOverallPass: this.benchmarkOverallPass,
      benchmarkFpsWindowMin: this.benchmarkFpsWindowMin,
      benchmarkDistanceBreakdown: { ...this.benchmarkDistanceBreakdown },
      fpsGuardrailPass: this.fpsGuardrailPass,
    };
  }

  getViewVersion(): number {
    return this.viewVersion;
  }

  setFps(fps: number): void {
    this.fps = fps;
    this.emitView();
  }

  setTaskPointCount(count: number): void {
    const next = Math.max(0, Math.floor(count));
    if (next > 0) this.zeroPointFrames = 0;
    else this.zeroPointFrames += 1;
    if (this.taskPointCount === next) {
      this.emitView();
      return;
    }
    this.taskPointCount = next;
    this.emitView();
  }

  setSseStatus(status: "connecting" | "open" | "stale" | "closed"): void {
    if (this.sseStatus === status) return;
    this.sseStatus = status;
    this.emitView();
  }

  setLastEventAtMs(ms: number): void {
    const next = Math.max(0, Math.floor(ms));
    if (this.lastEventAtMs === next) return;
    this.lastEventAtMs = next;
    this.emitView();
  }

  setLogogramDiagnostics(input: {
    channelCounts: { ring: number; tendril: number; hook: number };
    maskPointCountRing: number;
    maskPointCountBlob: number;
    maskPointCountTendril: number;
    maskContinuityScore: number;
    maskArcOccupancy12: number[];
    ringContinuityScore: number;
    sweepProgress: number;
    injectorBBoxArea: number;
    ringCoverageRatio: number;
    ringBandOccupancyRatio: number;
    innerVoidRatio: number;
    innerVoidPenalty: number;
    centerMassRatio: number;
    sectorOccupancy: number[];
    ringSectorOccupancy: number[];
    solveEnergy: number;
    solveBreakdown: LogogramSolveBreakdown;
    unwrapProfiles: { activationTheta: number[]; thicknessTheta: number[]; spurTheta: number[] };
    gapCountSolved: number;
    constraintViolationCount: number;
    shapeSignature: number[];
    signatureDistanceToCanonical: number;
    textureEntropy: number;
    radialVariance: number;
    arcSpacingVariance: number;
    repeatScore: number;
    generatedRadialProfile: number[];
    generatedAngularHistogram12: number[];
    generatedGapCount: number;
    generatedFrayDensity: number;
    generatedStrokeWidthMean: number;
    generatedStrokeWidthVar: number;
  }): void {
    const next = {
      ring: Math.max(0, Math.floor(input.channelCounts.ring)),
      tendril: Math.max(0, Math.floor(input.channelCounts.tendril)),
      hook: Math.max(0, Math.floor(input.channelCounts.hook)),
    };
    const maskPointCountRing = Math.max(0, Math.floor(input.maskPointCountRing));
    const maskPointCountBlob = Math.max(0, Math.floor(input.maskPointCountBlob));
    const maskPointCountTendril = Math.max(0, Math.floor(input.maskPointCountTendril));
    const maskContinuityScore = Math.max(0, Math.min(1, input.maskContinuityScore));
    const maskArcOccupancy12 = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.floor(input.maskArcOccupancy12[i] ?? 0)));
    const continuity = Math.max(0, Math.min(1, input.ringContinuityScore));
    const sweep = Math.max(0, Math.min(1, input.sweepProgress));
    const area = Math.max(0, Math.min(1, input.injectorBBoxArea));
    const coverage = Math.max(0, Math.min(1, input.ringCoverageRatio));
    const bandOccupancy = Math.max(0, Math.min(1, input.ringBandOccupancyRatio));
    const voidRatio = Math.max(0, Math.min(1, input.innerVoidRatio));
    const voidPenalty = Math.max(0, Math.min(1, input.innerVoidPenalty));
    const centerRatio = Math.max(0, Math.min(1, input.centerMassRatio));
    const sectors = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.floor(input.sectorOccupancy[i] ?? 0)));
    const ringSectors = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.floor(input.ringSectorOccupancy[i] ?? 0)));
    const solveEnergy = Number.isFinite(input.solveEnergy) ? Math.max(0, input.solveEnergy) : 0;
    const solveBreakdown: LogogramSolveBreakdown = {
      eMask: Number.isFinite(input.solveBreakdown.eMask) ? Math.max(0, input.solveBreakdown.eMask) : 0,
      eContinuity: Number.isFinite(input.solveBreakdown.eContinuity) ? Math.max(0, input.solveBreakdown.eContinuity) : 0,
      eGap: Number.isFinite(input.solveBreakdown.eGap) ? Math.max(0, input.solveBreakdown.eGap) : 0,
      eThickness: Number.isFinite(input.solveBreakdown.eThickness) ? Math.max(0, input.solveBreakdown.eThickness) : 0,
      eVoid: Number.isFinite(input.solveBreakdown.eVoid) ? Math.max(0, input.solveBreakdown.eVoid) : 0,
      eRadius: Number.isFinite(input.solveBreakdown.eRadius) ? Math.max(0, input.solveBreakdown.eRadius) : 0,
      eSparsity: Number.isFinite(input.solveBreakdown.eSparsity) ? Math.max(0, input.solveBreakdown.eSparsity) : 0,
      total: Number.isFinite(input.solveBreakdown.total) ? Math.max(0, input.solveBreakdown.total) : 0,
    };
    const unwrapProfiles = {
      activationTheta: Array.from({ length: 192 }, (_, i) => Math.max(0, Math.min(1, input.unwrapProfiles.activationTheta[i] ?? 0))),
      thicknessTheta: Array.from({ length: 192 }, (_, i) => Math.max(0, Math.min(1, input.unwrapProfiles.thicknessTheta[i] ?? 0))),
      spurTheta: Array.from({ length: 192 }, (_, i) => Math.max(0, Math.min(1, input.unwrapProfiles.spurTheta[i] ?? 0))),
    };
    const gapCountSolved = Math.max(0, Math.floor(input.gapCountSolved));
    const violationCount = Math.max(0, Math.floor(input.constraintViolationCount));
    const shapeSignature = Array.from({ length: 24 }, (_, i) => Math.max(0, Math.min(1, input.shapeSignature[i] ?? 0)));
    const signatureDistance = Number.isFinite(input.signatureDistanceToCanonical) ? Math.max(0, input.signatureDistanceToCanonical) : 0;
    const textureEntropy = Number.isFinite(input.textureEntropy) ? Math.max(0, input.textureEntropy) : 0;
    const radialVariance = Number.isFinite(input.radialVariance) ? Math.max(0, input.radialVariance) : 0;
    const arcSpacingVariance = Number.isFinite(input.arcSpacingVariance) ? Math.max(0, input.arcSpacingVariance) : 0;
    const repeatScore = Number.isFinite(input.repeatScore) ? Math.max(0, Math.min(1, input.repeatScore)) : 0;
    const generatedRadialProfile = Array.from({ length: 24 }, (_, i) => Math.max(0, input.generatedRadialProfile[i] ?? 0));
    const generatedAngularHistogram12 = Array.from({ length: 12 }, (_, i) => Math.max(0, input.generatedAngularHistogram12[i] ?? 0));
    const generatedGapCount = Math.max(0, Math.floor(input.generatedGapCount));
    const generatedFrayDensity = Number.isFinite(input.generatedFrayDensity) ? Math.max(0, Math.min(1, input.generatedFrayDensity)) : 0;
    const generatedStrokeWidthMean = Number.isFinite(input.generatedStrokeWidthMean) ? Math.max(0, input.generatedStrokeWidthMean) : 0;
    const generatedStrokeWidthVar = Number.isFinite(input.generatedStrokeWidthVar) ? Math.max(0, input.generatedStrokeWidthVar) : 0;
    const changed =
      this.logogramChannelCounts.ring !== next.ring ||
      this.logogramChannelCounts.tendril !== next.tendril ||
      this.logogramChannelCounts.hook !== next.hook ||
      this.maskPointCountRing !== maskPointCountRing ||
      this.maskPointCountBlob !== maskPointCountBlob ||
      this.maskPointCountTendril !== maskPointCountTendril ||
      this.maskContinuityScore !== maskContinuityScore ||
      this.maskArcOccupancy12.some((value, i) => value !== maskArcOccupancy12[i]) ||
      this.ringContinuityScore !== continuity ||
      this.sweepProgress !== sweep ||
      this.injectorBBoxArea !== area ||
      this.ringCoverageRatio !== coverage ||
      this.ringBandOccupancyRatio !== bandOccupancy ||
      this.innerVoidRatio !== voidRatio ||
      this.innerVoidPenalty !== voidPenalty ||
      this.centerMassRatio !== centerRatio ||
      this.sectorOccupancy.some((value, i) => value !== sectors[i]) ||
      this.ringSectorOccupancy.some((value, i) => value !== ringSectors[i]) ||
      this.solveEnergy !== solveEnergy ||
      this.solveBreakdown.eMask !== solveBreakdown.eMask ||
      this.solveBreakdown.eContinuity !== solveBreakdown.eContinuity ||
      this.solveBreakdown.eGap !== solveBreakdown.eGap ||
      this.solveBreakdown.eThickness !== solveBreakdown.eThickness ||
      this.solveBreakdown.eVoid !== solveBreakdown.eVoid ||
      this.solveBreakdown.eRadius !== solveBreakdown.eRadius ||
      this.solveBreakdown.eSparsity !== solveBreakdown.eSparsity ||
      this.solveBreakdown.total !== solveBreakdown.total ||
      this.unwrapProfiles.activationTheta.some((v, i) => v !== unwrapProfiles.activationTheta[i]) ||
      this.unwrapProfiles.thicknessTheta.some((v, i) => v !== unwrapProfiles.thicknessTheta[i]) ||
      this.unwrapProfiles.spurTheta.some((v, i) => v !== unwrapProfiles.spurTheta[i]) ||
      this.gapCountSolved !== gapCountSolved ||
      this.constraintViolationCount !== violationCount ||
      this.shapeSignature.some((value, i) => value !== shapeSignature[i]) ||
      this.signatureDistanceToCanonical !== signatureDistance ||
      this.textureEntropy !== textureEntropy ||
      this.radialVariance !== radialVariance ||
      this.arcSpacingVariance !== arcSpacingVariance ||
      this.repeatScore !== repeatScore ||
      this.generatedRadialProfile.some((v, i) => v !== generatedRadialProfile[i]) ||
      this.generatedAngularHistogram12.some((v, i) => v !== generatedAngularHistogram12[i]) ||
      this.generatedGapCount !== generatedGapCount ||
      this.generatedFrayDensity !== generatedFrayDensity ||
      this.generatedStrokeWidthMean !== generatedStrokeWidthMean ||
      this.generatedStrokeWidthVar !== generatedStrokeWidthVar;
    if (!changed) return;
    this.logogramChannelCounts = next;
    this.maskPointCountRing = maskPointCountRing;
    this.maskPointCountBlob = maskPointCountBlob;
    this.maskPointCountTendril = maskPointCountTendril;
    this.maskContinuityScore = maskContinuityScore;
    this.maskArcOccupancy12 = maskArcOccupancy12;
    this.ringContinuityScore = continuity;
    this.sweepProgress = sweep;
    this.injectorBBoxArea = area;
    this.ringCoverageRatio = coverage;
    this.ringBandOccupancyRatio = bandOccupancy;
    this.innerVoidRatio = voidRatio;
    this.innerVoidPenalty = voidPenalty;
    this.centerMassRatio = centerRatio;
    this.sectorOccupancy = sectors;
    this.ringSectorOccupancy = ringSectors;
    this.solveEnergy = solveEnergy;
    this.solveBreakdown = solveBreakdown;
    this.unwrapProfiles = unwrapProfiles;
    this.gapCountSolved = gapCountSolved;
    this.constraintViolationCount = violationCount;
    this.shapeSignature = shapeSignature;
    this.signatureDistanceToCanonical = signatureDistance;
    this.textureEntropy = textureEntropy;
    this.radialVariance = radialVariance;
    this.arcSpacingVariance = arcSpacingVariance;
    this.repeatScore = repeatScore;
    this.generatedRadialProfile = generatedRadialProfile;
    this.generatedAngularHistogram12 = generatedAngularHistogram12;
    this.generatedGapCount = generatedGapCount;
    this.generatedFrayDensity = generatedFrayDensity;
    this.generatedStrokeWidthMean = generatedStrokeWidthMean;
    this.generatedStrokeWidthVar = generatedStrokeWidthVar;
    this.emitView();
  }

  setBenchmarkDiagnostics(input: {
    enabled: boolean;
    mode: BenchmarkMode;
    sampleId: string | null;
    candidateSetId: string | null;
    scoreTotal: number;
    scoreStdDev: number;
    pass: boolean;
    overallPass: boolean;
    fpsWindowMin: number;
    distance: { radial: number; angular: number; gaps: number; fray: number; width: number };
    fpsGuardrailPass: boolean;
  }): void {
    const nextEnabled = !!input.enabled;
    const nextMode = input.mode;
    const nextSampleId = input.sampleId;
    const nextCandidateSetId = input.candidateSetId;
    const nextScore = Number.isFinite(input.scoreTotal) ? Math.max(0, input.scoreTotal) : 0;
    const nextScoreStdDev = Number.isFinite(input.scoreStdDev) ? Math.max(0, input.scoreStdDev) : 0;
    const nextPass = !!input.pass;
    const nextOverallPass = !!input.overallPass;
    const nextFpsWindowMin = Number.isFinite(input.fpsWindowMin) ? Math.max(0, input.fpsWindowMin) : 0;
    const nextDistance = {
      radial: Number.isFinite(input.distance.radial) ? Math.max(0, input.distance.radial) : 0,
      angular: Number.isFinite(input.distance.angular) ? Math.max(0, input.distance.angular) : 0,
      gaps: Number.isFinite(input.distance.gaps) ? Math.max(0, input.distance.gaps) : 0,
      fray: Number.isFinite(input.distance.fray) ? Math.max(0, input.distance.fray) : 0,
      width: Number.isFinite(input.distance.width) ? Math.max(0, input.distance.width) : 0,
    };
    const nextGuard = !!input.fpsGuardrailPass;
    const changed =
      this.benchmarkEnabled !== nextEnabled ||
      this.benchmarkMode !== nextMode ||
      this.benchmarkSampleId !== nextSampleId ||
      this.benchmarkCandidateSetId !== nextCandidateSetId ||
      this.benchmarkScoreTotal !== nextScore ||
      this.benchmarkScoreStdDev !== nextScoreStdDev ||
      this.benchmarkPass !== nextPass ||
      this.benchmarkOverallPass !== nextOverallPass ||
      this.benchmarkFpsWindowMin !== nextFpsWindowMin ||
      this.fpsGuardrailPass !== nextGuard ||
      this.benchmarkDistanceBreakdown.radial !== nextDistance.radial ||
      this.benchmarkDistanceBreakdown.angular !== nextDistance.angular ||
      this.benchmarkDistanceBreakdown.gaps !== nextDistance.gaps ||
      this.benchmarkDistanceBreakdown.fray !== nextDistance.fray ||
      this.benchmarkDistanceBreakdown.width !== nextDistance.width;
    if (!changed) return;
    this.benchmarkEnabled = nextEnabled;
    this.benchmarkMode = nextMode;
    this.benchmarkSampleId = nextSampleId;
    this.benchmarkCandidateSetId = nextCandidateSetId;
    this.benchmarkScoreTotal = nextScore;
    this.benchmarkScoreStdDev = nextScoreStdDev;
    this.benchmarkPass = nextPass;
    this.benchmarkOverallPass = nextOverallPass;
    this.benchmarkFpsWindowMin = nextFpsWindowMin;
    this.benchmarkDistanceBreakdown = nextDistance;
    this.fpsGuardrailPass = nextGuard;
    this.emitView();
  }

  getAtoms(): Atom[] {
    return [...this.atomMap.values()];
  }

  getAtomById(id: string | null): Atom | null {
    if (!id) return null;
    return this.atomMap.get(id) ?? null;
  }

  getSelectedAtom(): Atom | null {
    return this.getAtomById(this.selectedId);
  }

  getHoveredAtom(): Atom | null {
    return this.getAtomById(this.hoveredId);
  }

  getActiveMessageState(): ActiveMessageState {
    return {
      activeMessageAtomId: this.activeMessageAtomId,
      activeMessagePrevAtomId: this.activeMessagePrevAtomId,
      activeMessageBlend: this.activeMessageBlend,
      activeMessageUpdatedAt: this.activeMessageUpdatedAt,
      activeMessageMatchSource: this.activeMessageMatchSource,
      activeMessageMatchedPhrase: this.activeMessageMatchedPhrase,
      activeMessageCanonicalKey: this.activeMessageCanonicalKey,
    };
  }

  setActiveMessageMatchMeta(source: "dictionary" | "unknown" | "none", matchedPhrase: string | null, canonicalKey: string | null): void {
    if (this.activeMessageMatchSource === source && this.activeMessageMatchedPhrase === matchedPhrase && this.activeMessageCanonicalKey === canonicalKey) return;
    this.activeMessageMatchSource = source;
    this.activeMessageMatchedPhrase = matchedPhrase;
    this.activeMessageCanonicalKey = canonicalKey;
    this.emitView();
  }

  setPromptLatencyMs(value: number | null): void {
    const next = value === null ? null : Math.max(0, Math.floor(value));
    if (this.promptLatencyMs === next) return;
    this.promptLatencyMs = next;
    this.emitView();
  }

  setLumaMetrics(input: { inkFieldMean: number; inkFieldMax: number; brightPixelRatio: number; lumaHistogram: number[] }): void {
    const nextMean = Number.isFinite(input.inkFieldMean) ? Math.max(0, Math.min(1, input.inkFieldMean)) : 0;
    const nextMax = Number.isFinite(input.inkFieldMax) ? Math.max(0, Math.min(1, input.inkFieldMax)) : 0;
    const nextBright = Number.isFinite(input.brightPixelRatio) ? Math.max(0, Math.min(1, input.brightPixelRatio)) : 0;
    const nextHist = Array.from({ length: 8 }, (_, i) => Math.max(0, input.lumaHistogram[i] ?? 0));
    const changed =
      this.inkFieldMean !== nextMean ||
      this.inkFieldMax !== nextMax ||
      this.brightPixelRatio !== nextBright ||
      this.lumaHistogram.some((v, i) => v !== nextHist[i]);
    if (!changed) return;
    this.inkFieldMean = nextMean;
    this.inkFieldMax = nextMax;
    this.brightPixelRatio = nextBright;
    this.lumaHistogram = nextHist;
    this.emitView();
  }

  setLumaMetricsActual(input: { frameLumaMeanActual: number; frameLumaMaxActual: number; brightPixelRatioActual: number; frameLumaHistogramActual: number[] }): void {
    const nextMean = Number.isFinite(input.frameLumaMeanActual) ? Math.max(0, Math.min(1, input.frameLumaMeanActual)) : 0;
    const nextMax = Number.isFinite(input.frameLumaMaxActual) ? Math.max(0, Math.min(1, input.frameLumaMaxActual)) : 0;
    const nextBright = Number.isFinite(input.brightPixelRatioActual) ? Math.max(0, Math.min(1, input.brightPixelRatioActual)) : 0;
    const nextHist = Array.from({ length: 8 }, (_, i) => Math.max(0, input.frameLumaHistogramActual[i] ?? 0));
    const changed =
      this.frameLumaMeanActual !== nextMean ||
      this.frameLumaMaxActual !== nextMax ||
      this.brightPixelRatioActual !== nextBright ||
      this.frameLumaHistogramActual.some((v, i) => v !== nextHist[i]);
    if (!changed) return;
    this.frameLumaMeanActual = nextMean;
    this.frameLumaMaxActual = nextMax;
    this.brightPixelRatioActual = nextBright;
    this.frameLumaHistogramActual = nextHist;
    this.emitView();
  }

  setShowLumaHistogram(next: boolean): void {
    if (this.showLumaHistogram === next) return;
    this.showLumaHistogram = next;
    this.emitView();
  }

  activateIncomingMessage(atomId: string | null, nowMs: number): ActiveMessageState {
    if (!atomId || !this.atomMap.has(atomId)) {
      this.activeMessagePrevAtomId = this.activeMessageAtomId;
      this.activeMessageAtomId = null;
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = nowMs;
      this.activeMessageMatchSource = "none";
      this.activeMessageMatchedPhrase = null;
      this.activeMessageCanonicalKey = null;
      return this.getActiveMessageState();
    }
    if (atomId !== this.activeMessageAtomId) {
      this.activeMessagePrevAtomId = this.activeMessageAtomId;
      this.activeMessageAtomId = atomId;
      this.activeMessageStartAt = nowMs;
      this.activeMessageBlend = this.activeMessagePrevAtomId ? 0 : 1;
      this.activeMessageUpdatedAt = nowMs;
    }
    return this.getActiveMessageState();
  }

  syncActiveMessageBlend(nowMs: number): ActiveMessageState {
    if (this.activeMessagePrevAtomId && !this.atomMap.has(this.activeMessagePrevAtomId)) {
      this.activeMessagePrevAtomId = null;
    }
    if (this.activeMessageAtomId && !this.atomMap.has(this.activeMessageAtomId)) {
      this.activeMessageAtomId = this.pickNewestMessageAtomId();
      this.activeMessagePrevAtomId = null;
      this.activeMessageBlend = 1;
      if (!this.activeMessageAtomId) {
        this.activeMessageMatchSource = "none";
        this.activeMessageMatchedPhrase = null;
        this.activeMessageCanonicalKey = null;
      }
    }
    if (!this.activeMessageAtomId) {
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = nowMs;
      return this.getActiveMessageState();
    }
    if (this.activeMessagePrevAtomId) {
      const t = clamp01((nowMs - this.activeMessageStartAt) / this.activeMessageDurationMs);
      this.activeMessageBlend = t;
      if (t >= 1) this.activeMessagePrevAtomId = null;
    } else {
      this.activeMessageBlend = 1;
    }
    this.activeMessageUpdatedAt = nowMs;
    return this.getActiveMessageState();
  }

  initializeActiveMessageFromData(nowMs: number): void {
    const newest = this.pickNewestMessageAtomId();
    this.activeMessageAtomId = newest;
    this.activeMessagePrevAtomId = null;
    this.activeMessageBlend = 1;
    this.activeMessageUpdatedAt = nowMs;
    this.activeMessageCanonicalKey = null;
  }

  setHover(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.emitView();
  }

  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  setQuery(query: string): void {
    this.filters = { ...this.filters, query: query.trim().toLowerCase() };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  toggleType(type: AtomType): void {
    const types = new Set(this.filters.types);
    if (types.has(type)) types.delete(type);
    else types.add(type);
    if (types.size === 0) types.add(type);
    this.filters = { ...this.filters, types };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  toggleState(state: AtomState): void {
    const states = new Set(this.filters.states);
    if (states.has(state)) states.delete(state);
    else states.add(state);
    if (states.size === 0) states.add(state);
    this.filters = { ...this.filters, states };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  setOverlayMinimized(next: boolean): void {
    if (this.overlayMinimized === next) return;
    this.overlayMinimized = next;
    this.emitView();
  }

  setInspectorOpen(next: boolean): void {
    if (this.inspectorOpen === next) return;
    this.inspectorOpen = next;
    this.emitView();
  }

  setQualityTierOverride(next: QualityTierOverride): void {
    if (this.qualityTierOverride === next) return;
    this.qualityTierOverride = next;
    this.emitView();
  }

  setShowDiagnostics(next: boolean): void {
    if (this.showDiagnostics === next) return;
    this.showDiagnostics = next;
    this.emitView();
  }

  upsertMany(
    input: Array<
      Omit<
        Atom,
        | "stableKey"
        | "score"
        | "sizeTier"
        | "targetX"
        | "targetY"
        | "targetZ"
        | "x"
        | "y"
        | "z"
        | "renderSize"
        | "treeDepth"
        | "treeRole"
        | "growthPhase"
        | "parentId"
        | "descendantCount"
      >
    >,
  ): void {
    const now = Date.now();
    for (const item of input) {
      const existing = this.atomMap.get(item.id);
      const enriched = enrichAtom(
        {
          ...item,
          x: existing?.x,
          y: existing?.y,
          z: existing?.z,
          targetX: existing?.targetX,
          targetY: existing?.targetY,
          targetZ: existing?.targetZ,
          treeDepth: existing?.treeDepth,
          treeRole: existing?.treeRole,
          growthPhase: existing?.growthPhase,
          parentId: existing?.parentId,
          descendantCount: existing?.descendantCount,
          ...(existing?.renderSize !== undefined ? { renderSize: existing.renderSize } : {}),
        },
        now,
      );
      this.atomMap.set(item.id, enriched);
    }
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  upsertAndActivateMessage(
    atom: Omit<
      Atom,
      | "stableKey"
      | "score"
      | "sizeTier"
      | "targetX"
      | "targetY"
      | "targetZ"
      | "x"
      | "y"
      | "z"
      | "renderSize"
      | "treeDepth"
      | "treeRole"
      | "growthPhase"
      | "parentId"
      | "descendantCount"
    >,
    nowMs: number,
  ): void {
    this.upsertMany([atom]);
    this.activateIncomingMessage(atom.id, nowMs);
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  patchOne(patch: AtomPatch): void {
    const existing = this.atomMap.get(patch.id);
    if (!existing) return;
    const merged = { ...existing, ...patch };
    const enriched = enrichAtom(merged, Date.now());
    this.atomMap.set(patch.id, enriched);
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  removeOne(id: string): void {
    if (!this.atomMap.has(id)) return;
    this.atomMap.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoveredId === id) this.hoveredId = null;
    if (this.activeMessageAtomId === id) {
      this.activeMessageAtomId = this.pickNewestMessageAtomId();
      this.activeMessagePrevAtomId = null;
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = Date.now();
    }
    if (this.activeMessagePrevAtomId === id) this.activeMessagePrevAtomId = null;
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  clear(): void {
    if (this.atomMap.size === 0 && this.selectedId === null && this.hoveredId === null) return;
    this.atomMap.clear();
    this.selectedId = null;
    this.hoveredId = null;
    this.activeMessageAtomId = null;
    this.activeMessagePrevAtomId = null;
    this.activeMessageBlend = 1;
    this.activeMessageUpdatedAt = Date.now();
    this.activeMessageMatchSource = "none";
    this.activeMessageMatchedPhrase = null;
    this.activeMessageCanonicalKey = null;
    this.taskPointCount = 0;
    this.promptLatencyMs = null;
    this.inkFieldMean = 0;
    this.inkFieldMax = 0;
    this.brightPixelRatio = 0;
    this.lumaHistogram = [0, 0, 0, 0, 0, 0, 0, 0];
    this.frameLumaMeanActual = 0;
    this.frameLumaMaxActual = 0;
    this.brightPixelRatioActual = 0;
    this.frameLumaHistogramActual = [0, 0, 0, 0, 0, 0, 0, 0];
    this.logogramChannelCounts = { ring: 0, tendril: 0, hook: 0 };
    this.maskPointCountRing = 0;
    this.maskPointCountBlob = 0;
    this.maskPointCountTendril = 0;
    this.maskContinuityScore = 0;
    this.maskArcOccupancy12 = Array.from({ length: 12 }, () => 0);
    this.ringContinuityScore = 0;
    this.sweepProgress = 0;
    this.injectorBBoxArea = 0;
    this.ringCoverageRatio = 0;
    this.ringBandOccupancyRatio = 0;
    this.innerVoidRatio = 1;
    this.innerVoidPenalty = 0;
    this.centerMassRatio = 0;
    this.sectorOccupancy = Array.from({ length: 12 }, () => 0);
    this.ringSectorOccupancy = Array.from({ length: 12 }, () => 0);
    this.solveEnergy = 0;
    this.solveBreakdown = { eMask: 0, eContinuity: 0, eGap: 0, eThickness: 0, eVoid: 0, eRadius: 0, eSparsity: 0, total: 0 };
    this.unwrapProfiles = { activationTheta: Array.from({ length: 192 }, () => 0), thicknessTheta: Array.from({ length: 192 }, () => 0), spurTheta: Array.from({ length: 192 }, () => 0) };
    this.gapCountSolved = 0;
    this.constraintViolationCount = 0;
    this.shapeSignature = Array.from({ length: 24 }, () => 0);
    this.signatureDistanceToCanonical = 0;
    this.textureEntropy = 0;
    this.radialVariance = 0;
    this.arcSpacingVariance = 0;
    this.repeatScore = 0;
    this.generatedRadialProfile = Array.from({ length: 24 }, () => 0);
    this.generatedAngularHistogram12 = Array.from({ length: 12 }, () => 0);
    this.generatedGapCount = 0;
    this.generatedFrayDensity = 0;
    this.generatedStrokeWidthMean = 0;
    this.generatedStrokeWidthVar = 0;
    this.benchmarkEnabled = false;
    this.benchmarkMode = "disabled_by_plan";
    this.benchmarkSampleId = null;
    this.benchmarkCandidateSetId = null;
    this.benchmarkScoreTotal = 0;
    this.benchmarkScoreStdDev = 0;
    this.benchmarkPass = false;
    this.benchmarkOverallPass = false;
    this.benchmarkFpsWindowMin = 0;
    this.benchmarkDistanceBreakdown = { radial: 0, angular: 0, gaps: 0, fray: 0, width: 0 };
    this.fpsGuardrailPass = true;
    this.visibleAtomsCache = [];
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  getTimelineBuckets(now: number, mode: TimelineSortMode): TimelineBucket[] {
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const visible = [...this.getVisibleAtoms()];
    const sorted = visible.sort((a, b) => {
      if (mode === "importance") {
        if (b.importance !== a.importance) return b.importance - a.importance;
        if (b.score !== a.score) return b.score - a.score;
        return b.ts - a.ts;
      }
      if (mode === "due") {
        const aDue = a.due ?? Number.POSITIVE_INFINITY;
        const bDue = b.due ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return b.ts - a.ts;
      }
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.stableKey - b.stableKey;
    });

    const buckets = new Map<string, TimelineBucket>([
      ["today", { key: "today", label: "Today", items: [] }],
      ["yesterday", { key: "yesterday", label: "Yesterday", items: [] }],
      ["last7", { key: "last7", label: "Last 7 Days", items: [] }],
      ["last30", { key: "last30", label: "Last 30 Days", items: [] }],
      ["older", { key: "older", label: "Older", items: [] }],
    ]);

    for (const atom of sorted) {
      const age = todayMs - atom.ts;
      const key =
        age < dayMs ? "today" : age < 2 * dayMs ? "yesterday" : age < 7 * dayMs ? "last7" : age < 30 * dayMs ? "last30" : "older";
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(atom);
    }

    return [...buckets.values()].filter((bucket) => bucket.items.length > 0);
  }

  setSelectedByIndex(bucketKey: string, itemIndex: number): void {
    const buckets = this.getTimelineBuckets(Date.now(), "recent");
    const bucket = buckets.find((entry) => entry.key === bucketKey);
    if (!bucket) return;
    const next = bucket.items[itemIndex];
    this.setSelected(next?.id ?? null);
  }

  getVisibleAtoms(): Atom[] {
    if (!this.visibleDirty) return this.visibleAtomsCache;
    const query = this.filters.query;
    this.visibleAtomsCache = [...this.atomMap.values()].filter((atom) => {
      if (!this.filters.types.has(atom.type)) return false;
      if (!this.filters.states.has(atom.state)) return false;
      if (!query) return true;
      const title = atom.title?.toLowerCase() ?? "";
      const preview = atom.preview?.toLowerCase() ?? "";
      return title.includes(query) || preview.includes(query) || atom.id.includes(query);
    });
    this.visibleDirty = false;
    return this.visibleAtomsCache;
  }

  recalcLayout(viewportWorldWidth: number, viewportWorldHeight: number, baseSize: number): void {
    const visible = this.getVisibleAtoms();
    if (visible.length === 0) {
      this.layoutDirty = false;
      this.emitView();
      return;
    }
    assignSmokeTargets(visible, viewportWorldWidth, viewportWorldHeight, baseSize);
    this.layoutDirty = false;
    this.emitView();
  }

  tickPositions(dtSec: number): void {
    easePosition(this.getVisibleAtoms(), dtSec);
  }

  needsLayout(): boolean {
    return this.layoutDirty;
  }

  markLayoutDirty(): void {
    this.layoutDirty = true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    this.emitView();
  }

  private emitView(): void {
    this.viewVersion += 1;
    for (const listener of this.viewListeners) listener();
  }

  private pickNewestMessageAtomId(): string | null {
    let best: Atom | null = null;
    for (const atom of this.atomMap.values()) {
      if (atom.type !== "message") continue;
      if (!best || atom.ts > best.ts || (atom.ts === best.ts && atom.stableKey < best.stableKey)) best = atom;
    }
    return best?.id ?? null;
  }
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function randomChoice<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function randomId(): string {
  return crypto.randomUUID();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildSeededDemoAtoms(
  count = 10000,
  seed = 1337,
): Array<
  Omit<
    Atom,
    | "stableKey"
    | "score"
    | "sizeTier"
    | "targetX"
    | "targetY"
    | "targetZ"
    | "x"
    | "y"
    | "z"
    | "renderSize"
    | "treeDepth"
    | "treeRole"
    | "growthPhase"
    | "parentId"
    | "descendantCount"
  >
> {
  let t = seed >>> 0;
  const rand = () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const ts = now - Math.floor(rand() * 120 * DAY_MS);
    const dueChance = rand();
    const due = dueChance > 0.26 ? ts + Math.floor((rand() * 18 - 4) * DAY_MS) : undefined;
    const urgency = Math.max(0, Math.min(1, 0.25 + rand() * 0.75 + (due && due < now ? 0.2 : 0)));
    const importance = Math.max(0, Math.min(1, 0.2 + rand() * 0.8));
    const state: AtomState = due && due < now ? (rand() < 0.7 ? "active" : "done") : rand() < 0.15 ? "new" : rand() < 0.72 ? "active" : "snoozed";
    const type = randomChoice(ATOM_TYPES);
    const payload = type === "message" ? { message: `message payload ${i + 1}` } : { index: i, source: "demo-seed" };
    return {
      id: randomId(),
      type,
      state,
      ts,
      due,
      urgency,
      importance,
      title: `${type.toUpperCase()} signal ${i + 1}`,
      preview: `Synthetic record ${i + 1} for smoke-field testing.`,
      payload,
      labels: urgency > 0.8 ? ["high_attention"] : ["ambient"],
      visibility: "masked",
      sensitivity: type === "email" || type === "message" ? "high" : type === "file" ? "medium" : "low",
    };
  });
}
