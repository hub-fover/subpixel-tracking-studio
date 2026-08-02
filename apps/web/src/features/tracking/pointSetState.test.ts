import { describe, expect, it } from "vitest";
import type { MultiPointTrack, PointSeed } from "@subpixel/contracts";
import { appendRiskNotice, appendTracks, createPointSetState, flattenTracks, pointRows, summarizeProcessing } from "./pointSetState";

const seed = (id: string): PointSeed => ({
  pointId: id, click: { x: 10, y: 20 }, snapped: { x: 10, y: 20 }, roi: { x: 0, y: 0, width: 20, height: 20 },
  groupId: "test", candidateScore: .9, model: "blob", selectionMethod: "roi", intent: "blob-center",
});
const track = (pointId: string, frame: number): MultiPointTrack => ({
  pointId, frame, timestampMs: frame * 10, predicted: { x: 10, y: 20 }, refined: { x: 10.1, y: 20.2 }, model: "blob",
  confidence: .9, residual: .1, flowErrorForwardBackward: null, ncc: .9, descriptorDistance: null, epipolarError: null,
  state: "valid", relocationMethod: "local-correlation",
});

describe("point set state", () => {
  it("keeps actionable risks newest-first without duplicating an id", () => {
    let state = createPointSetState();
    const risk = { id: "risk-1", code: "tracking.lost" as const, severity: "error" as const, frame: 4, message: "失锁", action: "select-anchors" as const, recoverable: true };
    state = appendRiskNotice(state, risk);
    state = appendRiskNotice(state, { ...risk, frame: 5, message: "仍然失锁" });
    expect(state.riskNotices).toHaveLength(1);
    expect(state.riskNotices[0].frame).toBe(5);
  });

  it("summarizes processing statistics for a native frame", () => {
    const stats = summarizeProcessing({ processedFrames: 12, droppedFrames: 3, latencies: [10, 20, 40, 30], nativeWidth: 1920, nativeHeight: 1080, engine: "typescript" });
    expect(stats.fps).toBeGreaterThan(0);
    expect(stats.p95LatencyMs).toBe(40);
    expect(stats.nativeWidth).toBe(1920);
  });

  it("keeps every confirmed point visible before tracking", () => {
    const state = createPointSetState([seed("p-001"), seed("p-002"), seed("p-003")]);
    expect(pointRows(state)).toHaveLength(3);
    expect(pointRows(state).map(row => row.pointId)).toEqual(["p-001", "p-002", "p-003"]);
  });

  it("indexes every frame by point id without overwriting siblings", () => {
    let state = createPointSetState([seed("p-001"), seed("p-002"), seed("p-003")]);
    state = appendTracks(state, [track("p-001", 0), track("p-002", 0), track("p-003", 0)]);
    state = appendTracks(state, [track("p-001", 1), track("p-002", 1), track("p-003", 1)]);
    expect(flattenTracks(state)).toHaveLength(6);
    expect([...state.tracksByPoint.entries()].map(([id, tracks]) => [id, tracks.length])).toEqual([["p-001", 2], ["p-002", 2], ["p-003", 2]]);
  });

  it("supports the 100-point limit with stable ordering", () => {
    const seeds = Array.from({ length: 100 }, (_, index) => seed(`p-${String(index + 1).padStart(3, "0")}`));
    const state = createPointSetState(seeds);
    expect(pointRows(state)).toHaveLength(100);
    expect(pointRows(state).at(-1)?.pointId).toBe("p-100");
  });
});
