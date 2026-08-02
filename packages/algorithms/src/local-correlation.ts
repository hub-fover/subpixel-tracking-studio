import type { GrayPatch } from "./types";

export type CorrelationMatch = { x: number; y: number; ncc: number; residual: number };

function parabolic(left: number, center: number, right: number) {
  const denominator = left - 2 * center + right;
  return Math.abs(denominator) < 1e-8 ? 0 : Math.max(-.5, Math.min(.5, .5 * (left - right) / denominator));
}

export function matchTemplateNcc(search: GrayPatch, template: GrayPatch): CorrelationMatch {
  if (template.width > search.width || template.height > search.height) throw new Error("template must fit inside search patch");
  const count = template.width * template.height;
  let templateMean = 0;
  for (const value of template.data) templateMean += value;
  templateMean /= count;
  let templateVariance = 0;
  for (const value of template.data) templateVariance += (value - templateMean) ** 2;
  const scoreWidth = search.width - template.width + 1; const scoreHeight = search.height - template.height + 1;
  const scores = new Float32Array(scoreWidth * scoreHeight); scores.fill(-1);
  let bestX = 0; let bestY = 0; let best = -1;
  for (let offsetY = 0; offsetY < scoreHeight; offsetY += 1) for (let offsetX = 0; offsetX < scoreWidth; offsetX += 1) {
    let mean = 0;
    for (let y = 0; y < template.height; y += 1) for (let x = 0; x < template.width; x += 1) mean += search.data[(offsetY + y) * search.width + offsetX + x];
    mean /= count;
    let covariance = 0; let variance = 0;
    for (let y = 0; y < template.height; y += 1) for (let x = 0; x < template.width; x += 1) { const current = search.data[(offsetY + y) * search.width + offsetX + x] - mean; const reference = template.data[y * template.width + x] - templateMean; covariance += current * reference; variance += current * current; }
    const score = covariance / Math.max(1e-12, Math.sqrt(variance * templateVariance)); scores[offsetY * scoreWidth + offsetX] = score;
    if (score > best) { best = score; bestX = offsetX; bestY = offsetY; }
  }
  const at = (x: number, y: number) => scores[y * scoreWidth + x];
  const dx = bestX > 0 && bestX < scoreWidth - 1 ? parabolic(at(bestX - 1, bestY), best, at(bestX + 1, bestY)) : 0;
  const dy = bestY > 0 && bestY < scoreHeight - 1 ? parabolic(at(bestX, bestY - 1), best, at(bestX, bestY + 1)) : 0;
  return { x: bestX + dx + (template.width - 1) / 2, y: bestY + dy + (template.height - 1) / 2, ncc: best, residual: Math.max(0, 1 - best) };
}
