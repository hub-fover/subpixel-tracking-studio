export type NaturalCandidate = {
  x: number;
  y: number;
  cornerStrength: number;
  textureEntropy: number;
  descriptorUniqueness: number;
  boundaryDistance: number;
  model?: "natural-keypoint";
};

export type SnapResult = { point: { x: number; y: number }; score: number; distance: number; snapped: boolean };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function scoreNaturalCandidate(candidate: NaturalCandidate): number {
  return clamp01(0.35 * clamp01(candidate.cornerStrength) + 0.25 * clamp01(candidate.textureEntropy) + 0.25 * clamp01(candidate.descriptorUniqueness) + 0.15 * clamp01(candidate.boundaryDistance));
}

export function chooseSnapCandidate(click: { x: number; y: number }, candidates: NaturalCandidate[], radiusPx = 12): SnapResult {
  let best: { candidate: NaturalCandidate; score: number; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - click.x, candidate.y - click.y);
    if (distance > radiusPx) continue;
    const score = scoreNaturalCandidate(candidate) * (1 - distance / Math.max(radiusPx, 1));
    if (!best || score > best.score) best = { candidate, score, distance };
  }
  if (!best) return { point: click, score: 0, distance: Infinity, snapped: false };
  return { point: { x: best.candidate.x, y: best.candidate.y }, score: best.score, distance: best.distance, snapped: true };
}

export type NaturalMatchMetrics = { forwardBackwardError: number; ncc: number; epipolarError?: number; loweRatio?: number };

export function sampsonError(reference: { x: number; y: number }, current: { x: number; y: number }, fundamentalMatrix: number[]): number {
  if (fundamentalMatrix.length !== 9 || fundamentalMatrix.some(value => !Number.isFinite(value))) return Infinity;
  const [f00, f01, f02, f10, f11, f12, f20, f21, f22] = fundamentalMatrix;
  const fx0 = f00 * reference.x + f01 * reference.y + f02;
  const fx1 = f10 * reference.x + f11 * reference.y + f12;
  const fx2 = f20 * reference.x + f21 * reference.y + f22;
  const ftx0 = f00 * current.x + f10 * current.y + f20;
  const ftx1 = f01 * current.x + f11 * current.y + f21;
  const numerator = current.x * fx0 + current.y * fx1 + fx2;
  const denominator = fx0 * fx0 + fx1 * fx1 + ftx0 * ftx0 + ftx1 * ftx1;
  return denominator > 1e-12 ? Math.abs(numerator) / Math.sqrt(denominator) : Infinity;
}

export function validateNaturalMatch(metrics: NaturalMatchMetrics) {
  const checks: [boolean, string][] = [
    [metrics.forwardBackwardError <= 1.5, "forward/backward flow"],
    [metrics.ncc >= 0.7, "NCC"],
    [metrics.epipolarError === undefined || metrics.epipolarError <= 2, "epipolar"],
    [metrics.loweRatio === undefined || metrics.loweRatio <= 0.75, "Lowe ratio"]
  ];
  const failed = checks.find(([accepted]) => !accepted);
  return { accepted: !failed, reason: failed ? `${failed[1]} gate failed` : undefined };
}

export type GrayImage = { width: number; height: number; data: Float32Array | Uint8Array };

/** Fast deterministic candidate extraction used by the browser worker. */
export function detectNaturalCandidates(image: GrayImage, limit = 100): NaturalCandidate[] {
  const result: NaturalCandidate[] = [];
  for (let y = 2; y < image.height - 2 && result.length < limit * 3; y += 2) {
    for (let x = 2; x < image.width - 2 && result.length < limit * 3; x += 2) {
      const at = (xx: number, yy: number) => Number(image.data[yy * image.width + xx] ?? 0);
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const corner = Math.min(1, (Math.abs(gx) + Math.abs(gy)) / 255);
      if (corner < 0.12) continue;
      const entropy = Math.min(1, (Math.abs(at(x, y) - at(x - 1, y - 1)) + Math.abs(at(x, y) - at(x + 1, y + 1))) / 255);
      result.push({ x, y, cornerStrength: corner, textureEntropy: entropy, descriptorUniqueness: corner, boundaryDistance: Math.min(x, y, image.width - 1 - x, image.height - 1 - y) / Math.max(1, Math.min(image.width, image.height) / 2), model: "natural-keypoint" });
    }
  }
  return result.sort((a, b) => scoreNaturalCandidate(b) - scoreNaturalCandidate(a)).slice(0, limit);
}
