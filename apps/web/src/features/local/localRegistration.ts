import type { FrameRegistration } from "@subpixel/contracts";
import type { GrayPatch } from "@subpixel/algorithms";

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
  CV_8UC1: number;
  CV_32FC2: number;
  NORM_L2: number;
  NORM_HAMMING: number;
  RANSAC: number;
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

function cvRegistration(reference: GrayPatch, current: GrayPatch, frame: number): FrameRegistration | null {
  const cv = openCv();
  if (!cv) return null;
  const ref = patchMat(cv, reference); const cur = patchMat(cv, current);
  const refKeypoints = new cv.KeyPointVector(); const curKeypoints = new cv.KeyPointVector();
  const refDescriptors = new cv.Mat(); const curDescriptors = new cv.Mat();
  const emptyMask = new cv.Mat();
  let detector: any; let matcher: any; let method: "sift-ransac" | "orb-ransac" = "sift-ransac";
  try {
    const siftFactory = cv.SIFT?.create ?? cv.SIFT_create;
    const orbFactory = cv.ORB?.create ?? cv.ORB_create;
    if (siftFactory) detector = siftFactory(1200);
    else if (orbFactory) { detector = orbFactory(1600); method = "orb-ransac"; }
    else return null;
    try {
      detector.detectAndCompute(ref, emptyMask, refKeypoints, refDescriptors);
      detector.detectAndCompute(cur, emptyMask, curKeypoints, curDescriptors);
    } catch {
      const orbFactory = cv.ORB?.create ?? cv.ORB_create;
      if (method !== "sift-ransac" || !orbFactory) return null;
      method = "orb-ransac"; detector = orbFactory(1600);
      detector.detectAndCompute(ref, emptyMask, refKeypoints, refDescriptors);
      detector.detectAndCompute(cur, emptyMask, curKeypoints, curDescriptors);
    }
    if (!refDescriptors.rows || !curDescriptors.rows) return null;
    matcher = new cv.BFMatcher(method === "sift-ransac" ? cv.NORM_L2 : cv.NORM_HAMMING, false);
    const pairs = new cv.DMatchVectorVector(); matcher.knnMatch(refDescriptors, curDescriptors, pairs, 2);
    const source: number[] = []; const destination: number[] = [];
    for (let index = 0; index < pairs.size(); index += 1) {
      const pair = pairs.get(index); if (!pair || pair.size() < 2) continue;
      const best = pair.get(0); const second = pair.get(1);
      if (best.distance >= 0.75 * second.distance) continue;
      const sourcePoint = refKeypoints.get(best.queryIdx).pt; const destinationPoint = curKeypoints.get(best.trainIdx).pt;
      source.push(sourcePoint.x, sourcePoint.y); destination.push(destinationPoint.x, destinationPoint.y);
    }
    if (source.length < 8) return { frame, method, matchCount: source.length / 2, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, accepted: false, reason: "registration.too-few-matches" };
    const src = cv.matFromArray!(source.length / 2, 1, cv.CV_32FC2, source); const dst = cv.matFromArray!(destination.length / 2, 1, cv.CV_32FC2, destination); const mask = new cv.Mat();
    const homography = cv.findHomography!(src, dst, cv.RANSAC, 3, mask);
    if (!homography || homography.empty?.()) return { frame, method, matchCount: source.length / 2, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, accepted: false, reason: "registration.no-homography" };
    const matrix = Array.from(homography.data64F ?? homography.data32F ?? []).slice(0, 9).map(Number);
    const errors: number[] = []; let inlierCount = 0;
    for (let index = 0; index < source.length / 2; index += 1) {
      if (Number(mask.data[index]) === 0) continue;
      inlierCount += 1;
      const x = source[index * 2]; const y = source[index * 2 + 1]; const d = matrix[6] * x + matrix[7] * y + matrix[8];
      if (Math.abs(d) < 1e-9) continue;
      const px = (matrix[0] * x + matrix[1] * y + matrix[2]) / d; const py = (matrix[3] * x + matrix[4] * y + matrix[5]) / d;
      errors.push(Math.hypot(px - destination[index * 2], py - destination[index * 2 + 1]));
    }
    errors.sort((a, b) => a - b); const median = errors.length ? errors[Math.floor(errors.length / 2)] : Infinity; const matchCount = source.length / 2; const inlierRatio = inlierCount / Math.max(1, matchCount);
    const accepted = matchCount >= 50 && inlierRatio >= .35 && median <= 3 && matrix.length === 9;
    return { frame, method, matchCount, inlierCount, inlierRatio, medianReprojectionError: median, accepted, reason: accepted ? null : matchCount < 50 ? "registration.too-few-matches" : inlierRatio < .35 ? "registration.low-inlier-ratio" : "registration.high-residual", transform: accepted ? { kind: "homography", matrix } : undefined };
  } catch {
    return null;
  } finally {
    for (const value of [ref, cur, refKeypoints, curKeypoints, refDescriptors, curDescriptors, emptyMask, matcher]) value?.delete?.();
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

export function registerLocalPatches(reference: GrayPatch, current: GrayPatch, frame: number): FrameRegistration {
  if (reference.width !== current.width || reference.height !== current.height) return {
    frame, method: "none", matchCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, accepted: false, reason: "registration.dimension-mismatch"
  };
  const cvResult = cvRegistration(reference, current, frame);
  if (cvResult) return cvResult;
  const limit = Math.min(128, Math.floor(Math.min(reference.width, reference.height) / 3));
  let best = { score: -1, count: 0, residual: Infinity, dx: 0, dy: 0 };
  for (let dy = -limit; dy <= limit; dy += 1) for (let dx = -limit; dx <= limit; dx += 1) {
    const result = scoreTranslation(reference, current, dx, dy);
    if (result.score > best.score) best = { ...result, dx, dy };
  }
  const inlierRatio = Math.max(0, Math.min(1, (best.score + 1) / 2));
  const accepted = best.count >= 50 && best.score >= .35 && best.residual <= 12;
  return {
    frame,
    method: accepted ? "homography" : "none",
    matchCount: best.count,
    inlierCount: Math.round(best.count * inlierRatio),
    inlierRatio,
    medianReprojectionError: best.residual,
    accepted,
    reason: accepted ? null : best.count < 50 ? "registration.too-few-matches" : best.score < .35 ? "registration.low-inlier-ratio" : "registration.high-residual",
    transform: accepted ? { kind: "homography", matrix: [1, 0, best.dx, 0, 1, best.dy, 0, 0, 1] } : undefined
  };
}
