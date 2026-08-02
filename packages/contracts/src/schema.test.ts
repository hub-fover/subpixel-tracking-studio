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
