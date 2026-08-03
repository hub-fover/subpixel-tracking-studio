import { describe, expect, it } from "vitest";
import { registrationRisk, trackingGateRisk } from "./riskNotice";

describe("local algorithm risk mapping", () => {
  it("explains marker ambiguity and local affine degeneracy in Chinese", () => {
    expect(trackingGateRisk("p-1", ["refinement.circle-ambiguous"])).toMatchObject({ code: "tracking.marker-ambiguous", action: "select-anchors" });
    expect(trackingGateRisk("p-1", ["refinement.circle-ambiguous"])?.message).toContain("候选不唯一");
    expect(trackingGateRisk("p-2", ["tracking.local-affine-degenerate"])).toMatchObject({ code: "tracking.local-affine-degenerate", action: "select-anchors" });
  });

  it("distinguishes transform inconsistency from generic registration rejection", () => {
    expect(registrationRisk("registration.transform-inconsistent")).toMatchObject({ code: "registration.transform-inconsistent", severity: "error", action: "select-anchors" });
    expect(registrationRisk("registration.degraded-large-motion")).toMatchObject({ code: "tracking.manual-anchors-required", severity: "error", action: "select-anchors" });
  });
});
