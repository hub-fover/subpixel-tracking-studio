import { describe, expect, it } from "vitest";
import type { PointSeed } from "@subpixel/contracts";
import { canStartTrackingInEngineMode, isCurrentRefinementRevision, trackingTemplateRoi } from "./App";

const seed = (model: PointSeed["model"]): PointSeed => ({
  pointId: "p-001",
  click: { x: 120, y: 90 },
  snapped: { x: 120, y: 90 },
  roi: { x: 60, y: 30, width: 120, height: 120 },
  groupId: "test",
  candidateScore: .9,
  model,
});

describe("tracking template ROI", () => {
  it("requires explicit confirmation before using degraded small-motion tracking", () => {
    const unavailable = { opencv: "unavailable" as const, capabilities: { refinement: false, registration: false, descriptors: false } };
    const ready = { opencv: "ready" as const, capabilities: { refinement: true, registration: true, descriptors: true } };
    expect(canStartTrackingInEngineMode(unavailable, false)).toBe(false);
    expect(canStartTrackingInEngineMode(unavailable, true)).toBe(true);
    expect(canStartTrackingInEngineMode(ready, false)).toBe(true);
  });

  it("discards stale refinement side effects after the ROI revision changes", () => {
    expect(isCurrentRefinementRevision(4, 5)).toBe(false);
    expect(isCurrentRefinementRevision(5, 5)).toBe(true);
  });

  it("crops a natural feature around the refined center without scaling pixels", () => {
    const roi = trackingTemplateRoi(seed("natural-keypoint"), { width: 640, height: 480 });
    expect(roi).toEqual({ x: 105, y: 75, width: 31, height: 31 });
  });

  it("keeps the full cooperative marker ROI", () => {
    expect(trackingTemplateRoi(seed("circle"), { width: 640, height: 480 })).toEqual(seed("circle").roi);
  });

  it("rebuilds native template ROIs around a manually recovered keyframe position", () => {
    expect(trackingTemplateRoi(seed("circle"), { width: 640, height: 480 }, { x: 240, y: 180 })).toEqual({ x: 180, y: 120, width: 120, height: 120 });
    expect(trackingTemplateRoi(seed("natural-keypoint"), { width: 640, height: 480 }, { x: 240, y: 180 })).toEqual({ x: 225, y: 165, width: 31, height: 31 });
  });
});
