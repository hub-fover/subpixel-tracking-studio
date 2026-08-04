import { describe, expect, it } from "vitest";
import type { FrameRegistration, MultiPointTrack } from "@subpixel/contracts";
import { ALERT_PROFILES, loadAlertSettings, normalizeAlertSettings, saveAlertSettings, shouldWarnForRegistration, shouldWarnForTrack } from "./alertSettings";

const track = (overrides: Partial<MultiPointTrack> = {}): MultiPointTrack => ({
  pointId: "p-001", frame: 1, timestampMs: 1, predicted: { x: 1, y: 1 }, refined: { x: 1, y: 1 }, model: "circle",
  confidence: .65, residual: .1, flowErrorForwardBackward: null, ncc: null, descriptorDistance: null, epipolarError: null,
  predictionSource: "previous-position", innovationPx: 0, localAffineResidualPx: null, gateFailures: ["tracking.innovation-too-large"],
  candidateUniqueness: null, state: "suspect", relocationMethod: "feature-refine", ...overrides
});
const registration = (overrides: Partial<FrameRegistration> = {}): FrameRegistration => ({
  frame: 1, method: "sift-homography", matchCount: 30, inlierCount: 20, inlierRatio: .66,
  medianReprojectionError: 4, decision: "rejected", accepted: false, failureClass: "soft-quality", usableForPrediction: false,
  guidanceSource: "direct", reason: "registration.high-residual", ...overrides
});

describe("alert sensitivity settings", () => {
  it("uses profiles and clamps custom numeric thresholds", () => {
    expect(ALERT_PROFILES.low.pauseInvalidRatio).toBe(.35);
    expect(normalizeAlertSettings({ sensitivity: "custom", pointQualityWarning: 2, registrationErrorWarningPx: 0, pauseInvalidRatio: .9 })).toMatchObject({ pointQualityWarning: .8, registrationErrorWarningPx: 1, pauseInvalidRatio: .6 });
  });

  it("suppresses isolated high-confidence suspect warnings in standard and low modes", () => {
    expect(shouldWarnForTrack(track(), ALERT_PROFILES.high)).toBe(true);
    expect(shouldWarnForTrack(track(), ALERT_PROFILES.standard)).toBe(false);
    expect(shouldWarnForTrack(track(), ALERT_PROFILES.low)).toBe(false);
    expect(shouldWarnForTrack(track({ state: "lost" }), ALERT_PROFILES.low)).toBe(true);
    expect(shouldWarnForTrack(track({ gateFailures: ["refinement.circle-ambiguous"] }), ALERT_PROFILES.low)).toBe(true);
  });

  it("uses the configured registration error threshold but never hides hard geometry", () => {
    expect(shouldWarnForRegistration(registration(), ALERT_PROFILES.standard)).toBe(true);
    expect(shouldWarnForRegistration(registration(), ALERT_PROFILES.low)).toBe(false);
    expect(shouldWarnForRegistration(registration({ failureClass: "hard-geometry" }), ALERT_PROFILES.low)).toBe(true);
  });

  it("persists versioned settings and recovers from invalid storage", () => {
    let value = "";
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    saveAlertSettings(storage, ALERT_PROFILES.low);
    expect(loadAlertSettings(storage)).toEqual(ALERT_PROFILES.low);
    value = "not-json";
    expect(loadAlertSettings(storage).sensitivity).toBe("standard");
  });
});
