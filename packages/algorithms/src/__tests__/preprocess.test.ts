import { describe, expect, it } from "vitest";
import { normalizePatch } from "../preprocess";
import { makeCirclePatch } from "../fixtures";

describe("preprocess", () => {
  it("normalizes a patch around zero", () => {
    const patch = makeCirclePatch({ center: { x: 12.35, y: 11.7 }, radius: 5 });
    const normalized = normalizePatch(patch);
    const mean = normalized.data.reduce((a, b) => a + b, 0) / normalized.data.length;
    expect(mean).toBeCloseTo(0, 5);
  });
});
