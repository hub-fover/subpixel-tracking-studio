import { describe, expect, it } from "vitest";
import type { FrameLedgerEntry, MultiPointTrack, PointSeed } from "@subpixel/contracts";
import { buildFrameReviewRows, moveReviewFrame, tracksForFrame } from "./reviewState";
import { appendFrameLedgerEntry, appendTracks, createPointSetState, setTrackReviewDecision } from "./pointSetState";

const seed = (pointId: string): PointSeed => ({
  pointId, click: { x: 10, y: 20 }, snapped: { x: 10, y: 20 }, roi: { x: 0, y: 0, width: 20, height: 20 },
  groupId: "cooperative", candidateScore: .9, model: "crosshair", selectionMethod: "roi", intent: "crosshair-center"
});

const track = (pointId: string, frame: number, state: MultiPointTrack["state"] = "valid"): MultiPointTrack => ({
  pointId, frame, timestampMs: frame * 40, predicted: { x: 10 + frame, y: 20 }, refined: { x: 10.1 + frame, y: 20.2 }, model: "crosshair",
  confidence: .9, residual: .1, flowErrorForwardBackward: null, ncc: .9, descriptorDistance: null, epipolarError: null,
  predictionSource: "previous-position", innovationPx: .22, localAffineResidualPx: null, gateFailures: [], candidateUniqueness: null,
  state, relocationMethod: "feature-refine"
});

const ledger = (inputIndex: number, frame: number | null = inputIndex): FrameLedgerEntry => ({
  inputIndex, frame, sourceName: `frame-${inputIndex + 1}.jpg`, timestampMs: inputIndex * 40,
  decodeStatus: frame === null ? "failed" : "decoded", processingStatus: frame === null ? "isolated" : "processed",
  validCount: frame === null ? 0 : 2, provisionalCount: 0, suspectCount: 0, missingCount: frame === null ? 2 : 0,
  keyframe: inputIndex === 0, registrationDecision: frame === null ? "rejected" : "accepted", failureReason: null
});

describe("frame review state", () => {
  it("selects only the requested frame and keeps point ids stable", () => {
    const tracks = [track("p-002", 1), track("p-001", 0), track("p-001", 1)];
    expect(tracksForFrame(tracks, 1).map(item => item.pointId)).toEqual(["p-001", "p-002"]);
  });

  it("lists every confirmed point and marks observations missing from the selected frame", () => {
    const rows = buildFrameReviewRows([seed("p-001"), seed("p-002"), seed("p-003")], [track("p-001", 2), track("p-003", 2, "provisional")], 2);
    expect(rows.map(row => [row.pointId, row.track?.state ?? "missing"])).toEqual([
      ["p-001", "valid"], ["p-002", "missing"], ["p-003", "provisional"]
    ]);
  });

  it("moves through the actual frame ledger and clamps at both ends", () => {
    const entries = [ledger(0), ledger(1, null), ledger(2), ledger(3)];
    expect(moveReviewFrame(entries, 0, 1)).toBe(2);
    expect(moveReviewFrame(entries, 2, 1)).toBe(3);
    expect(moveReviewFrame(entries, 3, 1)).toBe(3);
    expect(moveReviewFrame(entries, 2, -1)).toBe(0);
  });

  it("accepts or rejects only one point observation", () => {
    let state = createPointSetState([seed("p-001"), seed("p-002")]);
    state = appendTracks(state, [track("p-001", 2, "provisional"), track("p-002", 2, "provisional")]);
    state = appendFrameLedgerEntry(state, { ...ledger(2), validCount: 0, provisionalCount: 2 });
    state = setTrackReviewDecision(state, "p-001", 2, "accept");
    state = setTrackReviewDecision(state, "p-002", 2, "reject");
    expect(state.tracksByPoint.get("p-001")?.[0].state).toBe("reviewed");
    expect(state.tracksByPoint.get("p-002")?.[0].state).toBe("suspect");
    expect(state.frameLedger[0]).toMatchObject({ validCount: 1, provisionalCount: 0, suspectCount: 1, missingCount: 0 });
  });
});
