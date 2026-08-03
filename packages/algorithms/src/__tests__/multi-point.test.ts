import { describe, expect, it } from "vitest";
import { chooseSnapCandidate, scoreNaturalCandidate, type NaturalCandidate } from "../natural-features";
import { matchTemplateNcc } from "../local-correlation";
import { applyLocalAffine, evaluateRecoveryAnchors, shouldPauseMultiPoint } from "../anchor-propagation";
import { createMultiPointTracker } from "../multi-tracker";
import type { PointSeed } from "@subpixel/contracts";

const candidate = (overrides: Partial<NaturalCandidate> = {}): NaturalCandidate => ({
  x: 50, y: 60, cornerStrength: 0.9, textureEntropy: 0.8, descriptorUniqueness: 0.85, boundaryDistance: 0.9, ...overrides
});

describe("multi-point primitives", () => {
  it("scores natural candidates and snaps within the default 12 px radius", () => {
    expect(scoreNaturalCandidate(candidate())).toBeGreaterThan(0.8);
    const snap = chooseSnapCandidate({ x: 48, y: 61 }, [candidate(), candidate({ x: 90, y: 90, cornerStrength: 1 })]);
    expect(snap.point).toEqual({ x: 50, y: 60 });
    expect(snap.score).toBeGreaterThan(0);
    expect(chooseSnapCandidate({ x: 0, y: 0 }, [candidate()]).snapped).toBe(false);
  });

  it("rejects natural identity when any strict matching gate fails", async () => {
    const { sampsonError, validateNaturalMatch } = await import("../natural-features");
    expect(validateNaturalMatch({ forwardBackwardError: 1, ncc: 0.8, epipolarError: 1, loweRatio: 0.7 }).accepted).toBe(true);
    expect(validateNaturalMatch({ forwardBackwardError: 1.6, ncc: 0.8, epipolarError: 1, loweRatio: 0.7 }).accepted).toBe(false);
    expect(validateNaturalMatch({ forwardBackwardError: 1, ncc: 0.8, epipolarError: 1, loweRatio: 0.8 }).reason).toContain("Lowe");
    expect(validateNaturalMatch({ forwardBackwardError: 1, ncc: 0.8 }).accepted).toBe(true);
    const horizontalEpipolarGeometry = [0, 0, 0, 0, 0, -1, 0, 1, 0];
    expect(sampsonError({ x: 12, y: 20 }, { x: 40, y: 20 }, horizontalEpipolarGeometry)).toBeCloseTo(0, 8);
    expect(sampsonError({ x: 12, y: 20 }, { x: 40, y: 24 }, horizontalEpipolarGeometry)).toBeGreaterThan(2);
  });

  it("does not silently accept a natural observation without identity metrics", () => {
    const seed: PointSeed = { pointId: "p-001", click: { x: 10, y: 10 }, snapped: { x: 10, y: 10 }, roi: { x: 4, y: 4, width: 13, height: 13 }, groupId: "natural", candidateScore: .9, model: "natural-keypoint" };
    const tracker = createMultiPointTracker([seed]); tracker.initialize();
    const result = tracker.process([{ pointId: seed.pointId, predicted: seed.snapped, refined: seed.snapped, confidence: .9, residual: .1 }]);
    expect(result.tracks[0].pointId).toBe(seed.pointId);
    expect(result.tracks[0].state).toBe("suspect");
  });

  it("pauses when suspect and lost points together reach twenty percent", () => {
    const seeds: PointSeed[] = Array.from({ length: 5 }, (_, index) => ({
      pointId: `p-${index}`,
      click: { x: index * 10, y: 10 },
      snapped: { x: index * 10, y: 10 },
      roi: { x: index * 10, y: 5, width: 9, height: 9 },
      groupId: "natural",
      candidateScore: .9,
      model: "natural-keypoint"
    }));
    const tracker = createMultiPointTracker(seeds); tracker.initialize();
    const result = tracker.process(seeds.map((item, index) => ({
      pointId: item.pointId,
      predicted: item.snapped,
      refined: item.snapped,
      confidence: .9,
      residual: .1,
      metrics: { forwardBackwardError: index === 0 ? 2 : .5, ncc: .9, epipolarError: 1, loweRatio: .6 }
    })));

    expect(result.tracks[0].state).toBe("suspect");
    expect(result.paused).toBe(true);
  });

  it("keeps successful point observations as provisional when registration only has a soft quality failure", () => {
    const seeds: PointSeed[] = Array.from({ length: 5 }, (_, index) => ({
      pointId: `p-${index}`,
      click: { x: index * 20, y: index * 15 },
      snapped: { x: index * 20, y: index * 15 },
      roi: { x: index * 20, y: index * 15, width: 12, height: 12 },
      groupId: "markers",
      candidateScore: .9,
      model: "circle"
    }));
    const tracker = createMultiPointTracker(seeds);
    tracker.initialize();
    const result = tracker.process(seeds.map(item => ({
      pointId: item.pointId,
      predicted: item.snapped,
      refined: { x: item.snapped.x + .25, y: item.snapped.y - .1 },
      confidence: .95,
      residual: .08
    })), 33, {
      decision: "provisional",
      failureClass: "soft-quality",
      usableForPrediction: true,
      matchCount: 62,
      inlierRatio: .76,
      medianReprojectionError: .42
    });

    expect(result.paused).toBe(false);
    expect(result.tracks.every(track => track.state === "provisional")).toBe(true);
    expect(result.tracks.every(track => track.pointGatePassed)).toBe(true);
    const next = tracker.process([], 66, undefined, { pauseOnHardFailure: false, pauseOnInvalidRatio: false });
    expect(next.tracks[0].predicted).toEqual(result.tracks[0].refined);
  });

  it("pauses for a hard rejected registration even when summary metrics look acceptable", () => {
    const seeds: PointSeed[] = Array.from({ length: 5 }, (_, index) => ({
      pointId: `p-${index}`,
      click: { x: index * 20, y: index * 15 },
      snapped: { x: index * 20, y: index * 15 },
      roi: { x: index * 20, y: index * 15, width: 12, height: 12 },
      groupId: "markers",
      candidateScore: .9,
      model: "circle"
    }));
    const tracker = createMultiPointTracker(seeds);
    tracker.initialize();
    const result = tracker.process(seeds.map(item => ({
      pointId: item.pointId,
      predicted: item.snapped,
      refined: { x: item.snapped.x + 50, y: item.snapped.y + 25 },
      confidence: .95,
      residual: .1
    })), 33, {
      decision: "rejected",
      failureClass: "hard-geometry",
      usableForPrediction: false,
      accepted: false,
      matchCount: 120,
      inlierRatio: .8,
      medianReprojectionError: .5
    });

    expect(result.paused).toBe(true);
    expect(result.tracks.every(track => track.state === "lost" && track.missingReason === "registration-hard-failure")).toBe(true);
    const snapshot = tracker.snapshot();
    expect(snapshot.positions).toEqual(seeds.map(seed => [seed.pointId, seed.snapped]));
  });

  it("preserves descriptor distance on a gated natural track", () => {
    const seed: PointSeed = { pointId: "p-001", click: { x: 10, y: 10 }, snapped: { x: 10, y: 10 }, roi: { x: 4, y: 4, width: 13, height: 13 }, groupId: "natural", candidateScore: .9, model: "natural-keypoint" };
    const tracker = createMultiPointTracker([seed]); tracker.initialize();
    const result = tracker.process([{ pointId: seed.pointId, predicted: seed.snapped, refined: { x: 42, y: 35 }, confidence: .9, residual: .1, relocationMethod: "sift", metrics: { forwardBackwardError: .4, ncc: .82, epipolarError: 1, loweRatio: .6, descriptorDistance: 18 } }]);
    expect(result.tracks[0].pointId).toBe(seed.pointId);
    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].descriptorDistance).toBe(18);
  });

  it("propagates points through a local affine fit from reliable anchors", () => {
    const result = applyLocalAffine({ x: 10, y: 20 }, [
      { reference: { x: 0, y: 0 }, current: { x: 5, y: 7 }, reliable: true },
      { reference: { x: 10, y: 0 }, current: { x: 15, y: 7 }, reliable: true },
      { reference: { x: 0, y: 10 }, current: { x: 5, y: 17 }, reliable: true },
      { reference: { x: 20, y: 20 }, current: { x: 25, y: 27 }, reliable: true }
    ]);
    expect(result.accepted).toBe(true);
    expect(result.point.x).toBeCloseTo(15, 4);
    expect(result.point.y).toBeCloseTo(27, 4);
  });

  it("rejects collinear or low-coverage recovery anchors and pauses at 20% loss", () => {
    expect(evaluateRecoveryAnchors([
      { reference: { x: 0, y: 0 }, current: { x: 1, y: 1 } },
      { reference: { x: 10, y: 0 }, current: { x: 11, y: 1 } },
      { reference: { x: 20, y: 0 }, current: { x: 21, y: 1 } },
      { reference: { x: 30, y: 0 }, current: { x: 31, y: 1 } }
    ], { width: 100, height: 100 }).accepted).toBe(false);
    expect(shouldPauseMultiPoint({ total: 10, lost: 2, matchCount: 100, inlierRatio: 0.9, medianReprojectionError: 1 })).toBe(true);
    expect(shouldPauseMultiPoint({ total: 10, lost: 1, matchCount: 100, inlierRatio: 0.9, medianReprojectionError: 1 })).toBe(false);
  });

  it("accepts unordered recovery anchors when their convex hull covers the scene", () => {
    const anchors = [
      { reference: { x: 90, y: 90 }, current: { x: 94, y: 95 } },
      { reference: { x: 10, y: 10 }, current: { x: 14, y: 15 } },
      { reference: { x: 10, y: 90 }, current: { x: 14, y: 95 } },
      { reference: { x: 90, y: 10 }, current: { x: 94, y: 15 } }
    ];
    expect(evaluateRecoveryAnchors(anchors, { width: 100, height: 100 }).accepted).toBe(true);
  });

  it("restores positions, frame counter, and paused state from a recovery snapshot", () => {
    const point: PointSeed = { pointId: "p-001", click: { x: 10, y: 10 }, snapped: { x: 10, y: 10 }, roi: { x: 4, y: 4, width: 13, height: 13 }, groupId: "target", candidateScore: .9, model: "blob" };
    const tracker = createMultiPointTracker([point]);
    tracker.initialize();
    tracker.process([]);
    const snapshot = tracker.snapshot();
    tracker.applyAnchors([
      { reference: { x: 0, y: 0 }, current: { x: 20, y: 30 } },
      { reference: { x: 20, y: 0 }, current: { x: 40, y: 30 } },
      { reference: { x: 0, y: 20 }, current: { x: 20, y: 50 } }
    ]);
    expect(tracker.paused).toBe(false);

    tracker.restore(snapshot);

    expect(tracker.paused).toBe(true);
    expect(tracker.snapshot()).toEqual(snapshot);
  });

  it("locates a translated template at subpixel precision using real pixel values", () => {
    const search = { width: 17, height: 17, data: new Float32Array(17 * 17) };
    for (let y = 0; y < 17; y += 1) for (let x = 0; x < 17; x += 1) search.data[y * 17 + x] = Math.exp(-((x - 10) ** 2 + (y - 8) ** 2) / 5) * 255;
    const template = { width: 7, height: 7, data: new Float32Array(49) };
    for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) template.data[y * 7 + x] = Math.exp(-((x - 3) ** 2 + (y - 3) ** 2) / 5) * 255;
    const match = matchTemplateNcc(search, template);
    expect(match.x).toBeCloseTo(10, 1);
    expect(match.y).toBeCloseTo(8, 1);
    expect(match.ncc).toBeGreaterThan(.99);
  });
});
