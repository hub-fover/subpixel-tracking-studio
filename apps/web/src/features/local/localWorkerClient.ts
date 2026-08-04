import type { ExtractionIntent, FeatureRefinement, LocalFrame, Roi } from "@subpixel/contracts";
import type { GrayPatch } from "@subpixel/algorithms";
import { refineLocalPatch } from "./localRefinement";
import type { LocalWorkerCommand, LocalWorkerResponse } from "../../workers/local-algorithm.worker";

type WorkerLike = Worker & { onmessage: ((event: MessageEvent<LocalWorkerResponse>) => void) | null };
type PendingRequest = { onResponse: (response: LocalWorkerResponse) => void; onFailure: () => void };

/** Runs ROI refinement off the UI thread when module workers are available. */
export class LocalWorkerClient {
  private worker?: WorkerLike;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      this.worker = new Worker(new URL("../../workers/local-algorithm.worker.ts", import.meta.url), { type: "module" }) as WorkerLike;
      this.worker.onmessage = event => {
        const request = this.pending.get(event.data.requestId);
        if (!request) return;
        this.pending.delete(event.data.requestId);
        request.onResponse(event.data);
      };
      this.worker.onerror = () => {
        const pending = [...this.pending.values()];
        this.pending.clear();
        this.worker?.terminate();
        this.worker = undefined;
        for (const request of pending) request.onFailure();
      };
    }
    catch { this.worker = undefined; }
  }

  refine(frame: LocalFrame, patch: GrayPatch, roi: Roi, intent: ExtractionIntent): Promise<FeatureRefinement> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(refineLocalPatch(patch, intent, roi));
    const requestId = ++this.sequence;
    return new Promise(resolve => {
      const fallbackPatch = { ...patch, data: new Float32Array(patch.data) };
      this.pending.set(requestId, {
        onResponse: response => {
          if (response.type === "refinement") resolve(response.result);
          else if (response.type === "error") resolve({ accepted: false, intent, roi, point: null, confidence: 0, residualPx: null, gates: { worker: false }, reason: response.message, geometry: null });
        },
        onFailure: () => resolve(refineLocalPatch(fallbackPatch, intent, roi))
      });
      const command: LocalWorkerCommand = { type: "refine", requestId, frame, patch, roi, intent };
      try { worker.postMessage(command, [patch.data.buffer]); }
      catch { this.pending.delete(requestId); resolve(refineLocalPatch(fallbackPatch, intent, roi)); }
    });
  }

  dispose() { this.worker?.terminate(); this.worker = undefined; this.pending.clear(); }
}
