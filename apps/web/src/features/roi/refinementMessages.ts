const messages: Record<string, string> = {
  residual: "圆轮廓残差过大。请缩小 ROI，避免包含相邻圆或背景纹理。",
  roiBoundary: "目标轮廓触碰 ROI 边界。请扩大或移动 ROI，让目标四周留出背景。",
  edgeCoverage: "有效轮廓覆盖不足。请调整 ROI，保留完整目标边缘。",
  edgePoints: "有效边缘点不足。请扩大 ROI 或选择对比度更清晰的目标。",
  "refinement.edge-points": "有效边缘点不足。请扩大 ROI 或选择对比度更清晰的目标。",
  axisRatio: "拟合轮廓过于扁平，无法确认圆或椭圆中心。请重新框选单个目标。",
  angle: "两组中心线夹角不合格。请重新框选完整十字丝或对角标志。",
  support1: "第一组线边缘支撑不足。请扩大 ROI 并保留完整线段。",
  support2: "第二组线边缘支撑不足。请扩大 ROI 并保留完整线段。",
  boundary: "角点距离 ROI 边界过近。请扩大或移动 ROI。",
  uniqueness: "ROI 内存在多个相似角点。请缩小 ROI，仅保留目标角点。",
  "refinement.invalid-roi": "ROI 尺寸或像素无效，请重新框选。",
  "refinement.line-support": "线边缘支撑不足。请扩大 ROI 并保留完整标志。",
  "refinement.line-angle": "未找到两组有效中心线。请调整 ROI 或提取类型。",
  "refinement.corner-candidate": "未找到可靠角点。请移动 ROI 到纹理清晰的位置。",
  "refinement.low-confidence": "目标对比度或唯一性不足，请重新框选。"
};

export function refinementReasonMessage(reason: string | null | undefined) {
  if (!reason) return "亚像素精修未通过质量门控，请调整 ROI。";
  return messages[reason] ?? `亚像素精修未通过：${reason}。请调整 ROI 后重试。`;
}
