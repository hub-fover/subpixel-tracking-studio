import { describe, expect, it } from "vitest";
import { refinementReasonMessage } from "./refinementMessages";

describe("refinement messages", () => {
  it("turns a residual gate code into an actionable circle ROI instruction", () => {
    expect(refinementReasonMessage("residual")).toContain("避免包含相邻圆");
    expect(refinementReasonMessage("residual")).toContain("缩小 ROI");
  });

  it("keeps an unknown diagnostic available instead of hiding it", () => {
    expect(refinementReasonMessage("custom-gate")).toContain("custom-gate");
  });
});
