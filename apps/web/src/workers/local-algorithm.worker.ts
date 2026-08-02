import type { ExtractionIntent, FrameRegistration, FeatureRefinement, LocalFrame, Roi } from "@subpixel/contracts";
import type { GrayPatch } from "@subpixel/algorithms";
import { refineLocalPatch } from "../features/local/localRefinement";
import { registerLocalPatches } from "../features/local/localRegistration";

export type LocalWorkerCommand =
  | { type: "refine"; requestId: number; frame: LocalFrame; patch: GrayPatch; roi: Roi; intent: ExtractionIntent }
  | { type: "register"; requestId: number; frame: LocalFrame; reference: GrayPatch; current: GrayPatch };

export type LocalWorkerResponse =
  | { type: "refinement"; requestId: number; frame: number; result: FeatureRefinement }
  | { type: "registration"; requestId: number; result: FrameRegistration }
  | { type: "error"; requestId: number; frame: number; message: string };

export function handleLocalCommand(command: LocalWorkerCommand): LocalWorkerResponse {
  try {
    if (command.type === "refine") return { type: "refinement", requestId: command.requestId, frame: command.frame.frame, result: refineLocalPatch(command.patch, command.intent, command.roi) };
    return { type: "registration", requestId: command.requestId, result: registerLocalPatches(command.reference, command.current, command.frame.frame) };
  } catch (error) {
    return { type: "error", requestId: command.requestId, frame: command.frame.frame, message: error instanceof Error ? error.message : "Local algorithm failed." };
  }
}

if (typeof self !== "undefined" && "postMessage" in self) {
  self.onmessage = (event: MessageEvent<LocalWorkerCommand>) => self.postMessage(handleLocalCommand(event.data));
}
