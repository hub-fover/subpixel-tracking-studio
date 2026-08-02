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

function ringPatch(width = 61, height = 61, cx = 30.35, cy = 29.65) : GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - cx, y - cy);
    data[y * width + x] = distance >= 15 && distance <= 21 ? 245 : 12;
  }
  return { width, height, data };
}

function texturedAdjacentCirclePatch(width = 89, height = 100, cx = 44.35, cy = 49.65, radius = 34): GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const texture = 54 + 22 * Math.sin(x * 1.31) + 17 * Math.cos(y * .83) + 13 * Math.sin((x + y) * .47);
    const targetDistance = Math.hypot(x - cx, y - cy);
    const neighborDistance = Math.hypot(x - 115, y - 50);
    data[y * width + x] = targetDistance <= radius ? 190 + 8 * Math.cos(x * .17) : neighborDistance <= 34 ? 205 : texture;
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

  it("accepts both edges of a thick circular ring without inflating residual", () => {
    const result = refineLocalPatch(ringPatch(), "circle-center", { x: 80, y: 120, width: 61, height: 61 });
    expect(result.accepted).toBe(true);
    expect(result.point).not.toBeNull();
    expect(result.residualPx).not.toBeNull();
    expect(result.residualPx!).toBeLessThanOrEqual(Math.max(.75, .02 * 36));
    expect(result.point!.x).toBeCloseTo(110.35, 0);
    expect(result.point!.y).toBeCloseTo(149.65, 0);
  });

  it("isolates the centered circle from textured background and an adjacent circle", () => {
    const result = refineLocalPatch(texturedAdjacentCirclePatch(), "circle-center", { x: 1800, y: 4300, width: 89, height: 100 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.point).not.toBeNull();
    expect(result.point!.x).toBeCloseTo(1844.35, 0);
    expect(result.point!.y).toBeCloseTo(4349.65, 0);
    expect(result.geometry?.kind).toBe("ellipse");
    expect(result.residualPx).not.toBeNull();
    expect(result.residualPx!).toBeLessThanOrEqual(.75);
  });

  it("refines a large native-pixel ROI without exceeding the JavaScript argument limit", () => {
    const patch = circlePatch(512, 512, 256.35, 255.65, 96);
    expect(() => refineLocalPatch(patch, "circle-center", { x: 0, y: 0, width: 512, height: 512 })).not.toThrow();
  });
});
