import type { FeatureModel, FeatureResult, GrayPatch, FeatureType } from "./types";

function weightedCenter(patch: GrayPatch, transform = (v: number) => Math.max(0, v)): FeatureResult {
  let sum = 0; let xSum = 0; let ySum = 0; let peak = 0;
  for (let y = 0; y < patch.height; y += 1) for (let x = 0; x < patch.width; x += 1) {
    const value = transform(patch.data[y * patch.width + x]); sum += value; xSum += x * value; ySum += y * value; peak = Math.max(peak, value);
  }
  if (sum <= Number.EPSILON) return { x: patch.width / 2, y: patch.height / 2, residual: 1, confidence: 0, metrics: { peak: 0 } };
  const x = xSum / sum; const y = ySum / sum;
  let radialSum = 0;
  for (let yy = 0; yy < patch.height; yy += 1) for (let xx = 0; xx < patch.width; xx += 1) radialSum += Math.hypot(xx - x, yy - y) * transform(patch.data[yy * patch.width + xx]);
  const radius = radialSum / sum;
  let variance = 0;
  for (let yy = 0; yy < patch.height; yy += 1) for (let xx = 0; xx < patch.width; xx += 1) {
    const weight = transform(patch.data[yy * patch.width + xx]);
    variance += (Math.hypot(xx - x, yy - y) - radius) ** 2 * weight;
  }
  const residual = Math.sqrt(variance / sum) / Math.max(1, radius);
  return { x, y, residual, confidence: Math.min(1, peak / (peak + 0.25)) * Math.max(0, 1 - residual), metrics: { peak, mass: sum, radius } };
}

function model(type: FeatureType, transform?: (v: number) => number): FeatureModel {
  return { type, detectInitial: patch => weightedCenter(patch, transform), refineSubpixel: patch => weightedCenter(patch, transform ?? (v => Math.max(0, v))) };
}

function subpixelPeak(values: number[]) {
  let index = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[index]) index = i;
  const threshold = values[index] * 0.8;
  let weightedIndex = 0; let weight = 0;
  values.forEach((value, position) => { if (value >= threshold) { weightedIndex += position * value; weight += value; } });
  if (weight && values.filter(value => value >= threshold).length > 1) return weightedIndex / weight;
  if (index === 0 || index === values.length - 1) return index;
  const left = values[index - 1]; const center = values[index]; const right = values[index + 1]; const denominator = left - 2 * center + right;
  return Math.abs(denominator) < 1e-8 ? index : index + 0.5 * (left - right) / denominator;
}

function lineIntersectionModel(type: "crosshair" | "diagonal", diagonal = false): FeatureModel {
  const refine = (patch: GrayPatch): FeatureResult => {
    const rows = Array.from({ length: patch.height }, () => 0); const columns = Array.from({ length: patch.width }, () => 0);
    for (let y = 1; y < patch.height - 1; y += 1) for (let x = 1; x < patch.width - 1; x += 1) {
      const gx = patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1]; const gy = patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x]; const weight = diagonal ? Math.abs(gx + gy) + Math.abs(gx - gy) : Math.abs(gx) + Math.abs(gy); rows[y] += weight; columns[x] += weight;
    }
    const x = subpixelPeak(columns); const y = subpixelPeak(rows); const peak = Math.max(...rows, ...columns); const mean = [...rows, ...columns].reduce((sum, value) => sum + value, 0) / (rows.length + columns.length); const confidence = peak ? Math.min(1, (peak - mean) / peak) : 0;
    return { x, y, residual: 1 - confidence, confidence, metrics: { directionalPeak: peak } };
  };
  return { type, detectInitial: refine, refineSubpixel: refine };
}

export const circleModel = model("circle", v => Math.max(0, v));
export const blobModel = model("blob", v => Math.max(0, v));
export const speckleModel = model("speckle", v => Math.max(0, v));
export const crosshairModel = lineIntersectionModel("crosshair");
export const diagonalModel = lineIntersectionModel("diagonal", true);
export const naturalKeypointModel = model("natural-keypoint", v => Math.max(0, v));
export const featureModels: Record<FeatureType, FeatureModel> = { circle: circleModel, blob: blobModel, speckle: speckleModel, crosshair: crosshairModel, diagonal: diagonalModel, "natural-keypoint": naturalKeypointModel };

