import { afterEach, describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { LocalWorkerClient } from "./localWorkerClient";

const originalWorker = globalThis.Worker;

function brightBlobPatch(): GrayPatch {
  const width = 31; const height = 31; const data = new Float32Array(width * height).fill(20);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (Math.hypot(x - 15.25, y - 14.75) <= 5) data[y * width + x] = 230;
  }
  return { width, height, data };
}

afterEach(() => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: originalWorker });
});

describe("local worker client", () => {
  it("falls back to local refinement when the module worker fails to load", async () => {
    class FailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage() { queueMicrotask(() => this.onerror?.({ message: "worker chunk failed" } as ErrorEvent)); }
      terminate() { /* no-op */ }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FailingWorker });
    const client = new LocalWorkerClient();
    const patch = brightBlobPatch();
    const frame = { frame: 0, timestampMs: 0, width: patch.width, height: patch.height, source: "image" as const };

    const result = await Promise.race([
      client.refine(frame, patch, { x: 100, y: 200, width: patch.width, height: patch.height }, "blob-center"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker refinement did not settle")), 100))
    ]);

    expect(result.accepted).toBe(true);
    expect(result.point?.x).toBeGreaterThan(114);
    expect(result.point?.y).toBeGreaterThan(213);
    client.dispose();
  });
});
