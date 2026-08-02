import { describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { refineLocalPatch } from "./localRefinement";

function circlePatch(width = 41, height = 41, cx = 20.35, cy = 19.65, radius = 10) : GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - cx, y - cy);
    data[y * width + x] = distance <= radius ? 255 : 12;
  }
  return { width, height, data };
}

describe("local refinement", () => {
  it("returns a gated original-coordinate circle center", () => {
    const result = refineLocalPatch(circlePatch(), "circle-center", { x: 100, y: 200, width: 41, height: 41 });
    expect(result.point).not.toBeNull();
    expect(result.geometry?.kind).toBe("ellipse");
    expect(result.accepted).toBe(true);
    expect(result.point!.x).toBeGreaterThan(118);
    expect(result.point!.x).toBeLessThan(122);
  });

  it("rejects an empty ROI instead of returning its center", () => {
    const result = refineLocalPatch({ width: 8, height: 8, data: new Float32Array(64) }, "circle-center", { x: 10, y: 20, width: 8, height: 8 });
    expect(result.accepted).toBe(false);
    expect(result.point).toBeNull();
  });
});
