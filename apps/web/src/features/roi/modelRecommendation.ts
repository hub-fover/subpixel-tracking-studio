import type { FeatureType, GrayPatch } from "@subpixel/algorithms";

export type ModelCandidate = { type: FeatureType; score: number; label: string };
const labels: Record<FeatureType, string> = { circle: "圆 / 圆环", blob: "光斑", crosshair: "十字丝", diagonal: "对角标志", speckle: "散斑", "natural-keypoint": "自然角点" };

export function recommendModels(patch: GrayPatch): ModelCandidate[] {
  if (!patch.data.length) return [];
  const mean = patch.data.reduce((sum, value) => sum + value, 0) / patch.data.length;
  const variance = patch.data.reduce((sum, value) => sum + (value - mean) ** 2, 0) / patch.data.length;
  let horizontal = 0; let vertical = 0; let diagonal = 0;
  for (let y = 1; y < patch.height; y += 1) for (let x = 1; x < patch.width; x += 1) { const here = patch.data[y * patch.width + x]; horizontal += Math.abs(here - patch.data[y * patch.width + x - 1]); vertical += Math.abs(here - patch.data[(y - 1) * patch.width + x]); diagonal += Math.abs(here - patch.data[(y - 1) * patch.width + x - 1]); }
  const energy = horizontal + vertical + diagonal || 1;
  const scores: Record<FeatureType, number> = { circle: 0.55 + Math.min(0.4, variance / 10000), blob: 0.5 + Math.min(0.35, Math.abs(mean) / 255), crosshair: 0.35 + Math.min(0.55, (horizontal + vertical) / energy), diagonal: 0.3 + Math.min(0.6, diagonal / energy), speckle: 0.25 + Math.min(0.7, variance / 5000), "natural-keypoint": 0.3 + Math.min(0.6, variance / 5000) };
  return (Object.keys(scores) as FeatureType[]).map(type => ({ type, score: Math.min(0.99, scores[type]), label: labels[type] })).sort((a, b) => b.score - a.score);
}
