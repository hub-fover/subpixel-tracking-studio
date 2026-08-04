import type { FrameRegistration, MultiPointTrack } from "@subpixel/contracts";

export type AlertSensitivity = "high" | "standard" | "low" | "custom";
export type AlertSettings = {
  sensitivity: AlertSensitivity;
  pointQualityWarning: number;
  registrationErrorWarningPx: number;
  pauseInvalidRatio: number;
};

export const ALERT_PROFILES: Record<Exclude<AlertSensitivity, "custom">, AlertSettings> = {
  high: { sensitivity: "high", pointQualityWarning: .5, registrationErrorWarningPx: 2, pauseInvalidRatio: .15 },
  standard: { sensitivity: "standard", pointQualityWarning: .35, registrationErrorWarningPx: 3, pauseInvalidRatio: .2 },
  low: { sensitivity: "low", pointQualityWarning: .2, registrationErrorWarningPx: 6, pauseInvalidRatio: .35 }
};

export const DEFAULT_ALERT_SETTINGS = ALERT_PROFILES.standard;

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

export function normalizeAlertSettings(input?: Partial<AlertSettings>): AlertSettings {
  const sensitivity = input?.sensitivity && ["high", "standard", "low", "custom"].includes(input.sensitivity) ? input.sensitivity : "standard";
  const base = sensitivity === "custom" ? DEFAULT_ALERT_SETTINGS : ALERT_PROFILES[sensitivity];
  return {
    sensitivity,
    pointQualityWarning: clamp(input?.pointQualityWarning ?? base.pointQualityWarning, .1, .8),
    registrationErrorWarningPx: clamp(input?.registrationErrorWarningPx ?? base.registrationErrorWarningPx, 1, 10),
    pauseInvalidRatio: clamp(input?.pauseInvalidRatio ?? base.pauseInvalidRatio, .1, .6)
  };
}

export function shouldWarnForTrack(track: MultiPointTrack, settings: AlertSettings) {
  if (track.state === "lost" || track.state === "paused") return true;
  if (track.state !== "suspect") return false;
  if (track.gateFailures.some(failure => failure.includes("ambiguous") || failure === "uniqueness")) return true;
  if (settings.sensitivity === "high") return true;
  if (settings.sensitivity === "low") return track.confidence < settings.pointQualityWarning && track.gateFailures.length > 1;
  return track.confidence < settings.pointQualityWarning || track.gateFailures.length > 1;
}

export function shouldWarnForRegistration(registration: FrameRegistration, settings: AlertSettings) {
  if (registration.reason === "registration.transform-inconsistent" || registration.reason === "registration.degraded-large-motion") return true;
  if (registration.failureClass === "hard-geometry" || registration.failureClass === "engine-unavailable") return true;
  if (settings.sensitivity === "high") return true;
  const error = registration.medianSymmetricTransferError ?? registration.medianReprojectionError;
  if (!Number.isFinite(error)) return settings.sensitivity !== "low";
  return error > settings.registrationErrorWarningPx;
}

export function loadAlertSettings(storage: Pick<Storage, "getItem"> | undefined): AlertSettings {
  if (!storage) return DEFAULT_ALERT_SETTINGS;
  try { return normalizeAlertSettings(JSON.parse(storage.getItem("subpixel.alert-settings.v1") ?? "{}")); }
  catch { return DEFAULT_ALERT_SETTINGS; }
}

export function saveAlertSettings(storage: Pick<Storage, "setItem"> | undefined, settings: AlertSettings) {
  try { storage?.setItem("subpixel.alert-settings.v1", JSON.stringify(settings)); }
  catch { /* Local preferences are optional. */ }
}
