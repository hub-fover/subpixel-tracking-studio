import { describe, expect, it } from "vitest";
import type { MultiPointTrack, PointSeed, ReportMetadata } from "@subpixel/contracts";

import { DEFAULT_QUALITY_THRESHOLDS, buildReportModel, type ReportSnapshot } from "./reportModel";

const metadata: ReportMetadata = {
  reportNumber: "R-001", reportId: "report-1", projectName: "Bridge", testId: "T-1",
  operator: "Li", notes: "", sourceFile: "test.mp4",
  generatedAt: "2026-08-02T08:00:00.000Z", buildCommit: "79cf4cb"
};

function seed(pointId: string, model: PointSeed["model"] = "circle"): PointSeed {
  return {
    pointId, click: { x: 0, y: 0 }, snapped: { x: 0, y: 0 },
    roi: { x: 0, y: 0, width: 20, height: 20 }, groupId: "default",
    candidateScore: .9, model
  };
}

function track(pointId: string, frame: number, overrides: Partial<MultiPointTrack> = {}): MultiPointTrack {
  return {
    pointId, frame, timestampMs: frame * 10,
    predicted: { x: frame, y: frame }, refined: { x: frame, y: frame },
    model: "circle", confidence: .9, residual: .1,
    flowErrorForwardBackward: null, ncc: null, descriptorDistance: null, epipolarError: null,
    predictionSource: "previous-position", innovationPx: 0, localAffineResidualPx: null,
    gateFailures: [], candidateUniqueness: null,
    state: "valid", relocationMethod: "feature-refine", ...overrides
  };
}

function snapshot(seeds: PointSeed[], tracks: MultiPointTrack[] = []): ReportSnapshot {
  const tracksByPoint = new Map<string, MultiPointTrack[]>();
  for (const item of tracks) tracksByPoint.set(item.pointId, [...(tracksByPoint.get(item.pointId) ?? []), item]);
  return {
    seeds, activePointIds: seeds.map(item => item.pointId), tracksByPoint,
    registrations: [], recoveryEvents: [], riskNotices: [],
    processingStats: { processedFrames: 0, droppedFrames: 0, fps: 0, p95LatencyMs: 0, engine: "typescript", nativeWidth: null, nativeHeight: null }
  };
}

