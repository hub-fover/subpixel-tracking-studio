import { describe, expect, it } from "vitest";
import { circleModel, crosshairModel, snapCooperativeCenter } from "../feature-models";
import { makeCirclePatch } from "../fixtures";

describe("feature models", () => {
  it("fits a synthetic circle within 0.1 px", () => {
    const result = circleModel.refineSubpixel(makeCirclePatch({ center: { x: 16.35, y: 15.7 }, radius: 6 }));
    expect(Math.hypot(result.x - 16.35, result.y - 15.7)).toBeLessThanOrEqual(0.1);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.residual).toBeGreaterThan(0);
  });

  it("finds a crosshair intersection near the image center", () => {
    const width = 33; const height = 33; const data = new Float32Array(width * height);
    for (let index = 0; index < width; index += 1) { data[16 * width + index] = 1; data[index * width + 16] = 1; }
    const result = crosshairModel.refineSubpixel({ width, height, data });
    expect(Math.hypot(result.x - 16, result.y - 16)).toBeLessThanOrEqual(1);
  });

  it("snaps a manually selected cooperative ROI to its model center", () => {
    const result = snapCooperativeCenter(makeCirclePatch({ center: { x: 14.35, y: 13.7 }, radius: 6 }), "circle");
    expect(Math.hypot(result.x - 14.35, result.y - 13.7)).toBeLessThanOrEqual(.1);
    expect(result.snapped).toBe(true);
  });

  it("uses the clicked filled-circle component instead of textured background", () => {
    const width = 41; const height = 41; const data = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = .15 + (x % 5 === 0 ? .5 : 0);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (Math.hypot(x - 15.4, y - 18.2) <= 11) data[y * width + x] = 1;
    const result = snapCooperativeCenter({ width, height, data }, "circle");
    expect(Math.hypot(result.x - 15.4, result.y - 18.2)).toBeLessThan(.5);
  });
});
