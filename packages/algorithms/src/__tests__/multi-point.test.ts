import { describe, expect, it } from "vitest";
import { chooseSnapCandidate, scoreNaturalCandidate, type NaturalCandidate } from "../natural-features";
import { matchTemplateNcc } from "../local-correlation";
import { applyLocalAffine, evaluateRecoveryAnchors, shouldPauseMultiPoint } from "../anchor-propagation";

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
    const { validateNaturalMatch } = await import("../natural-features");
    expect(validateNaturalMatch({ forwardBackwardError: 1, ncc: 0.8, epipolarError: 1, loweRatio: 0.7 }).accepted).toBe(true);
    expect(validateNaturalMatch({ forwardBackwardError: 1.6, ncc: 0.8, epipolarError: 1, loweRatio: 0.7 }).accepted).toBe(false);
    expect(validateNaturalMatch({ forwardBackwardError: 1, ncc: 0.8, epipolarError: 1, loweRatio: 0.8 }).reason).toContain("Lowe");
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
