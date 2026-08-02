import type { ExtractionIntent, FeatureRefinement, LocalFrame, Roi } from "@subpixel/contracts";
import type { GrayPatch } from "@subpixel/algorithms";
import { refineLocalPatch } from "./localRefinement";
import type { LocalWorkerCommand, LocalWorkerResponse } from "../../workers/local-algorithm.worker";

type WorkerLike = Worker & { onmessage: ((event: MessageEvent<LocalWorkerResponse>) => void) | null };

/** Runs ROI refinement off the UI thread when module workers are available. */
export class LocalWorkerClient {
  private worker?: WorkerLike;
  private sequence = 0;

  constructor() {
    if (typeof Worker === "undefined") return;
    try { this.worker = new Worker(new URL("../../workers/local-algorithm.worker.ts", import.meta.url), { type: "module" }) as WorkerLike; }
    catch { this.worker = undefined; }
  }

  refine(frame: LocalFrame, patch: GrayPatch, roi: Roi, intent: ExtractionIntent): Promise<FeatureRefinement> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(refineLocalPatch(patch, intent, roi));
    const requestId = ++this.sequence;
    return new Promise(resolve => {
      const previous = worker.onmessage;
      worker.onmessage = event => {
        const response = event.data;
        if (response.type === "refinement" && response.frame === frame.frame) { worker.onmessage = previous; resolve(response.result); }
        else if (response.type === "error" && response.frame === frame.frame) { worker.onmessage = previous; resolve({ accepted: false, intent, roi, point: null, confidence: 0, residualPx: null, gates: { worker: false }, reason: response.message, geometry: null }); }
      };
      const fallbackPatch = { ...patch, data: new Float32Array(patch.data) };
      const command: LocalWorkerCommand = { type: "refine", frame, patch, roi, intent };
      try { worker.postMessage(command, [patch.data.buffer]); }
      catch { worker.onmessage = previous; resolve(refineLocalPatch(fallbackPatch, intent, roi)); }
      void requestId;
    });
  }

  dispose() { this.worker?.terminate(); this.worker = undefined; }
}
