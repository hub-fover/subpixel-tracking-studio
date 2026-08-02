import type { PointTrack, TrackingEvent } from "@subpixel/contracts";
import type { FeatureModel, GrayPatch } from "./types";

export type TrackerOptions = {
  model: FeatureModel;
  maxJumpPx: number;
  maxResidual: number;
  minConfidence: number;
  lostAfter: number;
};

export type TrackerOutput = { track: PointTrack; event?: TrackingEvent };

export function createTracker(options: TrackerOptions) {
  let previous: PointTrack | undefined;
  let velocity = { x: 0, y: 0 };
  let failures = 0;
  let frame = 0;

  function evaluate(patch: GrayPatch, timestampMs: number): TrackerOutput {
    const startedAt = performance.now();
    const result = options.model.refineSubpixel(patch);
    const predicted = previous ? { x: previous.x + velocity.x, y: previous.y + velocity.y } : result;
    const jump = Math.hypot(result.x - predicted.x, result.y - predicted.y);
    const failed = result.residual > options.maxResidual || result.confidence < options.minConfidence || jump > options.maxJumpPx;
    failures = failed ? failures + 1 : 0;
    const state: PointTrack["state"] = failures >= options.lostAfter ? "lost" : failed ? "suspect" : "valid";
    const track: PointTrack = { frame, timestampMs, x: result.x, y: result.y, model: options.model.type, residual: result.residual, confidence: result.confidence, state, durationMs: performance.now() - startedAt };
    if (state === "valid" && previous) velocity = { x: result.x - previous.x, y: result.y - previous.y };
    if (state === "valid") previous = track;
    const event = state === "valid" ? undefined : { id: `event-${frame}-${state}`, frame, kind: state === "lost" ? "lost" as const : "low-confidence" as const, message: state === "lost" ? "Tracking lost; reselect ROI or roll back." : "Low confidence frame requires review.", recoverable: true };
    frame += 1;
    return { track, event };
  }

  return {
    initialize(patch: GrayPatch, timestampMs = 0) { previous = undefined; velocity = { x: 0, y: 0 }; failures = 0; frame = 0; return evaluate(patch, timestampMs); },
    process(patch: GrayPatch, timestampMs: number) { return evaluate(patch, timestampMs); },
    reset() { previous = undefined; velocity = { x: 0, y: 0 }; failures = 0; frame = 0; }
  };
}
