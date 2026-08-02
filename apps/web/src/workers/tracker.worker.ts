import { createMultiPointTracker, createTracker, featureModels, type GrayPatch, type MultiPointObservation } from "@subpixel/algorithms";
import type { PointSeed, TrackingJob } from "@subpixel/contracts";

type Command =
  | { type: "initialize"; job: TrackingJob; frame: GrayPatch; timestampMs: number }
  | { type: "process"; frame: GrayPatch; timestampMs: number }
  | { type: "initialize-multi"; seeds: PointSeed[] }
  | { type: "process-multi"; timestampMs: number; observations: MultiPointObservation[]; registration?: { matchCount: number; inlierRatio: number; medianReprojectionError: number } }
  | { type: "reset" }
  | { type: "dispose" };

let tracker: ReturnType<typeof createTracker> | undefined;
let multiTracker: ReturnType<typeof createMultiPointTracker> | undefined;

export function handleTrackerCommand(command: Command) {
  if (command.type === "dispose" || command.type === "reset") { tracker?.reset(); multiTracker?.reset(); tracker = undefined; multiTracker = undefined; return { type: "reset" as const }; }
  if (command.type === "initialize-multi") { multiTracker = createMultiPointTracker(command.seeds); multiTracker.initialize(); return { type: "multi-initialized" as const, pointCount: command.seeds.length }; }
  if (command.type === "process-multi") { if (!multiTracker) return { type: "error" as const, code: "tracker.not-initialized", message: "Initialize a multi-point job before processing frames.", recoverable: true }; return { type: "multi-track" as const, ...multiTracker.process(command.observations, command.timestampMs, command.registration) }; }
  if (command.type === "initialize") {
    tracker = createTracker({ model: featureModels[command.job.model.type], maxJumpPx: command.job.model.params.maxJumpPx ?? 8, maxResidual: command.job.model.params.maxResidual ?? 0.35, minConfidence: command.job.model.params.minConfidence ?? 0.35, lostAfter: command.job.model.params.lostAfter ?? 3 });
    return { type: "initialized" as const, ...tracker.initialize(command.frame, command.timestampMs) };
  }
  if (!tracker) return { type: "error" as const, code: "tracker.not-initialized", message: "Initialize a job before processing frames.", recoverable: true };
  return { type: "track" as const, ...tracker.process(command.frame, command.timestampMs) };
}

if (typeof self !== "undefined" && "postMessage" in self) {
  self.onmessage = (event: MessageEvent<Command>) => self.postMessage(handleTrackerCommand(event.data));
}
