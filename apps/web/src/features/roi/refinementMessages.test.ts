import { describe, expect, it } from "vitest";
import { refinementReasonMessage } from "./refinementMessages";

describe("refinement messages", () => {
  it("turns a residual gate code into an actionable circle ROI instruction", () => {
    expect(refinementReasonMessage("residual", "circle-center")).toContain("避免包含相邻圆");
    expect(refinementReasonMessage("residual", "circle-center")).toContain("缩小 ROI");
  });

  it("does not describe a crosshair residual as a circle failure", () => {
    const message = refinementReasonMessage("residual", "crosshair-center");
    expect(message).toContain("多个交点");
    expect(message).not.toContain("圆轮廓");
  });

  it("keeps an unknown diagnostic available instead of hiding it", () => {
    expect(refinementReasonMessage("custom-gate")).toContain("custom-gate");
  });
});
