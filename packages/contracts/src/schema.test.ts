import { describe, expect, it } from "vitest";

import {
  AnchorCorrespondenceSchema,
  FeatureDraftSchema,
  FeatureRefinementSchema,
  FrameRegistrationSchema,
  MultiPointJobSchema,
  MultiPointTrackSchema,
  PointSeedSchema,
  PointTrackSchema,
  RecoveryEventSchema,
  RiskNoticeSchema,
  CameraSessionSchema,
  ProcessingStatsSchema,
  QualityThresholdsSchema,
  ReportManifestSchema,
  ReportMetadataSchema,
  ReportModelSchema,
  ReportOptionsSchema,
  TrackingJobSchema
} from "./schema";

describe("tracking contracts", () => {
  it("keeps an unconfirmed ROI as a feature draft", () => {
    const draft = FeatureDraftSchema.parse({
      id: "draft-1", status: "ready", intent: "circle-center",
      roi: { x: 10, y: 20, width: 40, height: 44 }, revision: 2,
      refinement: {
        accepted: true, intent: "circle-center", roi: { x: 10, y: 20, width: 40, height: 44 },
        point: { x: 30.2, y: 42.1 }, confidence: .9, residualPx: .2,
        gates: { residual: true }, reason: null,
        geometry: { kind: "ellipse", center: { x: 30.2, y: 42.1 }, majorAxis: 20, minorAxis: 18, angleDeg: 0, edgeCoverage: .8, inlierCount: 50 }
      }
    });
    expect(draft.status).toBe("ready");
  });
  it("validates refinement geometry and optional ROI seed metadata", () => {
    const refinement = FeatureRefinementSchema.parse({
      accepted: true,
      intent: "circle-center",
      roi: { x: 100, y: 200, width: 48, height: 48 },
      point: { x: 124.25, y: 223.75 },
      confidence: 0.94,
      residualPx: 0.12,
      gates: { edgePoints: true, residual: true },
      reason: null,
      geometry: {
        kind: "ellipse",
        center: { x: 124.25, y: 223.75 },
        majorAxis: 18,
        minorAxis: 16,
        angleDeg: 12,
        edgeCoverage: 0.91,
        inlierCount: 87
      }
    });
    expect(refinement.geometry?.kind).toBe("ellipse");

    const seed = PointSeedSchema.parse({
      pointId: "roi-1",
      click: { x: 124, y: 224 },
      snapped: { x: 124.25, y: 223.75 },
      roi: { x: 100, y: 200, width: 48, height: 48 },
      candidateScore: 0.94,
      model: "circle",
      selectionMethod: "roi",
      intent: "circle-center",
      geometry: refinement.geometry,
      quality: { confidence: 0.94, residualPx: 0.12, gates: { residual: true } }
    });
    expect(seed.selectionMethod).toBe("roi");
  });

  it("rejects invalid refinement confidence and geometry", () => {
    expect(FeatureRefinementSchema.safeParse({
      accepted: true, intent: "corner", roi: { x: 0, y: 0, width: 20, height: 20 },
      point: { x: 10, y: 10 }, confidence: 1.1, residualPx: null, gates: {}, reason: null,
      geometry: { kind: "corner", point: { x: 10, y: 10 }, response: -1, uniquenessRatio: 1.5 }
    }).success).toBe(false);
  });
  it("accepts a local job with ROI and feature model", () => {
    const result = TrackingJobSchema.safeParse({
      id: "job-1",
      mode: "local",
      source: { kind: "image-sequence", name: "frames" },
      frameRange: { start: 0, end: 9, sampleRate: 1 },
      roi: { x: 10, y: 20, width: 40, height: 40 },
      model: { type: "circle", locked: true, params: {} },
      calibration: null,
      exports: ["json"]
    });

    expect(result.success).toBe(true);
  });

  it("rejects a point with a non-finite coordinate", () => {
    const result = PointTrackSchema.safeParse({
      frame: 0,
      timestampMs: 0,
      x: Number.NaN,
      y: 2,
      model: "circle",
      residual: 0,
      confidence: 1,
      state: "valid",
      durationMs: 1
    });

    expect(result.success).toBe(false);
  });

  it("accepts mixed multi-point seeds including a natural keypoint", () => {
    const result = PointSeedSchema.safeParse({
      pointId: "p-01",
      click: { x: 100.25, y: 42.5 },
      snapped: { x: 101, y: 42 },
      roi: { x: 90, y: 32, width: 24, height: 24 },
      groupId: "background",
      candidateScore: 0.88,
      model: "natural-keypoint",
      template: { width: 16, height: 16, levels: 3, descriptor: [0.1, 0.2] }
    });
    expect(result.success).toBe(true);
  });

  it("describes actionable local-processing risks and native camera stats", () => {
    const notice = RiskNoticeSchema.parse({
      id: "risk-1",
      code: "camera.permission-denied",
      severity: "error",
      frame: 0,
      message: "相机权限被拒绝",
      action: "open-settings",
      recoverable: true
    });
    expect(notice.action).toBe("open-settings");
    expect(CameraSessionSchema.parse({
      status: "ready",
      facingMode: "environment",
      nativeWidth: 3840,
      nativeHeight: 2160,
      recording: false,
      error: null
    }).nativeWidth).toBe(3840);
    expect(ProcessingStatsSchema.parse({
      processedFrames: 12,
      droppedFrames: 3,
      fps: 15,
      p95LatencyMs: 44,
      engine: "opencv-js",
      nativeWidth: 3840,
      nativeHeight: 2160
    }).engine).toBe("opencv-js");
  });

  it("accepts multi-point tracking, registration, anchors, and recovery events", () => {
    expect(MultiPointJobSchema.parse({
      id: "multi-1",
      mode: "local",
      source: { kind: "image-sequence", name: "frames" },
      frameRange: { start: 0, end: 9, sampleRate: 1 },
      seeds: [],
      snapRadiusPx: 12,
      sceneRegistrationEvery: 5,
      exports: ["json"]
    }).learnedRelocation).toEqual({ enabled: false, backend: "sift-fallback" });
    expect(MultiPointTrackSchema.parse({
      pointId: "p-01", frame: 2, timestampMs: 66, predicted: { x: 10, y: 20 }, refined: { x: 10.1, y: 20.2 },
      model: "natural-keypoint", confidence: 0.9, residual: 0.2, flowErrorForwardBackward: 0.4,
      ncc: 0.8, descriptorDistance: 0.5, epipolarError: 0.7, state: "valid", relocationMethod: "local-affine"
    }).pointId).toBe("p-01");
    expect(FrameRegistrationSchema.parse({ frame: 2, method: "sift-ransac", inlierCount: 120, matchCount: 180, inlierRatio: 2 / 3, medianReprojectionError: 1.2 }).frame).toBe(2);
    expect(AnchorCorrespondenceSchema.parse({ pointId: "p-01", reference: { x: 10, y: 20 }, current: { x: 12, y: 23 }, confidence: 0.9 }).pointId).toBe("p-01");
    expect(RecoveryEventSchema.parse({ id: "recovery-1", frame: 20, kind: "applied", anchorCount: 6, coverage: 0.4, inlierRatio: 0.8, predictedMedianError: 2.1, reversible: true }).kind).toBe("applied");
  });
});

