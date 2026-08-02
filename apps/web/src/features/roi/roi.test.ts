import { describe, expect, it } from "vitest";
import { clampRoi, computeFitScale, fitImageSize, normalizeNativeRoi, roiFromDrag } from "./RoiCanvas";
import { confirmFeatureDraft, intentToModel, nextPointId } from "./pointState";

describe("ROI", () => { it("clamps to image bounds", () => { expect(clampRoi({ x: -5, y: 90, width: 30, height: 30 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 90, width: 30, height: 10 }); }); });

it("keeps the original pixel buffer at native resolution", () => {
  expect(fitImageSize(6144, 8192, 2560)).toEqual({ width: 6144, height: 8192, scale: 1 });
  expect(fitImageSize(4200, 2160, 2560)).toEqual({ width: 4200, height: 2160, scale: 1 });
});

it("fits a native image into the viewport without changing algorithm pixels", () => {
  expect(computeFitScale(400, 300, 1600, 1200)).toBeCloseTo(0.2267, 3);
  expect(computeFitScale(2400, 1800, 1600, 1200)).toBe(1);
});

it("creates and clamps an ROI when dragging in either direction", () => {
  expect(roiFromDrag({ x: 90, y: 80 }, { x: 20, y: 10 }, { width: 100, height: 100 }))
    .toEqual({ x: 20, y: 10, width: 70, height: 70 });
  expect(roiFromDrag({ x: -10, y: 20 }, { x: 120, y: 90 }, { width: 100, height: 80 }))
    .toEqual({ x: 0, y: 20, width: 100, height: 60 });
});

it("normalizes a visual selection to complete original pixels", () => {
  expect(normalizeNativeRoi({ x: 10.8, y: 20.2, width: 15.1, height: 9.6 }, { width: 100, height: 80 }))
    .toEqual({ x: 10, y: 20, width: 16, height: 10 });
});

it("never reuses a confirmed point id after deletion", () => {
  expect(nextPointId(["p-001", "p-004"])).toBe("p-005");
});

it("maps extraction intents to tracking models", () => {
  expect(intentToModel("circle-center")).toBe("circle");
  expect(intentToModel("corner")).toBe("natural-keypoint");
  expect(intentToModel("blob-center")).toBe("blob");
});

it("only confirms an accepted native-coordinate refinement", () => {
  const draft = {
    id: "draft-1", revision: 2, status: "ready" as const, intent: "circle-center" as const,
    roi: { x: 100, y: 200, width: 80, height: 60 },
    refinement: {
      accepted: true, intent: "circle-center" as const,
      roi: { x: 100, y: 200, width: 80, height: 60 }, point: { x: 140.25, y: 229.75 },
      confidence: 0.94, residualPx: 0.08, gates: { edgeCoverage: true }, reason: null,
      geometry: { kind: "ellipse" as const, center: { x: 140.25, y: 229.75 }, majorAxis: 42, minorAxis: 40, angleDeg: 2, edgeCoverage: 0.9, inlierCount: 100 }
    }
  };
  expect(confirmFeatureDraft(draft, "p-008")).toMatchObject({
    pointId: "p-008", selectionMethod: "roi", model: "circle",
    click: { x: 140.25, y: 229.75 }, snapped: { x: 140.25, y: 229.75 },
    roi: { x: 100, y: 200, width: 80, height: 60 }
  });
  expect(confirmFeatureDraft({ ...draft, status: "invalid", refinement: { ...draft.refinement, accepted: false } }, "p-009")).toBeNull();
});
