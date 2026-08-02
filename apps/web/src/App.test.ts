import { describe, expect, it } from "vitest";
import type { PointSeed } from "@subpixel/contracts";
import { trackingTemplateRoi } from "./App";

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
  it("crops a natural feature around the refined center without scaling pixels", () => {
    const roi = trackingTemplateRoi(seed("natural-keypoint"), { width: 640, height: 480 });
    expect(roi).toEqual({ x: 105, y: 75, width: 31, height: 31 });
  });

  it("keeps the full cooperative marker ROI", () => {
    expect(trackingTemplateRoi(seed("circle"), { width: 640, height: 480 })).toEqual(seed("circle").roi);
  });
});
