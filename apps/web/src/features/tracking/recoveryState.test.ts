import { describe, expect, it } from "vitest";
import type { GrayPatch, MultiPointTrackerSnapshot } from "@subpixel/algorithms";
import { captureRecoverySnapshot, restoreRecoverySnapshot } from "./recoveryState";

const patch = (value: number): GrayPatch => ({ width: 2, height: 2, data: new Float32Array([value, value, value, value]) });

describe("recovery state", () => {
  it("restores independent copies of positions, templates, searches, and paused tracker state", () => {
    const tracker: MultiPointTrackerSnapshot = { frame: 8, paused: true, positions: [["p-1", { x: 10, y: 20 }]] };
    const input = {
      tracker,
      positions: new Map([["p-1", { x: 10, y: 20 }]]),
      referencePositions: new Map([["p-1", { x: 1, y: 2 }]]),
      templates: new Map([["p-1", patch(3)]]),
      previousSearches: new Map([["p-1", { roi: { x: 0, y: 0, width: 2, height: 2 }, patch: patch(4) }]]),
      keyframeFrame: 5,
      running: false,
      recoveryPaused: true
    };

    const snapshot = captureRecoverySnapshot(input);
    input.positions.get("p-1")!.x = 999;
    input.templates.get("p-1")!.data[0] = 999;
    const restored = restoreRecoverySnapshot(snapshot);
    restored.previousSearches.get("p-1")!.patch.data[0] = 888;

    expect(restored.positions.get("p-1")).toEqual({ x: 10, y: 20 });
    expect(restored.referencePositions.get("p-1")).toEqual({ x: 1, y: 2 });
    expect(restored.templates.get("p-1")!.data[0]).toBe(3);
    expect(snapshot.previousSearches.get("p-1")!.patch.data[0]).toBe(4);
    expect(restored).toMatchObject({ keyframeFrame: 5, running: false, recoveryPaused: true });
    expect(restored.tracker.paused).toBe(true);
  });
});
