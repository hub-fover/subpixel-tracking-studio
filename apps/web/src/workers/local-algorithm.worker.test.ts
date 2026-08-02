import { describe, expect, it } from "vitest";
import { handleLocalCommand } from "./local-algorithm.worker";

describe("local algorithm worker protocol", () => {
  it("refines a native grayscale ROI without a network request", () => {
    const data = new Float32Array(25 * 25).fill(10);
    for (let y = 6; y < 19; y += 1) for (let x = 6; x < 19; x += 1) data[y * 25 + x] = 240;
    const response = handleLocalCommand({ type: "refine", requestId: 7, frame: { frame: 0, timestampMs: 0, width: 25, height: 25, source: "image" }, patch: { width: 25, height: 25, data }, roi: { x: 100, y: 200, width: 25, height: 25 }, intent: "circle-center" });
    expect(response.type).toBe("refinement");
    if (response.type === "refinement") { expect(response.requestId).toBe(7); expect(response.result.roi.x).toBe(100); }
  });
});
