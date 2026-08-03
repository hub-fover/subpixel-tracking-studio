import type { RiskNotice } from "@subpixel/contracts";

export type RiskDescriptor = Pick<RiskNotice, "code" | "severity" | "message" | "action" | "recoverable">;

export function trackingGateRisk(pointId: string, failures: string[]): RiskDescriptor {
  if (failures.some(failure => failure.includes("ambiguous") || failure === "uniqueness")) {
    return { code: "tracking.marker-ambiguous", severity: "error", message: `${pointId} 的标志候选不唯一，已禁止自动换绑`, action: "select-anchors", recoverable: true };
  }
  if (failures.includes("tracking.local-affine-degenerate")) {
    return { code: "tracking.local-affine-degenerate", severity: "warning", message: `${pointId} 附近锚点共线或覆盖不足，局部仿射已拒绝`, action: "select-anchors", recoverable: true };
  }
  return { code: "tracking.identity-gate-failed", severity: "warning", message: `${pointId} 身份门控失败，位置和模板未更新`, action: "select-anchors", recoverable: true };
}

export function registrationRisk(reason: string | null | undefined): RiskDescriptor {
  if (reason === "registration.transform-inconsistent") {
    return { code: "registration.transform-inconsistent", severity: "error", message: "直接配准与相邻帧组合变换不一致，已暂停防止跟偏", action: "select-anchors", recoverable: true };
  }
  if (reason === "registration.degraded-large-motion") {
    return { code: "tracking.manual-anchors-required", severity: "error", message: "OpenCV 未就绪且检测到大运动，需要重新选择 4–6 个锚点", action: "select-anchors", recoverable: true };
  }
  return { code: "registration.rejected", severity: "error", message: `场景配准未通过：${reason ?? "质量门控失败"}`, action: "select-anchors", recoverable: true };
}