export function snapCooperativeCenter(patch: GrayPatch, type: Exclude<FeatureType, "natural-keypoint">) {
  if (type === "circle") {
    const centerX = Math.floor(patch.width / 2); const centerY = Math.floor(patch.height / 2); const border: number[] = [];
    for (let x = 0; x < patch.width; x += 1) border.push(patch.data[x], patch.data[(patch.height - 1) * patch.width + x]);
    for (let y = 1; y < patch.height - 1; y += 1) border.push(patch.data[y * patch.width], patch.data[y * patch.width + patch.width - 1]);
    border.sort((a, b) => a - b); const background = border[Math.floor(border.length / 2)] ?? 0;
    let clicked = 0; let clickedCount = 0; for (let y = Math.max(0, centerY - 1); y <= Math.min(patch.height - 1, centerY + 1); y += 1) for (let x = Math.max(0, centerX - 1); x <= Math.min(patch.width - 1, centerX + 1); x += 1) { clicked += patch.data[y * patch.width + x]; clickedCount += 1; } clicked /= clickedCount;
    const range = Math.max(...patch.data) - Math.min(...patch.data); const polarity = Math.sign(clicked - background); const componentThreshold = (clicked + background) / 2;
    if (polarity && Math.abs(clicked - background) >= Math.max(1e-6, range * .12)) {
      const visited = new Uint8Array(patch.width * patch.height); const queue = [[centerX, centerY]]; let cursor = 0; let xSum = 0; let ySum = 0; let count = 0; let touchesBorder = false;
      while (cursor < queue.length) { const [x, y] = queue[cursor++]; const index = y * patch.width + x; if (visited[index]) continue; visited[index] = 1; const value = patch.data[index]; if (polarity > 0 ? value < componentThreshold : value > componentThreshold) continue; xSum += x; ySum += y; count += 1; if (x === 0 || y === 0 || x === patch.width - 1 || y === patch.height - 1) touchesBorder = true; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && x + dx >= 0 && x + dx < patch.width && y + dy >= 0 && y + dy < patch.height) queue.push([x + dx, y + dy]); }
      const fraction = count / (patch.width * patch.height); if (!touchesBorder && count >= 9 && fraction <= .65) return { x: xSum / count, y: ySum / count, residual: 0, confidence: Math.min(1, Math.abs(clicked - background) / Math.max(1e-8, range)), metrics: { componentArea: count }, snapped: true };
    }
    const gradients: { x: number; y: number; value: number }[] = [];
    for (let y = 1; y < patch.height - 1; y += 1) for (let x = 1; x < patch.width - 1; x += 1) { const gx = patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1]; const gy = patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x]; gradients.push({ x, y, value: Math.hypot(gx, gy) }); }
    const ordered = gradients.map(item => item.value).sort((a, b) => a - b); const edgeThreshold = ordered[Math.floor(ordered.length * .8)] ?? 0;
    let mass = 0; let xSum = 0; let ySum = 0; let peak = 0;
    for (const gradient of gradients) { const weight = Math.max(0, gradient.value - edgeThreshold); mass += weight; xSum += gradient.x * weight; ySum += gradient.y * weight; peak = Math.max(peak, gradient.value); }
    if (mass > 1e-8) return { x: xSum / mass, y: ySum / mass, residual: 1 / Math.max(1, peak), confidence: Math.min(1, peak / (peak + edgeThreshold + 1e-8)), metrics: { edgePeak: peak, edgeMass: mass }, snapped: true };
  }
  const result = featureModels[type].refineSubpixel(patch);
  return { ...result, snapped: result.confidence >= 0.2 && Number.isFinite(result.x) && Number.isFinite(result.y) };
}
