import { describe, expect, it } from "vitest";
import { createTracker } from "../tracker";
import type { FeatureModel, GrayPatch } from "../types";

const patch: GrayPatch = { width: 1, height: 1, data: new Float32Array([1]) };

describe("tracker", () => {
  it("transitions from suspect to lost after consecutive failures", () => {
    const model: FeatureModel = { type: "circle", detectInitial: () => ({ x: 0, y: 0, residual: 0, confidence: 1, metrics: {} }), refineSubpixel: () => ({ x: 20, y: 20, residual: 1, confidence: 0.1, metrics: {} }) };
    const tracker = createTracker({ model, maxJumpPx: 4, maxResidual: 0.2, minConfidence: 0.5, lostAfter: 2 });
    expect(tracker.initialize(patch).track.state).toBe("suspect");
    expect(tracker.process(patch, 33).track.state).toBe("lost");
  });
});