describe("report model", () => {
  it("exports deterministic report aggregation entry points", async () => {
    const module = await import("./reportModel");
    expect(module.DEFAULT_QUALITY_THRESHOLDS).toBeDefined();
    expect(module.buildReportModel).toBeTypeOf("function");
  });

  it("computes percentiles, displacement, state distributions, and model-specific residual semantics", () => {
    const input = snapshot([seed("p-b", "natural-keypoint"), seed("p-a")], [
      track("p-b", 2, { model: "natural-keypoint", residual: .3 }),
      track("p-a", 3, { refined: { x: 13, y: 18 }, confidence: 1 }),
      track("p-a", 1, { refined: { x: 10, y: 20 }, confidence: .6 }),
      track("p-a", 2, { refined: { x: 12, y: 19 }, confidence: .8 })
    ]);

    const report = buildReportModel(input, metadata);
    const point = report.points[0];

    expect(report.points.map(item => item.pointId)).toEqual(["p-a", "p-b"]);
    expect(report.tracks.map(item => `${item.pointId}:${item.frame}`)).toEqual(["p-a:1", "p-a:2", "p-a:3", "p-b:2"]);
    expect(point).toMatchObject({
      pointId: "p-a", sampleCount: 3, start: { x: 10, y: 20 }, end: { x: 13, y: 18 },
      dx: 3, dy: -2, xRange: { min: 10, max: 13 }, yRange: { min: 18, max: 20 },
      confidence: { p50: .8, p95: .98 }, stateCounts: { valid: 3, suspect: 0, lost: 0, reviewed: 0, paused: 0 },
      relocationMethods: { "feature-refine": 3 }
    });
    expect(report.tracks[0].residualSemantics).toBe("geometric-fit-error-px");
    expect(report.tracks[3]).toMatchObject({ residual: .3, residualSemantics: "matching-error-model-specific" });
    expect(report.chartSeries[0].samples.map(item => [item.dx, item.dy])).toEqual([[0, 0], [2, -1], [3, -2]]);
  });

  it("merges consecutive abnormal frames and preserves interval worst metrics", () => {
    const input = snapshot([seed("p-1")], [
      track("p-1", 1),
      track("p-1", 2, { state: "suspect", confidence: .4, residual: 2 }),
      track("p-1", 3, { state: "lost", confidence: .2, residual: 3 }),
      track("p-1", 4),
      track("p-1", 5, { state: "reviewed", confidence: .5, residual: 1 })
    ]);

    const report = buildReportModel(input, metadata, undefined, { keyFrameCount: 4 });

    expect(report.anomalyIntervals).toEqual([
      { pointId: "p-1", startFrame: 2, endFrame: 3, frameCount: 2, worstState: "lost", minimumConfidence: .2, maximumResidual: 3 },
      { pointId: "p-1", startFrame: 5, endFrame: 5, frameCount: 1, worstState: "reviewed", minimumConfidence: .5, maximumResidual: 1 }
    ]);
    expect(report.keyFrames.filter(item => item.pointId === "p-1").map(item => item.frame)).toEqual([1, 2, 3, 5]);
  });

  it("caps only chart samples while preserving raw tracks and global extrema", () => {
    const tracks = Array.from({ length: 1500 }, (_, frame) => track("p-1", frame, {
      refined: { x: frame === 741 ? -500 : frame === 1201 ? 5000 : frame, y: frame }
    }));

    const report = buildReportModel(snapshot([seed("p-1")], tracks), metadata);
    const samples = report.chartSeries[0].samples;

    expect(report.tracks).toHaveLength(1500);
    expect(samples.length).toBeLessThanOrEqual(1000);
    expect(samples.map(item => item.x)).toContain(-500);
    expect(samples.map(item => item.x)).toContain(5000);
    expect(samples[0].frame).toBe(0);
    expect(samples.at(-1)?.frame).toBe(1499);
  });

  it.each([
    ["pass", Array.from({ length: 10 }, (_, frame) => track("p-1", frame))],
    ["review", Array.from({ length: 10 }, (_, frame) => track("p-1", frame, frame === 2 ? { state: "lost" } : {}))],
    ["fail", Array.from({ length: 10 }, (_, frame) => track("p-1", frame, frame === 9 ? { state: "paused" } : {}))]
  ] as const)("assigns the %s grade", (grade, tracks) => {
    const report = buildReportModel(snapshot([seed("p-1")], [...tracks]), metadata);
    expect(report.grade).toBe(grade);
    expect(report.points[0].grade).toBe(grade);
  });

  it("fails confidence below the review threshold", () => {
    const tracks = Array.from({ length: 10 }, (_, frame) => track("p-1", frame, { confidence: .4 }));
    const report = buildReportModel(snapshot([seed("p-1")], tracks), metadata);
    expect(report.grade).toBe("fail");
    expect(report.points[0].grade).toBe("fail");
  });

  it("supports custom thresholds and validates their ranges and order", () => {
    const tracks = Array.from({ length: 10 }, (_, frame) => track("p-1", frame, frame === 2 ? { state: "lost", confidence: .6 } : { confidence: .6 }));
    const report = buildReportModel(snapshot([seed("p-1")], tracks), metadata, {
      passValidRatio: .8, reviewValidRatio: .5,
      passConfidenceP50: .5, reviewConfidenceP50: .3,
      failLostRatio: .5, reviewDroppedFrameRatio: .5
    });

    expect(report.grade).toBe("pass");
    expect(() => buildReportModel(snapshot([], []), metadata, { passValidRatio: .5, reviewValidRatio: .6 })).toThrow(/reviewValidRatio/);
    expect(DEFAULT_QUALITY_THRESHOLDS.passValidRatio).toBe(.95);
  });

  it("keeps confirmed points exportable without tracks at small and maximum point counts", () => {
    for (const count of [3, 100]) {
      const seeds = Array.from({ length: count }, (_, index) => seed(`p-${String(count - index).padStart(3, "0")}`));
      const report = buildReportModel(snapshot(seeds), metadata);
      expect(report.grade).toBe("not-evaluated");
      expect(report.execution).toMatchObject({ pointCount: count, frameCount: 0, sampleCount: 0 });
      expect(report.points).toHaveLength(count);
      expect(report.points.every(point => point.grade === "not-evaluated" && point.start === null)).toBe(true);
      expect(report.points.map(point => point.pointId)).toEqual([...report.points.map(point => point.pointId)].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("keeps every seed when active ids are partial and summarizes abnormal coordinates", () => {
    const first = seed("p-1");
    const second = seed("p-2");
    second.quality = { confidence: .7, residualPx: .2, gates: { edge: false } };
    const report = buildReportModel({
      ...snapshot([first, second], [
        track("p-1", 1, { state: "suspect", refined: { x: 4, y: 5 } }),
        track("p-1", 2, { state: "lost", refined: { x: 8, y: 9 } })
      ]),
      activePointIds: ["p-1"]
    }, metadata);

    expect(report.points.map(point => point.pointId)).toEqual(["p-1", "p-2"]);
    expect(report.points[0]).toMatchObject({ start: { x: 4, y: 5 }, end: { x: 8, y: 9 }, dx: 4, dy: 4, xRange: { min: 4, max: 8 }, yRange: { min: 5, max: 9 } });
    expect(report.points[1].gatingFailures).toEqual({ edge: 1 });
  });

  it("degrades pass results for recovery, rejected registration, error risks, and dropped frames", () => {
    const base = snapshot([seed("p-1")], Array.from({ length: 10 }, (_, frame) => track("p-1", frame)));
    const recovery: ReportSnapshot = { ...base, recoveryEvents: [{ id: "r-1", frame: 4, kind: "applied", anchorCount: 3, coverage: .5, inlierRatio: .8, predictedMedianError: 1, reversible: true }] };
    const rejected: ReportSnapshot = { ...base, registrations: [{ frame: 3, method: "sift-ransac", inlierCount: 2, matchCount: 10, inlierRatio: .2, medianReprojectionError: 4, accepted: false }] };
    const risk: ReportSnapshot = { ...base, riskNotices: [{ id: "risk-1", code: "tracking.frame-budget", severity: "error", frame: 2, message: "slow", action: "pause", recoverable: true }] };
    const dropped: ReportSnapshot = { ...base, processingStats: { ...base.processingStats, processedFrames: 90, droppedFrames: 10 } };

    expect(buildReportModel(recovery, metadata).grade).toBe("review");
    expect(buildReportModel(rejected, metadata).grade).toBe("review");
    expect(buildReportModel(risk, metadata).grade).toBe("review");
    expect(buildReportModel(dropped, metadata).grade).toBe("review");
    expect(buildReportModel(recovery, metadata).humanInterventions).toHaveLength(1);
  });

  it("summarizes registration quality and point gate failures", () => {
    const input = snapshot([seed("p-1")], [
      track("p-1", 1, { relocationMethod: "klt" }),
      track("p-1", 2, { relocationMethod: "manual" })
    ]);
    input.registrations = [
      { frame: 1, method: "sift-ransac", inlierCount: 8, matchCount: 10, inlierRatio: .8, medianReprojectionError: 1, accepted: true },
      { frame: 2, method: "orb-ransac", inlierCount: 4, matchCount: 10, inlierRatio: .4, medianReprojectionError: 3, accepted: false }
    ];
    input.riskNotices = [
      { id: "risk-1", code: "tracking.identity-gate-failed", severity: "warning", frame: 2, pointId: "p-1", message: "identity", action: "select-anchors", recoverable: true },
      { id: "risk-2", code: "refinement.gate-failed", severity: "warning", frame: 1, pointId: "p-1", message: "refine", action: "reselect-roi", recoverable: true }
    ];

    const report = buildReportModel(input, metadata);

    expect(report.registration).toMatchObject({ count: 2, acceptedCount: 1, rejectedCount: 1, successRate: .5, meanInlierRatio: .6, medianInlierRatio: .6, meanReprojectionError: 2, p95ReprojectionError: 2.9 });
    expect(report.points[0].gatingFailures).toEqual({ "refinement.gate-failed": 1, "tracking.identity-gate-failed": 1 });
    expect(report.points[0].relocationMethods).toEqual({ klt: 1, manual: 1 });
    expect(report.humanInterventions).toContainEqual(expect.objectContaining({ kind: "manual-relocation", pointId: "p-1", frame: 2 }));
  });

  it("excludes non-finite registration errors from aggregate statistics", () => {
    const input = snapshot([seed("p-1")], [track("p-1", 1)]);
    input.registrations = [{ frame: 1, method: "sift-ransac", inlierCount: 1, matchCount: 1, inlierRatio: .5, medianReprojectionError: Number.POSITIVE_INFINITY }];
    expect(buildReportModel(input, metadata).registration).toMatchObject({ meanReprojectionError: null, p95ReprojectionError: null });
  });

  it("samples dense anomaly boundaries across the timeline within the key-frame cap", () => {
    const tracks = Array.from({ length: 60 }, (_, frame) => track("p-1", frame, { state: frame % 2 ? "suspect" : "valid" }));
    const frames = buildReportModel(snapshot([seed("p-1")], tracks), metadata).keyFrames.map(item => item.frame);
    expect(frames).toHaveLength(20);
    expect(frames[0]).toBe(1);
    expect(frames.at(-1)).toBe(59);
  });

  it("builds fixed first-frame group topology and keeps disabled edges disabled", () => {
    const seeds = [
      { ...seed("p-1"), snapped: { x: 0, y: 0 }, groupId: "g-1" },
      { ...seed("p-2"), snapped: { x: 100, y: 0 }, groupId: "g-1" },
      { ...seed("p-3"), snapped: { x: 100, y: 100 }, groupId: "g-1" },
      { ...seed("p-4"), snapped: { x: 0, y: 100 }, groupId: "g-1" }
    ];
    const first = buildReportModel(snapshot(seeds), metadata);
    expect(first.topology).toHaveLength(5);
    const disabled = first.topology[0].edgeId;
    const second = buildReportModel({ ...snapshot(seeds), disabledTopologyEdgeIds: [disabled] }, metadata);
    expect(second.topology.find(edge => edge.edgeId === disabled)?.enabled).toBe(false);
  });

  it("reports frame completeness and computes optional calibrated ground-truth errors", () => {
    const input = snapshot([seed("p-1")], [
      track("p-1", 0, { refined: { x: 2, y: 4 } }),
      track("p-1", 1, { refined: { x: 4, y: 8 }, state: "provisional" })
    ]);
    input.frameLedger = Array.from({ length: 10 }, (_, inputIndex) => ({
      inputIndex,
      frame: inputIndex,
      sourceName: `Z1_${inputIndex + 1}.png`,
      timestampMs: inputIndex * 40,
      decodeStatus: "decoded" as const,
      processingStatus: inputIndex === 4 ? "isolated" as const : "processed" as const,
      validCount: inputIndex === 0 ? 1 : 0,
      provisionalCount: inputIndex === 1 ? 1 : 0,
      suspectCount: 0,
      missingCount: inputIndex === 4 ? 1 : 0,
      keyframe: inputIndex === 0,
      registrationDecision: inputIndex === 4 ? "rejected" as const : "accepted" as const,
      failureReason: inputIndex === 4 ? "registration.invalid-projected-frame" : null
    }));
    input.calibration = {
      xUnitsPerPixel: .5, yUnitsPerPixel: .25, unit: "mm",
      pixelOrigin: { x: 0, y: 0 }, engineeringOrigin: { x: 0, y: 0 }, yAxisDirection: "down"
    };
    input.groundTruth = [
      { pointId: "p-1", frame: 0, x: 1.2, y: .8, unit: "mm" },
      { pointId: "p-1", frame: 1, x: 1.8, y: 2.2, unit: "mm" }
    ];

    const report = buildReportModel(input, metadata);

    expect(report.execution).toMatchObject({ inputFrameCount: 10, processedFrameCount: 9, isolatedFrameCount: 1, missingFrameCount: 1 });
    expect(report.frameLedger).toHaveLength(10);
    expect(report.groundTruthErrors[0]).toMatchObject({ pointId: "p-1", unit: "mm", count: 2, biasX: 0, biasY: 0, maeX: .2, maeY: .2 });
    expect(report.groundTruthErrors[0].rmseX).toBeCloseTo(.2, 10);
    expect(report.groundTruthErrors[0].radialMax).toBeCloseTo(Math.hypot(.2, .2), 10);
  });
});
