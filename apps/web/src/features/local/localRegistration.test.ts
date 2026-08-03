import { describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { classifyRegistrationQuality, composeRegistrationGuidance, composeRegistrationTransforms, reconcileRegistrationGuidance, registerAdjacentPatches, registerLocalPatches, validateProjectedFrame } from "./localRegistration";

function translatedPatch(dx: number, dy: number): { reference: GrayPatch; current: GrayPatch } {
  const width = 64; const height = 48; const reference = new Float32Array(width * height); const current = new Float32Array(width * height);
  for (let y = 4; y < height - 4; y += 1) for (let x = 4; x < width - 4; x += 1) {
    const value = (x * x * 13 + y * y * 7 + x * y * 17 + x * 31 + y * 19) % 251;
    reference[y * width + x] = value;
    const tx = x + dx; const ty = y + dy;
    if (tx >= 0 && tx < width && ty >= 0 && ty < height) current[ty * width + tx] = value;
  }
  return { reference: { width, height, data: reference }, current: { width, height, data: current } };
}

describe("local registration", () => {
  it("classifies 9.6 percent coverage with otherwise strong geometry as provisional", () => {
    const result = classifyRegistrationQuality({
      matchCount: 64,
      inlierCount: 50,
      inlierRatio: .78125,
      medianSymmetricTransferError: .43,
      inlierCoverage: .096,
      transformConsistencyError: 1.1,
      hasFiniteInvertibleTransform: true,
      projectedFrameAccepted: true
    });

    expect(result).toEqual({
      decision: "provisional",
      usableForPrediction: true,
      failureClass: "soft-quality",
      reason: "registration.low-coverage"
    });
  });

  it("hard-rejects singular geometry regardless of matching quality", () => {
    expect(classifyRegistrationQuality({
      matchCount: 120,
      inlierCount: 100,
      inlierRatio: .83,
      medianSymmetricTransferError: .4,
      inlierCoverage: .4,
      transformConsistencyError: 1,
      hasFiniteInvertibleTransform: false,
      projectedFrameAccepted: true
    })).toMatchObject({ decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry" });
  });

  it("estimates native-pixel translation and returns a homography", () => {
    const patches = translatedPatch(5, -3);
    const result = registerLocalPatches(patches.reference, patches.current, 2);
    expect(result).toMatchObject({ accepted: false, decision: "provisional", usableForPrediction: true, failureClass: "engine-unavailable" });
    expect(result.method).toBe("translation-fallback");
    expect(result.reprojectionErrorSemantics).toBe("not-available");
    expect(result.medianSymmetricTransferError).toBeNull();
    expect(result.transform?.matrix[2]).toBeCloseTo(5, 0);
    expect(result.transform?.matrix[5]).toBeCloseTo(-3, 0);
  });

  it("composes adjacent transforms in source-to-target order", () => {
    const sourceToMiddle = [1, 0, 5, 0, 1, -3, 0, 0, 1];
    const middleToTarget = [2, 0, 7, 0, 2, 4, 0, 0, 1];
    expect(composeRegistrationTransforms(sourceToMiddle, middleToTarget)).toEqual([2, 0, 17, 0, 2, -2, 0, 0, 1]);
  });

  it("rejects a direct registration that disagrees with the adjacent chain", () => {
    const base = {
      frame: 5, sourceFrame: 0, targetFrame: 5, method: "sift-homography" as const,
      matchCount: 100, inlierCount: 80, inlierRatio: .8, medianReprojectionError: 1,
      accepted: true, transform: { kind: "homography" as const, matrix: [1, 0, 20, 0, 1, 0, 0, 0, 1] }
    };
    const consistent = reconcileRegistrationGuidance(base, { ...base, method: "adjacent-flow", transform: { kind: "homography", matrix: [1, 0, 22, 0, 1, 0, 0, 0, 1] } }, { width: 1000, height: 800 });
    expect(consistent.accepted).toBe(true);
    expect(consistent.transformConsistencyError).toBeCloseTo(2, 6);
    const inconsistent = reconcileRegistrationGuidance(base, { ...base, method: "adjacent-flow", transform: { kind: "homography", matrix: [1, 0, 30, 0, 1, 0, 0, 0, 1] } }, { width: 1000, height: 800 });
    expect(inconsistent).toMatchObject({ accepted: false, reason: "registration.transform-inconsistent" });
    expect(inconsistent.transformConsistencyError).toBeCloseTo(10, 6);
  });

  it("rejects homographies whose projective denominator crosses the image", () => {
    expect(validateProjectedFrame([1, 0, 5, 0, 1, 7, 0, 0, 1], { width: 100, height: 80 }).accepted).toBe(true);
    expect(validateProjectedFrame([1, 0, 0, 0, 1, 0, .02, 0, -1], { width: 100, height: 80 })).toMatchObject({ accepted: false, reason: "registration.invalid-projected-frame" });
  });

  it("estimates adjacent native-pixel flow from spatially distributed points", () => {
    const patches = translatedPatch(5, -3);
    const result = registerAdjacentPatches(patches.reference, patches.current, 2, 1);
    expect(result).toMatchObject({ sourceFrame: 1, targetFrame: 2, method: "adjacent-flow", accepted: true });
    expect(result.matchCount).toBeGreaterThanOrEqual(50);
    expect(result.transform?.matrix[2]).toBeCloseTo(5, 0);
    expect(result.transform?.matrix[5]).toBeCloseTo(-3, 0);
    expect(result.reprojectionErrorSemantics).toBe("pixel-reprojection");
  });

  it("composes only contiguous accepted adjacent guidance", () => {
    const first = { frame: 1, sourceFrame: 0, targetFrame: 1, method: "adjacent-flow" as const, matchCount: 60, inlierCount: 55, inlierRatio: .9, medianReprojectionError: .4, accepted: true, transform: { kind: "affine" as const, matrix: [1, 0, 5, 0, 1, 0, 0, 0, 1] } };
    const second = { ...first, frame: 2, sourceFrame: 1, targetFrame: 2, transform: { kind: "affine" as const, matrix: [1, 0, 7, 0, 1, 0, 0, 0, 1] } };
    const composed = composeRegistrationGuidance(first, second);
    expect(composed).toMatchObject({ sourceFrame: 0, targetFrame: 2, method: "adjacent-flow", accepted: true });
    expect(composed?.transform?.matrix[2]).toBeCloseTo(12, 6);
    expect(composeRegistrationGuidance(first, { ...second, sourceFrame: 3 })).toBeUndefined();
  });
});
