import {
  FrameRegistrationSchema,
  MultiPointTrackSchema,
  QualityThresholdsSchema,
  ReportOptionsSchema,
  type FrameRegistration,
  type MultiPointTrack,
  type PointSeed,
  type QualityGrade,
  type QualityThresholds,
  type ReportMetadata,
  type ReportModel,
  type ReportOptions,
  type ReportResidualSemantics,
  type RecoveryEvent,
  type RiskNotice,
  type ProcessingStats
} from "@subpixel/contracts";

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  passValidRatio: .95,
  reviewValidRatio: .8,
  passConfidenceP50: .8,
  reviewConfidenceP50: .55,
  failLostRatio: .2,
  reviewDroppedFrameRatio: .1
};

export type ReportSnapshot = {
  seeds: PointSeed[];
  tracksByPoint: Map<string, MultiPointTrack[]>;
  registrations: FrameRegistration[];
  recoveryEvents: RecoveryEvent[];
  riskNotices: RiskNotice[];
  processingStats: ProcessingStats;
  activePointIds?: string[];
};

export type ReportTrack = ReportModel["tracks"][number];
export type ResidualSemantics = ReportResidualSemantics;
export type ReportPoint = ReportModel["points"][number];
export type ReportModelResult = ReportModel;

const STATE_ORDER = ["valid", "suspect", "lost", "reviewed", "paused"] as const;
const WORST_STATE_RANK: Record<MultiPointTrack["state"], number> = { valid: 0, reviewed: 1, suspect: 2, paused: 3, lost: 4 };

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return rounded(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function rounded(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function range(values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  return values.reduce((result, value) => ({ min: Math.min(result.min, value), max: Math.max(result.max, value) }), { min: values[0], max: values[0] });
}

export function reportResidualSemantics(model: MultiPointTrack["model"]): ResidualSemantics {
  if (model === "circle") return "geometric-fit-error-px";
  if (model === "blob") return "blob-center-fit-error-px";
  if (model === "crosshair" || model === "diagonal") return "line-intersection-fit-error-px";
  return "matching-error-model-specific";
}

function normalizeStateCounts(values: MultiPointTrack["state"][]): Record<"valid" | "suspect" | "lost" | "reviewed" | "paused", number> {
  const result = Object.fromEntries(STATE_ORDER.map(state => [state, 0])) as Record<typeof STATE_ORDER[number], number>;
  for (const state of values) result[state]++;
  return result;
}

function validateThresholds(overrides?: Partial<QualityThresholds>): QualityThresholds {
  return QualityThresholdsSchema.parse({ ...DEFAULT_QUALITY_THRESHOLDS, ...(overrides ?? {}) });
}

function sampleChartRows(rows: ReportTrack[], limit = 1000) {
  const firstValid = rows.find(row => row.state === "valid");
  const toSample = (row: ReportTrack) => ({ pointId: row.pointId, frame: row.frame, x: row.refined.x, y: row.refined.y, dx: firstValid ? row.refined.x - firstValid.refined.x : null, dy: firstValid ? row.refined.y - firstValid.refined.y : null, confidence: row.confidence, residual: row.residual });
  if (rows.length <= limit) return rows.map(toSample);
  const required = new Set<number>([0, rows.length - 1]);
  const accessors = [(row: ReportTrack) => row.refined.x, (row: ReportTrack) => row.refined.y, (row: ReportTrack) => row.confidence, (row: ReportTrack) => row.residual];
  const bucketCount = Math.max(1, Math.floor((limit - 2) / (accessors.length * 2)));
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = 1 + Math.floor(bucket * (rows.length - 2) / bucketCount);
    const end = 1 + Math.floor((bucket + 1) * (rows.length - 2) / bucketCount);
    for (const value of accessors) {
      let min = start; let max = start;
      for (let index = start + 1; index < end; index++) {
        if (value(rows[index]) < value(rows[min])) min = index;
        if (value(rows[index]) > value(rows[max])) max = index;
      }
      required.add(min); required.add(max);
    }
  }
  for (let i = 0; required.size < limit && i < limit * 2; i++) required.add(Math.round(i * (rows.length - 1) / (limit * 2 - 1)));
  return [...required].sort((a, b) => a - b).slice(0, limit).map(index => toSample(rows[index]));
}

function keyFramesFor(rows: ReportTrack[], requested: number): ReportModelResult["keyFrames"] {
  if (!rows.length || requested <= 0) return [];
  const abnormal = rows.filter(row => row.state !== "valid");
  const boundaryIndexes = new Set<number>();
  for (const row of abnormal) {
    const index = rows.indexOf(row);
    if (index === 0 || rows[index - 1].state === "valid") boundaryIndexes.add(index);
    if (index === rows.length - 1 || rows[index + 1].state === "valid") boundaryIndexes.add(index);
  }
  const boundaryList = [...boundaryIndexes].sort((a, b) => a - b);
  const selected = new Set<number>(boundaryList.length > requested
    ? Array.from({ length: requested }, (_, index) => boundaryList[Math.round(index * (boundaryList.length - 1) / Math.max(1, requested - 1))])
    : boundaryList);
  if (selected.size < requested) {
    for (let i = 0; selected.size < requested && i < rows.length; i++) selected.add(Math.round(i * (rows.length - 1) / Math.max(1, requested - 1)));
  }
  return [...selected].sort((a, b) => a - b).slice(0, requested).map(index => ({
    pointId: rows[index].pointId,
    frame: rows[index].frame,
    reason: rows[index].state === "valid" ? "regular" : "abnormal-boundary",
    track: rows[index]
  }));
}

function pointGrade(point: ReportPoint, thresholds: QualityThresholds): QualityGrade {
  if (!point.sampleCount) return "not-evaluated";
  const allStates = point.stateCounts;
  if (point.finalState === "lost" || point.finalState === "paused" || point.validRatio < thresholds.reviewValidRatio || point.lostRatio >= thresholds.failLostRatio || (point.confidence.p50 ?? 0) < thresholds.reviewConfidenceP50) return "fail";
  if (point.validRatio < thresholds.passValidRatio || (point.confidence.p50 ?? 0) < thresholds.passConfidenceP50 || allStates.suspect > 0 || allStates.reviewed > 0 || allStates.paused > 0) return "review";
  return "pass";
}

function overallGrade(input: { points: ReportPoint[]; tracks: ReportTrack[]; thresholds: QualityThresholds; processing: ProcessingStats; recoveryCount: number; rejectedRegistrations: number; errorRisk: boolean }): QualityGrade {
  if (!input.tracks.length) return "not-evaluated";
  const valid = input.tracks.filter(track => track.state === "valid").length;
  const lost = input.tracks.filter(track => track.state === "lost" || track.state === "paused").length;
  const validRatio = valid / input.tracks.length;
  const lostRatio = lost / input.tracks.length;
  const finalByPoint = input.points.some(point => {
    const pointRows = input.tracks.filter(track => track.pointId === point.pointId);
    return pointRows.at(-1)?.state === "lost" || pointRows.at(-1)?.state === "paused";
  });
  if (validRatio < input.thresholds.reviewValidRatio || lostRatio >= input.thresholds.failLostRatio || finalByPoint) return "fail";
  const confidence = percentile(input.tracks.map(track => track.confidence), .5) ?? 0;
  if (confidence < input.thresholds.reviewConfidenceP50) return "fail";
  if (validRatio < input.thresholds.passValidRatio || confidence < input.thresholds.passConfidenceP50 || input.points.some(point => point.grade === "review") || input.recoveryCount > 0 || input.rejectedRegistrations > 0 || input.errorRisk || (input.processing.droppedFrames / Math.max(1, input.processing.processedFrames + input.processing.droppedFrames)) >= input.thresholds.reviewDroppedFrameRatio) return "review";
  return "pass";
}

export function buildReportModel(snapshot: ReportSnapshot, metadata: ReportMetadata, thresholdOverrides?: Partial<QualityThresholds>, optionOverrides?: Partial<ReportOptions>): ReportModelResult {
  const thresholds = validateThresholds(thresholdOverrides);
  const options = ReportOptionsSchema.parse(optionOverrides ?? {});
  const pointIds = [...new Set([...(snapshot.activePointIds ?? snapshot.seeds.map(seed => seed.pointId)), ...snapshot.tracksByPoint.keys()])].sort((a, b) => a.localeCompare(b));
  const seedById = new Map(snapshot.seeds.map(seed => [seed.pointId, seed]));
  const rawTracks = [...snapshot.tracksByPoint.values()].flat().map(track => MultiPointTrackSchema.parse(track) as MultiPointTrack).sort((a, b) => a.pointId.localeCompare(b.pointId) || a.frame - b.frame);
  const tracks = rawTracks.map(track => ({ ...track, residualSemantics: reportResidualSemantics(track.model) }));
  const pointReports: ReportPoint[] = pointIds.map(pointId => {
    const rows = tracks.filter(track => track.pointId === pointId);
    const validRows = rows.filter(row => row.state === "valid");
    const states = normalizeStateCounts(rows.map(row => row.state));
    const xValues = validRows.map(row => row.refined.x);
    const yValues = validRows.map(row => row.refined.y);
    const first = validRows[0];
    const last = validRows.at(-1);
    const gates = counts(snapshot.riskNotices.filter(notice => notice.pointId === pointId && (notice.code.includes("gate") || notice.code.includes("identity"))).map(notice => notice.code));
    return {
      pointId,
      model: seedById.get(pointId)?.model ?? rows[0]?.model ?? null,
      grade: "not-evaluated",
      finalState: rows.at(-1)?.state ?? null,
      sampleCount: rows.length,
      stateCounts: states,
      validRatio: rows.length ? states.valid / rows.length : 0,
      lostRatio: rows.length ? (states.lost + states.paused) / rows.length : 0,
      start: first ? { ...first.refined } : null,
      end: last ? { ...last.refined } : null,
      dx: first && last ? last.refined.x - first.refined.x : null,
      dy: first && last ? last.refined.y - first.refined.y : null,
      xRange: range(xValues),
      yRange: range(yValues),
      confidence: { p50: percentile(rows.map(row => row.confidence), .5), p95: percentile(rows.map(row => row.confidence), .95) },
      gatingFailures: Object.fromEntries(Object.entries(gates).sort(([a], [b]) => a.localeCompare(b))),
      relocationMethods: Object.fromEntries(Object.entries(counts(rows.map(row => row.relocationMethod))).sort(([a], [b]) => a.localeCompare(b)))
    };
  });
  for (const point of pointReports) point.grade = pointGrade(point, thresholds);
  const frameSet = new Set(rawTracks.map(track => track.frame));
  const stateCounts = normalizeStateCounts(rawTracks.map(track => track.state));
  const processing = snapshot.processingStats;
  const droppedFrameRatio = processing.droppedFrames / Math.max(1, processing.processedFrames + processing.droppedFrames);
  const registrations = snapshot.registrations.map(registration => FrameRegistrationSchema.parse(registration));
  const inlierRatios = registrations.map(registration => registration.inlierRatio);
  const reprojections = registrations.map(registration => registration.medianReprojectionError);
  const registration = {
    count: registrations.length,
    acceptedCount: registrations.filter(registration => registration.accepted === true).length,
    rejectedCount: registrations.filter(registration => registration.accepted === false).length,
    successRate: registrations.length ? registrations.filter(registration => registration.accepted === true).length / registrations.length : 0,
    meanInlierRatio: inlierRatios.length ? rounded(inlierRatios.reduce((sum, value) => sum + value, 0) / inlierRatios.length) : null,
    medianInlierRatio: percentile(inlierRatios, .5),
    meanReprojectionError: reprojections.length ? rounded(reprojections.reduce((sum, value) => sum + value, 0) / reprojections.length) : null,
    p95ReprojectionError: percentile(reprojections, .95),
    methodDistribution: Object.fromEntries(Object.entries(counts(registrations.map(registration => registration.method))).sort(([a], [b]) => a.localeCompare(b)))
  };
  const intervals: ReportModelResult["anomalyIntervals"] = [];
  for (const pointId of pointIds) {
    const rows = tracks.filter(track => track.pointId === pointId);
    let current: ReportTrack[] = [];
    const flush = () => {
      if (!current.length) return;
      const worst = current.reduce((left, right) => WORST_STATE_RANK[right.state] > WORST_STATE_RANK[left.state] ? right : left);
      const metrics = current.reduce((result, row) => ({ minimumConfidence: Math.min(result.minimumConfidence, row.confidence), maximumResidual: Math.max(result.maximumResidual, row.residual) }), { minimumConfidence: current[0].confidence, maximumResidual: current[0].residual });
      intervals.push({ pointId, startFrame: current[0].frame, endFrame: current.at(-1)!.frame, frameCount: current.length, worstState: worst.state, ...metrics });
      current = [];
    };
    for (const row of rows) {
      if (row.state === "valid") flush();
      else if (current.length && row.frame !== current.at(-1)!.frame + 1) { flush(); current = [row]; }
      else current.push(row);
    }
    flush();
  }
  const risks = [...snapshot.riskNotices].sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
  const humanInterventions: Array<Record<string, unknown>> = [
    ...snapshot.recoveryEvents.map(event => ({ ...event, kind: "recovery", interventionKind: event.kind })),
    ...tracks.filter(track => track.relocationMethod === "manual").map(track => ({ kind: "manual-relocation", pointId: track.pointId, frame: track.frame }))
  ];
  const chartSeries = pointIds.map(pointId => ({ pointId, samples: sampleChartRows(tracks.filter(track => track.pointId === pointId)) }));
  const keyFrames = pointIds.flatMap(pointId => keyFramesFor(tracks.filter(track => track.pointId === pointId), options.keyFrameCount)).sort((a, b) => a.pointId.localeCompare(b.pointId) || a.frame - b.frame);
  const grade = overallGrade({ points: pointReports, tracks, thresholds, processing, recoveryCount: snapshot.recoveryEvents.length, rejectedRegistrations: registration.rejectedCount, errorRisk: risks.some(risk => risk.severity === "error") });
  return {
    metadata, thresholds, options, grade,
    execution: { pointCount: pointIds.length, frameCount: frameSet.size, sampleCount: tracks.length, stateCounts, validRatio: tracks.length ? stateCounts.valid / tracks.length : 0, lostRatio: tracks.length ? (stateCounts.lost + stateCounts.paused) / tracks.length : 0, droppedFrameRatio, processingStats: processing },
    points: pointReports, tracks, chartSeries, registration, anomalyIntervals: intervals, risks, humanInterventions, keyFrames
  };
}
