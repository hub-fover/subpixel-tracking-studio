import { describe, expect, it } from "vitest";
import { handleTrackerCommand } from "./tracker.worker";

describe("tracker worker protocol", () => {
  it("requires initialization", () => {
    const response = handleTrackerCommand({ type: "process", frame: { width: 1, height: 1, data: new Float32Array([1]) }, timestampMs: 0 });
    expect(response.type).toBe("error");
  });

  it("initializes and processes a multi-point worker job", () => {
    const seed = { pointId: "p-1", click: { x: 10, y: 10 }, snapped: { x: 10, y: 10 }, roi: { x: 2, y: 2, width: 16, height: 16 }, groupId: "natural", candidateScore: .9, model: "natural-keypoint" as const };
    expect(handleTrackerCommand({ type: "initialize-multi", seeds: [seed] }).type).toBe("multi-initialized");
    const response = handleTrackerCommand({ type: "process-multi", timestampMs: 33, observations: [{ pointId: "p-1", predicted: { x: 11, y: 10 }, refined: { x: 11.1, y: 10.1 }, confidence: .9, residual: .1, relocationMethod: "klt", metrics: { forwardBackwardError: .4, ncc: .8, epipolarError: 1, loweRatio: .6 } }] });
    expect(response.type).toBe("multi-track");
  });
});
