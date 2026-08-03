import type { FrameRegistration } from "@subpixel/contracts";
import { applyLocalAffine, type GrayPatch } from "@subpixel/algorithms";

export type SceneRegistrationAnchor = {
  reference: { x: number; y: number };
  current: { x: number; y: number };
  residualPx: number;
};

export type RegistrationGuidance = FrameRegistration & { sceneAnchors?: SceneRegistrationAnchor[] };

type RegistrationQualityInput = {
  matchCount: number;
  inlierCount: number;
  inlierRatio: number;
  medianSymmetricTransferError: number | null;
  inlierCoverage: number;
  transformConsistencyError: number | null;
  hasFiniteInvertibleTransform: boolean;
  projectedFrameAccepted: boolean;
};

export function classifyRegistrationQuality(input: RegistrationQualityInput): Pick<FrameRegistration, "decision" | "usableForPrediction" | "failureClass" | "reason"> {
  const hardReason = !input.hasFiniteInvertibleTransform
    ? "registration.degenerate-transform"
    : !input.projectedFrameAccepted
      ? "registration.invalid-projected-frame"
      : input.medianSymmetricTransferError === null || input.medianSymmetricTransferError > 3
        ? "registration.high-residual"
        : input.transformConsistencyError !== null && input.transformConsistencyError > 5
          ? "registration.transform-inconsistent"
          : null;
  if (hardReason) return { decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", reason: hardReason };
  const consistency = input.transformConsistencyError ?? 0;
  const accepted = input.matchCount >= 50
    && input.inlierRatio >= .35
    && input.medianSymmetricTransferError! <= 3
    && input.inlierCoverage >= .1
    && consistency <= 5;
  if (accepted) return { decision: "accepted", usableForPrediction: true, failureClass: "none", reason: null };
  const provisional = input.matchCount >= 20
    && input.inlierCount >= 12
    && input.inlierRatio >= .5
    && input.medianSymmetricTransferError! <= 2
    && input.inlierCoverage >= .05
    && consistency <= 3;
  const reason = input.matchCount < 50
    ? "registration.too-few-matches"
    : input.inlierRatio < .35
      ? "registration.low-inlier-ratio"
      : input.inlierCoverage < .1
        ? "registration.low-coverage"
        : "registration.quality-gate-failed";
  return provisional
    ? { decision: "provisional", usableForPrediction: true, failureClass: "soft-quality", reason }
    : { decision: "rejected", usableForPrediction: false, failureClass: "soft-quality", reason };
}

function registrationDecision(registration: FrameRegistration): NonNullable<FrameRegistration["decision"]> {
  return registration.decision ?? (registration.accepted === true ? "accepted" : "rejected");
}

function registrationUsable(registration: FrameRegistration): boolean {
  return registration.usableForPrediction ?? registration.accepted === true;
}

type OpenCvLike = {
  Mat: new (...args: any[]) => any;
  KeyPointVector: new () => any;
  DMatchVectorVector: new () => any;
  BFMatcher: new (...args: any[]) => any;
  SIFT?: { create: (...args: any[]) => any };
  SIFT_create?: (...args: any[]) => any;
  ORB?: { create: (...args: any[]) => any };
  ORB_create?: (...args: any[]) => any;
  matFromArray?: (rows: number, cols: number, type: number, data: number[]) => any;
  findHomography?: (src: any, dst: any, method: number, threshold: number, mask: any) => any;
  findFundamentalMat?: (src: any, dst: any, method: number, threshold: number, confidence: number, mask?: any) => any;
  CV_8UC1: number;
  CV_32FC2: number;
  NORM_L2: number;
  NORM_HAMMING: number;
  RANSAC: number;
  FM_RANSAC?: number;
  [key: string]: any;
};

function openCv(): OpenCvLike | undefined {
  const candidate = (globalThis as typeof globalThis & { cv?: OpenCvLike }).cv;
  return candidate?.Mat && candidate.matFromArray && candidate.findHomography ? candidate : undefined;
}

function patchMat(cv: OpenCvLike, patch: GrayPatch) {
  const mat = new cv.Mat(patch.height, patch.width, cv.CV_8UC1);
  const values = new Uint8Array(patch.data.length);
  for (let index = 0; index < values.length; index += 1) values[index] = Math.max(0, Math.min(255, Math.round(patch.data[index])));
  mat.data.set(values);
  return mat;
}

function invertMatrix(matrix: number[]): number[] | undefined {
  if (matrix.length !== 9) return undefined;
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  return [
    (e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant,
    (f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant,
    (d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant
  ];
}

function project(matrix: number[], point: { x: number; y: number }) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return undefined;
  const x = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const y = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

export function composeRegistrationTransforms(sourceToMiddle: number[], middleToTarget: number[]): number[] | undefined {
  if (sourceToMiddle.length !== 9 || middleToTarget.length !== 9) return undefined;
  const result = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    for (let index = 0; index < 3; index += 1) result[row * 3 + column] += middleToTarget[row * 3 + index] * sourceToMiddle[index * 3 + column];
  }
  const scale = result[8];
  if (!result.every(Number.isFinite) || Math.abs(scale) < 1e-12) return undefined;
  return result.map(value => value / scale);
}

export function composeRegistrationGuidance(chain: RegistrationGuidance | undefined, adjacent: RegistrationGuidance): RegistrationGuidance | undefined {
  if (!registrationUsable(adjacent) || !adjacent.transform?.matrix || adjacent.sourceFrame === undefined || adjacent.targetFrame === undefined) return undefined;
  if (!chain) return { ...adjacent, method: "adjacent-flow", guidanceSource: "adjacent" };
  if (!registrationUsable(chain) || !chain.transform?.matrix || chain.targetFrame !== adjacent.sourceFrame || chain.sourceFrame === undefined) return undefined;
  const matrix = composeRegistrationTransforms(chain.transform.matrix, adjacent.transform.matrix);
  const inverse = matrix ? invertMatrix(matrix) : undefined;
  if (!matrix || !inverse) return undefined;
  return {
    frame: adjacent.targetFrame,
    sourceFrame: chain.sourceFrame,
    targetFrame: adjacent.targetFrame,
    method: "adjacent-flow",
    matchCount: Math.min(chain.matchCount, adjacent.matchCount),
    inlierCount: Math.min(chain.inlierCount, adjacent.inlierCount),
    inlierRatio: Math.min(chain.inlierRatio, adjacent.inlierRatio),
    medianReprojectionError: Math.max(chain.medianReprojectionError, adjacent.medianReprojectionError),
    reprojectionErrorSemantics: "pixel-reprojection",
    inlierCoverage: Math.min(chain.inlierCoverage ?? 0, adjacent.inlierCoverage ?? 0),
    medianSymmetricTransferError: Math.max(chain.medianSymmetricTransferError ?? 0, adjacent.medianSymmetricTransferError ?? 0),
    transformConsistencyError: null,
    decision: registrationDecision(chain) === "accepted" && registrationDecision(adjacent) === "accepted" ? "accepted" : "provisional",
    usableForPrediction: true,
    failureClass: registrationDecision(chain) === "accepted" && registrationDecision(adjacent) === "accepted" ? "none" : "soft-quality",
    guidanceSource: "composed",
    accepted: registrationDecision(chain) === "accepted" && registrationDecision(adjacent) === "accepted",
    reason: null,
    transform: { kind: "affine", matrix },
    inverseTransform: { kind: "affine", matrix: inverse }
  };
}

function distributedProbePoints(size: { width: number; height: number }) {
  return [0.1, 0.5, 0.9].flatMap(y => [0.1, 0.5, 0.9].map(x => ({ x: x * size.width, y: y * size.height })));
}

export function reconcileRegistrationGuidance(direct: RegistrationGuidance, composed: RegistrationGuidance | undefined, size: { width: number; height: number }): RegistrationGuidance {
  if (!registrationUsable(direct) || !direct.transform?.matrix || !composed || !registrationUsable(composed) || !composed.transform?.matrix) return direct;
  if (direct.sourceFrame !== composed.sourceFrame || direct.targetFrame !== composed.targetFrame) {
    return { ...direct, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", accepted: false, transformConsistencyError: Infinity, reason: "registration.frame-mismatch" };
  }
  const errors = distributedProbePoints(size).map(point => {
    const directPoint = project(direct.transform!.matrix, point);
    const composedPoint = project(composed.transform!.matrix, point);
    return directPoint && composedPoint ? Math.hypot(directPoint.x - composedPoint.x, directPoint.y - composedPoint.y) : Infinity;
  }).sort((left, right) => left - right);
  const transformConsistencyError = errors[Math.floor(errors.length / 2)] ?? Infinity;
  return transformConsistencyError <= 5
    ? { ...direct, transformConsistencyError, guidanceSource: "direct" }
    : { ...direct, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", accepted: false, transformConsistencyError, reason: "registration.transform-inconsistent" };
}

export function validateProjectedFrame(matrix: number[], size: { width: number; height: number }) {
  if (matrix.length !== 9 || matrix.some(value => !Number.isFinite(value))) return { accepted: false, reason: "registration.invalid-projected-frame" };
  const source = [{ x: 0, y: 0 }, { x: size.width, y: 0 }, { x: size.width, y: size.height }, { x: 0, y: size.height }];
  const denominators = source.map(point => matrix[6] * point.x + matrix[7] * point.y + matrix[8]);
  const sign = Math.sign(denominators[0]);
  if (!sign || denominators.some(value => !Number.isFinite(value) || Math.abs(value) < 1e-9 || Math.sign(value) !== sign)) return { accepted: false, reason: "registration.invalid-projected-frame" };
  const projected = source.map(point => project(matrix, point));
  if (projected.some(point => !point)) return { accepted: false, reason: "registration.invalid-projected-frame" };
  const points = projected as Array<{ x: number; y: number }>;
  const orientation = (a: typeof points[number], b: typeof points[number], c: typeof points[number]) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a: typeof points[number], b: typeof points[number], c: typeof points[number], d: typeof points[number]) => orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0;
  const area = Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
  if (area < 1e-6 || intersects(points[0], points[1], points[2], points[3]) || intersects(points[1], points[2], points[3], points[0])) return { accepted: false, reason: "registration.invalid-projected-frame" };
  return { accepted: true, reason: null };
}

function convexHullCoverage(points: Array<{ x: number; y: number }>, width: number, height: number) {
  if (points.length < 3 || width <= 0 || height <= 0) return 0;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof sorted[number], a: typeof sorted[number], b: typeof sorted[number]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof sorted = []; const upper: typeof sorted = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const area = Math.abs(hull.reduce((sum, point, index) => { const next = hull[(index + 1) % hull.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
  return Math.max(0, Math.min(1, area / (width * height)));
}

function distributedAnchors(anchors: SceneRegistrationAnchor[], width: number, height: number, limit = 300) {
  const cells = new Map<string, SceneRegistrationAnchor>();
  for (const anchor of anchors) {
    const key = `${Math.min(11, Math.floor(anchor.reference.x / Math.max(1, width) * 12))}:${Math.min(11, Math.floor(anchor.reference.y / Math.max(1, height) * 12))}`;
    const existing = cells.get(key);
    if (!existing || anchor.residualPx < existing.residualPx) cells.set(key, anchor);
  }
  const selected = [...cells.values()].sort((a, b) => a.residualPx - b.residualPx);
  if (selected.length >= limit) return selected.slice(0, limit);
  const used = new Set(selected);
  for (const anchor of [...anchors].sort((a, b) => a.residualPx - b.residualPx)) {
    if (!used.has(anchor)) selected.push(anchor);
    if (selected.length >= limit) break;
  }
  return selected;
}

function cvRegistration(reference: GrayPatch, current: GrayPatch, frame: number, sourceFrame = 0): RegistrationGuidance | null {
  const cv = openCv();
  if (!cv) return null;
  const ref = patchMat(cv, reference); const cur = patchMat(cv, current);
  const refKeypoints = new cv.KeyPointVector(); const curKeypoints = new cv.KeyPointVector();
  const refDescriptors = new cv.Mat(); const curDescriptors = new cv.Mat();
  const emptyMask = new cv.Mat();
  let detector: any; let matcher: any; let pairs: any; let src: any; let dst: any; let mask: any; let homography: any; let fundamental: any;
  let method: "sift-homography" | "orb-homography" = "sift-homography";
  try {
    const siftFactory = cv.SIFT?.create ?? cv.SIFT_create;
    const orbFactory = cv.ORB?.create ?? cv.ORB_create;
    if (siftFactory) detector = siftFactory(1200);
    else if (orbFactory) { detector = orbFactory(1600); method = "orb-homography"; }
    else return null;
    try {
      detector.detectAndCompute(ref, emptyMask, refKeypoints, refDescriptors);
      detector.detectAndCompute(cur, emptyMask, curKeypoints, curDescriptors);
    } catch {
      const orbFactory = cv.ORB?.create ?? cv.ORB_create;
      if (method !== "sift-homography" || !orbFactory) return null;
      method = "orb-homography"; detector = orbFactory(1600);
      detector.detectAndCompute(ref, emptyMask, refKeypoints, refDescriptors);
      detector.detectAndCompute(cur, emptyMask, curKeypoints, curDescriptors);
    }
    if (!refDescriptors.rows || !curDescriptors.rows) return null;
    matcher = new cv.BFMatcher(method === "sift-homography" ? cv.NORM_L2 : cv.NORM_HAMMING, false);
    pairs = new cv.DMatchVectorVector(); matcher.knnMatch(refDescriptors, curDescriptors, pairs, 2);
    const source: number[] = []; const destination: number[] = [];
    for (let index = 0; index < pairs.size(); index += 1) {
      const pair = pairs.get(index); if (!pair || pair.size() < 2) continue;
      const best = pair.get(0); const second = pair.get(1);
      if (best.distance >= 0.75 * second.distance) continue;
      const sourcePoint = refKeypoints.get(best.queryIdx).pt; const destinationPoint = curKeypoints.get(best.trainIdx).pt;
      source.push(sourcePoint.x, sourcePoint.y); destination.push(destinationPoint.x, destinationPoint.y);
    }
    if (source.length < 8) return { frame, sourceFrame, targetFrame: frame, method, matchCount: source.length / 2, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, inlierCoverage: 0, medianSymmetricTransferError: null, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", guidanceSource: "direct", accepted: false, reason: "registration.too-few-matches" };
    src = cv.matFromArray!(source.length / 2, 1, cv.CV_32FC2, source); dst = cv.matFromArray!(destination.length / 2, 1, cv.CV_32FC2, destination); mask = new cv.Mat();
    homography = cv.findHomography!(src, dst, cv.RANSAC, 3, mask);
    if (!homography || homography.empty?.()) return { frame, sourceFrame, targetFrame: frame, method, matchCount: source.length / 2, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, inlierCoverage: 0, medianSymmetricTransferError: null, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", guidanceSource: "direct", accepted: false, reason: "registration.no-homography" };
    const matrix = Array.from(homography.data64F ?? homography.data32F ?? []).slice(0, 9).map(Number);
    const inverse = invertMatrix(matrix); const errors: number[] = []; const symmetricErrors: number[] = []; const anchors: SceneRegistrationAnchor[] = []; let inlierCount = 0;
    for (let index = 0; index < source.length / 2; index += 1) {
      if (Number(mask.data[index]) === 0) continue;
      inlierCount += 1;
      const x = source[index * 2]; const y = source[index * 2 + 1]; const d = matrix[6] * x + matrix[7] * y + matrix[8];
      if (Math.abs(d) < 1e-9) continue;
      const px = (matrix[0] * x + matrix[1] * y + matrix[2]) / d; const py = (matrix[3] * x + matrix[4] * y + matrix[5]) / d;
      const residualPx = Math.hypot(px - destination[index * 2], py - destination[index * 2 + 1]);
      errors.push(residualPx);
      const referencePoint = { x, y }; const currentPoint = { x: destination[index * 2], y: destination[index * 2 + 1] };
      anchors.push({ reference: referencePoint, current: currentPoint, residualPx });
      const backwards = inverse ? project(inverse, currentPoint) : undefined;
      if (backwards) symmetricErrors.push((residualPx + Math.hypot(backwards.x - x, backwards.y - y)) / 2);
    }
    errors.sort((a, b) => a - b); symmetricErrors.sort((a, b) => a - b);
    const median = errors.length ? errors[Math.floor(errors.length / 2)] : Infinity;
    const symmetricMedian = symmetricErrors.length ? symmetricErrors[Math.floor(symmetricErrors.length / 2)] : Infinity;
    const matchCount = source.length / 2; const inlierRatio = inlierCount / Math.max(1, matchCount); const coverage = convexHullCoverage(anchors.map(anchor => anchor.reference), reference.width, reference.height);
    if (cv.findFundamentalMat && source.length >= 16) {
      try { const fundamentalMask = new cv.Mat(); fundamental = cv.findFundamentalMat(src, dst, cv.FM_RANSAC ?? cv.RANSAC, 2, .99, fundamentalMask); fundamentalMask.delete?.(); } catch { fundamental = undefined; }
    }
    const fundamentalMatrix = fundamental && !fundamental.empty?.() ? Array.from(fundamental.data64F ?? fundamental.data32F ?? []).slice(0, 9).map(Number) : undefined;
    const projectedFrame = validateProjectedFrame(matrix, { width: reference.width, height: reference.height });
    const quality = classifyRegistrationQuality({
      matchCount, inlierCount, inlierRatio, medianSymmetricTransferError: symmetricMedian,
      inlierCoverage: coverage, transformConsistencyError: null,
      hasFiniteInvertibleTransform: matrix.length === 9 && matrix.every(Number.isFinite) && Boolean(inverse),
      projectedFrameAccepted: projectedFrame.accepted
    });
    return {
      frame, sourceFrame, targetFrame: frame, method, matchCount, inlierCount, inlierRatio,
      medianReprojectionError: median, reprojectionErrorSemantics: "pixel-reprojection",
      inlierCoverage: coverage, medianSymmetricTransferError: symmetricMedian, transformConsistencyError: null,
      ...quality, guidanceSource: "direct", accepted: quality.decision === "accepted",
      transform: quality.usableForPrediction ? { kind: "homography", matrix } : undefined,
      inverseTransform: quality.usableForPrediction && inverse ? { kind: "homography", matrix: inverse } : undefined,
      fundamentalMatrix,
      sceneAnchors: quality.usableForPrediction ? distributedAnchors(anchors, reference.width, reference.height) : undefined
    };
  } catch {
    return null;
  } finally {
    for (const value of [fundamental, homography, mask, dst, src, pairs, matcher, ref, cur, refKeypoints, curKeypoints, refDescriptors, curDescriptors, emptyMask, detector]) value?.delete?.();
  }
}

function scoreTranslation(reference: GrayPatch, current: GrayPatch, dx: number, dy: number) {
  const step = Math.max(1, Math.floor(Math.min(reference.width, reference.height) / 32));
  let refMean = 0; let currentMean = 0; let count = 0;
  for (let y = 2; y < reference.height - 2; y += step) for (let x = 2; x < reference.width - 2; x += step) {
    const tx = x + dx; const ty = y + dy;
    if (tx < 2 || ty < 2 || tx >= current.width - 2 || ty >= current.height - 2) continue;
    refMean += reference.data[y * reference.width + x]; currentMean += current.data[ty * current.width + tx]; count += 1;
  }
  if (count < 20) return { score: -1, count: 0, residual: Infinity };
  refMean /= count; currentMean /= count;
  let covariance = 0; let refVariance = 0; let currentVariance = 0; let absoluteError = 0;
  for (let y = 2; y < reference.height - 2; y += step) for (let x = 2; x < reference.width - 2; x += step) {
    const tx = x + dx; const ty = y + dy;
    if (tx < 2 || ty < 2 || tx >= current.width - 2 || ty >= current.height - 2) continue;
    const a = reference.data[y * reference.width + x] - refMean; const b = current.data[ty * current.width + tx] - currentMean;
    covariance += a * b; refVariance += a * a; currentVariance += b * b; absoluteError += Math.abs(a - b);
  }
  return { score: covariance / Math.max(1e-9, Math.sqrt(refVariance * currentVariance)), count, residual: absoluteError / count };
}

export function registerLocalPatches(reference: GrayPatch, current: GrayPatch, frame: number, sourceFrame = 0): RegistrationGuidance {
  if (reference.width !== current.width || reference.height !== current.height) return {
    frame, sourceFrame, targetFrame: frame, method: "none", matchCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity,
    decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", guidanceSource: "direct", accepted: false, reason: "registration.dimension-mismatch"
  };
  const cvResult = cvRegistration(reference, current, frame, sourceFrame);
  if (cvResult) return cvResult;
  const limit = Math.min(128, Math.floor(Math.min(reference.width, reference.height) / 3));
  let best = { score: -1, count: 0, residual: Infinity, dx: 0, dy: 0 };
  const coarseStep = Math.max(2, Math.floor(limit / 16));
  const coarseCandidates: typeof best[] = [];
  for (let dy = -limit; dy <= limit; dy += coarseStep) for (let dx = -limit; dx <= limit; dx += coarseStep) {
    const result = scoreTranslation(reference, current, dx, dy);
    const candidate = { ...result, dx, dy };
    coarseCandidates.push(candidate);
    if (result.score > best.score) best = candidate;
  }
  coarseCandidates.sort((a, b) => b.score - a.score);
  for (const coarse of coarseCandidates.slice(0, 6)) {
    for (let dy = Math.max(-limit, coarse.dy - coarseStep); dy <= Math.min(limit, coarse.dy + coarseStep); dy += 1) for (let dx = Math.max(-limit, coarse.dx - coarseStep); dx <= Math.min(limit, coarse.dx + coarseStep); dx += 1) {
      const result = scoreTranslation(reference, current, dx, dy);
      if (result.score > best.score) best = { ...result, dx, dy };
    }
  }
  const localLimit = Math.min(16, limit);
  for (let dy = -localLimit; dy <= localLimit; dy += 1) for (let dx = -localLimit; dx <= localLimit; dx += 1) {
    const result = scoreTranslation(reference, current, dx, dy);
    if (result.score > best.score) best = { ...result, dx, dy };
  }
  const smallMotion = Math.hypot(best.dx, best.dy) <= 16;
  const usable = best.count >= 50 && best.score >= .35 && best.residual <= 12 && smallMotion;
  return {
    frame,
    sourceFrame,
    targetFrame: frame,
    method: "translation-fallback",
    matchCount: 0,
    inlierCount: 0,
    inlierRatio: 0,
    medianReprojectionError: 0,
    reprojectionErrorSemantics: "not-available",
    inlierCoverage: 0,
    medianSymmetricTransferError: null,
    decision: usable ? "provisional" : "rejected",
    usableForPrediction: usable,
    failureClass: "engine-unavailable",
    guidanceSource: "translation",
    accepted: false,
    reason: usable ? "registration.translation-fallback" : !smallMotion ? "registration.degraded-large-motion" : best.count < 50 ? "registration.too-few-matches" : best.score < .35 ? "registration.low-inlier-ratio" : "registration.high-residual",
    transform: usable ? { kind: "affine", matrix: [1, 0, best.dx, 0, 1, best.dy, 0, 0, 1] } : undefined,
    inverseTransform: usable ? { kind: "affine", matrix: [1, 0, -best.dx, 0, 1, -best.dy, 0, 0, 1] } : undefined
  };
}

function patchCorrelation(reference: GrayPatch, current: GrayPatch, centerX: number, centerY: number, dx: number, dy: number, radius: number) {
  let referenceMean = 0; let currentMean = 0; let count = 0;
  for (let oy = -radius; oy <= radius; oy += 1) for (let ox = -radius; ox <= radius; ox += 1) {
    const x = centerX + ox; const y = centerY + oy; const tx = x + dx; const ty = y + dy;
    if (x < 0 || y < 0 || tx < 0 || ty < 0 || x >= reference.width || y >= reference.height || tx >= current.width || ty >= current.height) continue;
    referenceMean += reference.data[y * reference.width + x]; currentMean += current.data[ty * current.width + tx]; count += 1;
  }
  if (count < (radius * 2 + 1) ** 2) return -1;
  referenceMean /= count; currentMean /= count;
  let covariance = 0; let referenceVariance = 0; let currentVariance = 0;
  for (let oy = -radius; oy <= radius; oy += 1) for (let ox = -radius; ox <= radius; ox += 1) {
    const x = centerX + ox; const y = centerY + oy; const tx = x + dx; const ty = y + dy;
    const a = reference.data[y * reference.width + x] - referenceMean; const b = current.data[ty * current.width + tx] - currentMean;
    covariance += a * b; referenceVariance += a * a; currentVariance += b * b;
  }
  return covariance / Math.max(1e-9, Math.sqrt(referenceVariance * currentVariance));
}

export function registerAdjacentAnchors(anchors: SceneRegistrationAnchor[], size: { width: number; height: number }, targetFrame: number, sourceFrame = targetFrame - 1): RegistrationGuidance {
  const fit = applyLocalAffine({ x: 0, y: 0 }, anchors.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: true })));
  const affine = fit.matrix;
  if (!affine) return { frame: targetFrame, sourceFrame, targetFrame, method: "adjacent-flow", matchCount: anchors.length, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", guidanceSource: "adjacent", accepted: false, reason: "registration.adjacent-flow-degenerate" };
  const residuals = anchors.map(anchor => Math.hypot(affine[0] * anchor.reference.x + affine[1] * anchor.reference.y + affine[2] - anchor.current.x, affine[3] * anchor.reference.x + affine[4] * anchor.reference.y + affine[5] - anchor.current.y));
  const inlierAnchors = anchors.filter((_, index) => residuals[index] <= 1.5);
  const refined = applyLocalAffine({ x: 0, y: 0 }, inlierAnchors.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: true })));
  const finalAffine = refined.matrix ?? affine;
  const finalResiduals = inlierAnchors.map(anchor => Math.hypot(finalAffine[0] * anchor.reference.x + finalAffine[1] * anchor.reference.y + finalAffine[2] - anchor.current.x, finalAffine[3] * anchor.reference.x + finalAffine[4] * anchor.reference.y + finalAffine[5] - anchor.current.y)).sort((a, b) => a - b);
  const median = finalResiduals[Math.floor(finalResiduals.length / 2)] ?? Infinity;
  const matchCount = anchors.length; const inlierCount = inlierAnchors.length; const inlierRatio = inlierCount / Math.max(1, matchCount);
  const matrix = [finalAffine[0], finalAffine[1], finalAffine[2], finalAffine[3], finalAffine[4], finalAffine[5], 0, 0, 1];
  const inverse = invertMatrix(matrix); const coverage = convexHullCoverage(inlierAnchors.map(anchor => anchor.reference), size.width, size.height);
  const quality = classifyRegistrationQuality({
    matchCount, inlierCount, inlierRatio, medianSymmetricTransferError: median,
    inlierCoverage: coverage, transformConsistencyError: null,
    hasFiniteInvertibleTransform: Boolean(inverse), projectedFrameAccepted: validateProjectedFrame(matrix, size).accepted
  });
  return {
    frame: targetFrame, sourceFrame, targetFrame, method: "adjacent-flow", matchCount, inlierCount, inlierRatio,
    medianReprojectionError: median, reprojectionErrorSemantics: "pixel-reprojection", inlierCoverage: coverage, medianSymmetricTransferError: median,
    ...quality, guidanceSource: "adjacent", accepted: quality.decision === "accepted",
    transform: quality.usableForPrediction ? { kind: "affine", matrix } : undefined,
    inverseTransform: quality.usableForPrediction && inverse ? { kind: "affine", matrix: inverse } : undefined,
    sceneAnchors: quality.usableForPrediction ? distributedAnchors(inlierAnchors.map(anchor => ({ ...anchor, residualPx: Math.hypot(finalAffine[0] * anchor.reference.x + finalAffine[1] * anchor.reference.y + finalAffine[2] - anchor.current.x, finalAffine[3] * anchor.reference.x + finalAffine[4] * anchor.reference.y + finalAffine[5] - anchor.current.y) })), size.width, size.height) : undefined
  };
}

export function registerAdjacentPatches(reference: GrayPatch, current: GrayPatch, targetFrame: number, sourceFrame = targetFrame - 1): RegistrationGuidance {
  if (reference.width !== current.width || reference.height !== current.height) return { frame: targetFrame, sourceFrame, targetFrame, method: "adjacent-flow", matchCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, decision: "rejected", usableForPrediction: false, failureClass: "hard-geometry", guidanceSource: "adjacent", accepted: false, reason: "registration.dimension-mismatch" };
  const radius = 2;
  const motion = Math.max(2, Math.min(12, Math.floor(Math.min(reference.width, reference.height) / 8)));
  const margin = radius + motion + 1;
  const anchors: SceneRegistrationAnchor[] = [];
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 10; column += 1) {
    const x = Math.round(margin + (column + .5) * Math.max(1, reference.width - margin * 2) / 10);
    const y = Math.round(margin + (row + .5) * Math.max(1, reference.height - margin * 2) / 6);
    let best = { score: -1, dx: 0, dy: 0 };
    for (let dy = -motion; dy <= motion; dy += 1) for (let dx = -motion; dx <= motion; dx += 1) {
      const score = patchCorrelation(reference, current, x, y, dx, dy, radius);
      if (score > best.score) best = { score, dx, dy };
    }
    if (best.score >= .55) anchors.push({ reference: { x, y }, current: { x: x + best.dx, y: y + best.dy }, residualPx: 0 });
  }
  return registerAdjacentAnchors(anchors, { width: reference.width, height: reference.height }, targetFrame, sourceFrame);
}
