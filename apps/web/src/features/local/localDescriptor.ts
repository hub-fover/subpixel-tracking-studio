import type { GrayPatch } from "@subpixel/algorithms";

export type DescriptorRelocation = {
  point: { x: number; y: number };
  distance: number;
  loweRatio: number;
  method: "sift" | "orb";
};

type OpenCvDescriptor = {
  Mat: new (...args: any[]) => any;
  KeyPointVector?: new () => any;
  DMatchVectorVector?: new () => any;
  BFMatcher?: new (...args: any[]) => any;
  SIFT?: { create?: (...args: any[]) => any };
  SIFT_create?: (...args: any[]) => any;
  ORB?: { create?: (...args: any[]) => any };
  ORB_create?: (...args: any[]) => any;
  CV_8UC1?: number;
  NORM_L2?: number;
  NORM_HAMMING?: number;
};

function patchMat(cv: OpenCvDescriptor, patch: GrayPatch) {
  const mat = new cv.Mat(patch.height, patch.width, cv.CV_8UC1 ?? 0);
  const values = new Uint8Array(patch.data.length);
  for (let index = 0; index < values.length; index += 1) values[index] = Math.max(0, Math.min(255, Math.round(patch.data[index])));
  mat.data.set(values);
  return mat;
}

function tryMethod(cv: OpenCvDescriptor, template: GrayPatch, search: GrayPatch, method: "sift" | "orb"): DescriptorRelocation | null {
  if (!cv.KeyPointVector || !cv.DMatchVectorVector || !cv.BFMatcher) return null;
  const detector = method === "sift"
    ? cv.SIFT?.create?.() ?? cv.SIFT_create?.()
    : cv.ORB?.create?.(800) ?? cv.ORB_create?.(800);
  if (!detector) return null;
  const templateMat = patchMat(cv, template); const searchMat = patchMat(cv, search); const mask = new cv.Mat();
  const templateKeypoints = new cv.KeyPointVector(); const searchKeypoints = new cv.KeyPointVector();
  const templateDescriptors = new cv.Mat(); const searchDescriptors = new cv.Mat();
  let matcher: any; let pairs: any; let query: any;
  try {
    detector.detectAndCompute(templateMat, mask, templateKeypoints, templateDescriptors);
    detector.detectAndCompute(searchMat, mask, searchKeypoints, searchDescriptors);
    if (!templateDescriptors.rows || !searchDescriptors.rows || searchDescriptors.rows < 2 || !templateKeypoints.size()) return null;
    const templateCenter = { x: (template.width - 1) / 2, y: (template.height - 1) / 2 };
    let queryIndex = 0; let nearest = Infinity;
    for (let index = 0; index < templateKeypoints.size(); index += 1) {
      const point = templateKeypoints.get(index).pt;
      const distance = Math.hypot(point.x - templateCenter.x, point.y - templateCenter.y);
      if (distance < nearest) { nearest = distance; queryIndex = index; }
    }
    const templatePoint = templateKeypoints.get(queryIndex).pt;
    query = templateDescriptors.row(queryIndex);
    matcher = new cv.BFMatcher(method === "sift" ? cv.NORM_L2 ?? 4 : cv.NORM_HAMMING ?? 6, false);
    pairs = new cv.DMatchVectorVector(); matcher.knnMatch(query, searchDescriptors, pairs, 2);
    if (!pairs.size()) return null;
    const pair = pairs.get(0); if (!pair || pair.size() < 2) return null;
    const best = pair.get(0); const second = pair.get(1);
    const loweRatio = Number(best.distance) / Math.max(Number(second.distance), 1e-9);
    if (!Number.isFinite(loweRatio) || loweRatio > .75) return null;
    const searchPoint = searchKeypoints.get(best.trainIdx).pt;
    return {
      point: {
        x: Number(searchPoint.x) + templateCenter.x - Number(templatePoint.x),
        y: Number(searchPoint.y) + templateCenter.y - Number(templatePoint.y)
      },
      distance: Number(best.distance), loweRatio, method
    };
  } finally {
    for (const value of [query, pairs, matcher, templateDescriptors, searchDescriptors, templateKeypoints, searchKeypoints, mask, templateMat, searchMat, detector]) value?.delete?.();
  }
}

export function relocateNaturalDescriptor(template: GrayPatch, search: GrayPatch): DescriptorRelocation | null {
  const cv = (globalThis as typeof globalThis & { cv?: OpenCvDescriptor }).cv;
  if (!cv?.Mat) return null;
  try { const sift = tryMethod(cv, template, search, "sift"); if (sift) return sift; } catch { /* Fall through to ORB. */ }
  try { return tryMethod(cv, template, search, "orb"); } catch { return null; }
}