describe("report contracts", () => {
  it("accepts bundle exports and preserves optional Lowe ratio measurements", () => {
    const job = MultiPointJobSchema.parse({
      id: "multi-report",
      mode: "local",
      source: { kind: "video", name: "test.mp4" },
      frameRange: { start: 0, end: 1, sampleRate: 1 },
      seeds: [],
      exports: ["bundle"]
    });
    const track = MultiPointTrackSchema.parse({
      pointId: "p-01", frame: 0, timestampMs: 0,
      predicted: { x: 10, y: 20 }, refined: { x: 10.1, y: 20.1 },
      model: "natural-keypoint", confidence: .9, residual: .2,
      loweRatio: .72, state: "valid"
    });

    expect(job.exports).toEqual(["bundle"]);
    expect(track.loweRatio).toBe(.72);
  });

  it("validates report metadata, options, and ordered quality thresholds", () => {
    expect(ReportMetadataSchema.parse({
      reportNumber: "R-2026-001", reportId: "report-1", projectName: "Bridge",
      testId: "T-9", operator: "Li", notes: "baseline", sourceFile: "test.mp4",
      generatedAt: "2026-08-02T08:00:00.000Z", buildCommit: "79cf4cb"
    })).toMatchObject({ reportId: "report-1" });
    expect(ReportOptionsSchema.parse({
      includedAssets: ["raw-data", "charts"], keyFrameCount: 12,
      imageQuality: "full", language: "zh-CN"
    })).toMatchObject({ keyFrameCount: 12 });
    expect(ReportOptionsSchema.parse({}).language).toBe("zh-CN");
    expect(ReportMetadataSchema.parse({
      reportNumber: "R-2026-002", reportId: "report-2", projectName: "", testId: "", operator: "",
      notes: "", sourceFile: "image.png", generatedAt: "2026-08-02T08:00:00.000Z", buildCommit: "dev"
    })).toMatchObject({ projectName: "", testId: "", operator: "" });
    expect(QualityThresholdsSchema.safeParse({
      passValidRatio: .8, reviewValidRatio: .95,
      passConfidenceP50: .8, reviewConfidenceP50: .55,
      failLostRatio: .2, reviewDroppedFrameRatio: .1
    }).success).toBe(false);
  });

  it("parses legacy manifests and traceable v2 manifests", () => {
    const legacyPayload = {
      jobId: "job-1", algorithmVersion: "1.0.0", summary: { tracks: 2 },
      assets: [{ kind: "csv", path: "tracks.csv" }], parameters: {}
    };
    const legacy = ReportManifestSchema.parse(legacyPayload);
    const current = ReportManifestSchema.parse({
      schemaVersion: 2,
      reportId: "report-1",
      jobId: "job-1",
      algorithmVersion: "2.0.0",
      source: { kind: "video", name: "test.mp4" },
      grade: "review",
      thresholds: {
        passValidRatio: .95, reviewValidRatio: .8,
        passConfidenceP50: .8, reviewConfidenceP50: .55,
        failLostRatio: .2, reviewDroppedFrameRatio: .1
      },
      summary: { tracks: 2 },
      assets: [{ kind: "csv", path: "tracks.csv", bytes: 40, sha256: "a".repeat(64), status: "generated" }],
      parameters: {},
      engine: "opencv-js",
      originalDimensions: { width: 3840, height: 2160 },
      processingStats: { processedFrames: 2, droppedFrames: 0, fps: 15, p95LatencyMs: 20, engine: "opencv-js", nativeWidth: 3840, nativeHeight: 2160 },
      buildCommit: "79cf4cb"
    });

    expect(legacy.jobId).toBe("job-1");
    expect(legacy.schemaVersion).toBeUndefined();
    expect(current).toMatchObject({ schemaVersion: 2, reportId: "report-1", grade: "review" });
    expect(ReportManifestSchema.safeParse({ ...legacyPayload, schemaVersion: 2 }).success).toBe(false);
  });

  it("requires report model execution and raw-row residual semantics", () => {
    const base = {
      metadata: {
        reportNumber: "R-2026-001", reportId: "report-1", projectName: "Bridge", testId: "T-9", operator: "Li", notes: "", sourceFile: "test.mp4", generatedAt: "2026-08-02T08:00:00.000Z", buildCommit: "79cf4cb"
      },
      thresholds: { passValidRatio: .95, reviewValidRatio: .8, passConfidenceP50: .8, reviewConfidenceP50: .55, failLostRatio: .2, reviewDroppedFrameRatio: .1 },
      options: { includedAssets: [], keyFrameCount: 20, imageQuality: "full", language: "en" }, grade: "pass",
      points: [], tracks: [{
        pointId: "p-1", frame: 0, timestampMs: 0, predicted: { x: 1, y: 2 }, refined: { x: 1, y: 2 },
        model: "natural-keypoint", confidence: .9, residual: .1, residualSemantics: "matching-error-model-specific",
        state: "valid", relocationMethod: "none"
      }], chartSeries: [],
      registration: { count: 0, acceptedCount: 0, rejectedCount: 0, successRate: 0, meanInlierRatio: null, medianInlierRatio: null, meanReprojectionError: null, p95ReprojectionError: null, methodDistribution: {} },
      anomalyIntervals: [], risks: [], humanInterventions: [], keyFrames: []
    };
    expect(ReportModelSchema.safeParse({ ...base, execution: {} }).success).toBe(false);
    expect(ReportModelSchema.safeParse({ ...base, execution: {
      pointCount: 1, frameCount: 1, sampleCount: 1, validRatio: 1, lostRatio: 0, droppedFrameRatio: 0,
      stateCounts: { valid: 1, suspect: 0, lost: 0, reviewed: 0, paused: 0 },
      processingStats: { processedFrames: 1, droppedFrames: 0, fps: 15, p95LatencyMs: 20, engine: "typescript", nativeWidth: null, nativeHeight: null }
    } }).success).toBe(true);
  });
});
