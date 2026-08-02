import { describe, expect, it } from "vitest";
import { buildExportRows, buildExportDocument, overlayCanvasSize } from "./exportClient";
import type { FrameRegistration, PointSeed, RiskNotice } from "@subpixel/contracts";

describe("report export contract", () => { it("sorts exports by frame", () => { const frames = [{ frame: 3 }, { frame: 1 }].sort((a, b) => a.frame - b.frame); expect(frames.map(item => item.frame)).toEqual([1, 3]); }); });

it("exports multi-point quality metrics by point id", () => {
  const rows = buildExportRows({ tracks: [], events: [], roi: { x: 0, y: 0, width: 10, height: 10 }, model: "mixed", multiTracks: [{ pointId: "p-1", frame: 2, timestampMs: 33, predicted: { x: 1, y: 2 }, refined: { x: 1.1, y: 2.1 }, model: "natural-keypoint", confidence: .9, residual: .1, flowErrorForwardBackward: .4, ncc: .8, descriptorDistance: .5, epipolarError: 1, state: "valid", relocationMethod: "klt" }] });
  expect(rows[0]).toMatchObject({ point_id: "p-1", x_px: 1.1, relocation_method: "klt", ncc: .8 });
});

it("keeps overlay exports at native image dimensions", () => {
  expect(overlayCanvasSize({ width: 6144, height: 8192 })).toEqual({ width: 6144, height: 8192 });
});

it("exports all confirmed points even when no frames have been tracked", () => {
  const points: PointSeed[] = ["p-001", "p-002", "p-003"].map(pointId => ({
    pointId, click: { x: 1, y: 2 }, snapped: { x: 1, y: 2 }, roi: { x: 0, y: 0, width: 10, height: 10 },
    groupId: "test", candidateScore: .9, model: "blob", selectionMethod: "roi", intent: "blob-center",
  }));
  const document = buildExportDocument({ points, tracks: [], registrations: [], recoveryEvents: [], events: [] });
  expect(document.points.map(point => point.point_id)).toEqual(["p-001", "p-002", "p-003"]);
  expect(document.tracks).toEqual([]);
});

it("keeps registration rows alongside every point track", () => {
  const registration: FrameRegistration = { frame: 5, method: "sift-ransac", inlierCount: 80, matchCount: 100, inlierRatio: .8, medianReprojectionError: 1.2, p95LatencyMs: 120 };
  const document = buildExportDocument({ points: [], tracks: [], registrations: [registration], recoveryEvents: [], events: [] });
  expect(document.registrations).toHaveLength(1);
  expect(document.registrations[0]).toMatchObject({ frame: 5, method: "sift-ransac" });
});

it("exports local risk notices with the report", () => {
  const risk: RiskNotice = { id: "risk-1", code: "tracking.lost", severity: "error", frame: 4, message: "lost", action: "select-anchors", recoverable: true };
  const document = buildExportDocument({ points: [], tracks: [], registrations: [], recoveryEvents: [], events: [], riskNotices: [risk] });
  expect(document.riskNotices[0]).toMatchObject({ record_type: "risk", code: "tracking.lost" });
});
