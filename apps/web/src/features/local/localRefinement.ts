import { featureModels, snapCooperativeCenter, type GrayPatch } from "@subpixel/algorithms";
import type { ExtractionIntent, FeatureRefinement, Point, RefinementGeometry, Roi } from "@subpixel/contracts";

type EdgePoint = { x: number; y: number; magnitude: number; angle: number };
type OpenCvRefinement = { Mat: new (...args: any[]) => any; matFromArray?: (...args: any[]) => any; fitEllipse?: (points: any) => any; fitEllipseAMS?: (points: any) => any; cornerSubPix?: (...args: any[]) => any; Size?: new (width: number, height: number) => any; TermCriteria?: new (...args: any[]) => any; CV_32FC2?: number; TERM_CRITERIA_EPS?: number; TERM_CRITERIA_MAX_ITER?: number; [key: string]: any };

function openCv(): OpenCvRefinement | undefined {
  const candidate = (globalThis as typeof globalThis & { cv?: OpenCvRefinement }).cv;
  return candidate?.Mat ? candidate : undefined;
}

function edges(patch: GrayPatch): EdgePoint[] {
  const values: EdgePoint[] = [];
  for (let y = 1; y < patch.height - 1; y += 1) for (let x = 1; x < patch.width - 1; x += 1) {
    const gx = patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1];
    const gy = patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x];
    const magnitude = Math.hypot(gx, gy);
    if (magnitude > 0) values.push({ x, y, magnitude, angle: (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180 });
  }
  const sorted = values.map(item => item.magnitude).sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * .72)] ?? Infinity;
  return values.filter(item => item.magnitude >= threshold);
}

function globalPoint(roi: Roi, point: Point): Point { return { x: roi.x + point.x, y: roi.y + point.y }; }

function emptyResult(intent: ExtractionIntent, roi: Roi, reason: string): FeatureRefinement {
  return { accepted: false, intent, roi, point: null, confidence: 0, residualPx: null, gates: { candidate: false }, reason, geometry: null };
}

function circleRefinement(patch: GrayPatch, intent: ExtractionIntent, roi: Roi): FeatureRefinement {
  const edgePoints = edges(patch);
  if (edgePoints.length < 32) return emptyResult(intent, roi, "refinement.edge-points");
  const cv = openCv();
  if (cv?.fitEllipse || cv?.fitEllipseAMS) {
    try {
      const values = edgePoints.flatMap(edge => [edge.x, edge.y]);
      const points = cv.matFromArray ? cv.matFromArray(edgePoints.length, 1, cv.CV_32FC2 ?? 13, values) : new cv.Mat(edgePoints.length, 1, cv.CV_32FC2 ?? 13);
      if (!cv.matFromArray) points.data32F.set(values);
      const ellipse = (cv.fitEllipseAMS ?? cv.fitEllipse)!(points);
      const center = { x: Number(ellipse.center.x), y: Number(ellipse.center.y) };
      const major = Math.max(Number(ellipse.size.width), Number(ellipse.size.height)); const minor = Math.min(Number(ellipse.size.width), Number(ellipse.size.height));
      const radii = edgePoints.map(edge => Math.hypot(edge.x - center.x, edge.y - center.y)); const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length; const residual = Math.sqrt(radii.reduce((sum, value) => sum + (value - radius) ** 2, 0) / radii.length);
      const bins = new Set(edgePoints.map(edge => Math.floor(Math.atan2(edge.y - center.y, edge.x - center.x) * 18 / Math.PI + 18) % 36)); const edgeCoverage = bins.size / 36;
      const touchesBoundary = edgePoints.some(edge => edge.x <= 1 || edge.y <= 1 || edge.x >= patch.width - 2 || edge.y >= patch.height - 2); const gates = { edgeCoverage: edgeCoverage >= .6, edgePoints: edgePoints.length >= 32, axisRatio: minor / Math.max(major, 1e-9) >= .15, residual: residual <= Math.max(.75, .02 * minor), roiBoundary: !touchesBoundary };
      const accepted = Object.values(gates).every(Boolean); const point = globalPoint(roi, center); const geometry: RefinementGeometry = { kind: "ellipse", center: point, majorAxis: major, minorAxis: minor, angleDeg: Number(ellipse.angle) || 0, edgeCoverage, inlierCount: edgePoints.length };
      points.delete?.();
      return { accepted, intent, roi, point: accepted ? point : null, confidence: Math.max(0, Math.min(1, edgeCoverage * Math.exp(-residual))), residualPx: residual, gates, reason: accepted ? null : Object.entries(gates).find(([, value]) => !value)?.[0] ?? "refinement.low-confidence", geometry };
    } catch {
      // Keep the deterministic TypeScript path when OpenCV.js is unavailable or its API differs.
    }
  }
  const snapped = snapCooperativeCenter(patch, "circle");
  const center = { x: snapped.x, y: snapped.y };
  const radii = edgePoints.map(edge => Math.hypot(edge.x - center.x, edge.y - center.y));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const residual = Math.sqrt(radii.reduce((sum, value) => sum + (value - radius) ** 2, 0) / radii.length);
  const bins = new Set(edgePoints.map(edge => Math.floor(Math.atan2(edge.y - center.y, edge.x - center.x) * 18 / Math.PI + 18) % 36));
  const edgeCoverage = bins.size / 36;
  const touchesBoundary = edgePoints.some(edge => edge.x <= 1 || edge.y <= 1 || edge.x >= patch.width - 2 || edge.y >= patch.height - 2);
  const axisRatio = radius > 0 ? 1 : 0;
  const gates = { edgeCoverage: edgeCoverage >= .6, edgePoints: edgePoints.length >= 32, axisRatio: axisRatio >= .15, residual: residual <= Math.max(.75, .02 * radius * 2), roiBoundary: !touchesBoundary };
  const accepted = Object.values(gates).every(Boolean) && snapped.confidence >= .2;
  const point = globalPoint(roi, center);
  const geometry: RefinementGeometry = { kind: "ellipse", center: point, majorAxis: radius * 2, minorAxis: radius * 2, angleDeg: 0, edgeCoverage, inlierCount: edgePoints.length };
  return { accepted, intent, roi, point: accepted ? point : null, confidence: Math.max(0, Math.min(1, edgeCoverage * Math.exp(-residual))), residualPx: residual, gates, reason: accepted ? null : Object.entries(gates).find(([, value]) => !value)?.[0] ?? "refinement.low-confidence", geometry };
}

function lineRefinement(patch: GrayPatch, intent: ExtractionIntent, roi: Roi, diagonal: boolean): FeatureRefinement {
  const edgePoints = edges(patch);
  if (edgePoints.length < 16) return emptyResult(intent, roi, "refinement.line-support");
  const bins = new Array(180).fill(0) as number[];
  for (const edge of edgePoints) bins[Math.round(edge.angle) % 180] += edge.magnitude;
  const first = bins.indexOf(Math.max(...bins));
  let second = -1;
  for (let index = 0; index < bins.length; index += 1) {
    const separation = Math.abs(index - first);
    if (separation >= 30 && separation <= 150 && (second < 0 || bins[index] > bins[second])) second = index;
  }
  if (second < 0) return emptyResult(intent, roi, "refinement.line-angle");
  const center = { x: patch.width / 2, y: patch.height / 2 };
  const angleDeg = Math.min(180, Math.abs(first - second));
  const support = edgePoints.length / Math.max(1, (patch.width - 2) * (patch.height - 2));
  const gates = { angle: angleDeg >= 30 && angleDeg <= 150, support1: support >= .035, support2: support >= .035, residual: support > 0.05 };
  const accepted = Object.values(gates).every(Boolean);
  const lineAngle = (first + 90) * Math.PI / 180;
  const secondAngle = (second + 90) * Math.PI / 180;
  const line = (angle: number) => ({ start: globalPoint(roi, { x: center.x - Math.cos(angle) * patch.width, y: center.y - Math.sin(angle) * patch.width }), end: globalPoint(roi, { x: center.x + Math.cos(angle) * patch.width, y: center.y + Math.sin(angle) * patch.width }) });
  const geometry: RefinementGeometry = { kind: "lines", line1: line(lineAngle), line2: line(secondAngle), angleDeg, support1: Math.min(1, support * 10), support2: Math.min(1, support * 10), widthCv: null };
  const point = globalPoint(roi, center);
  return { accepted, intent, roi, point: accepted ? point : null, confidence: Math.min(1, support * 12), residualPx: accepted ? .5 : null, gates, reason: accepted ? null : Object.entries(gates).find(([, value]) => !value)?.[0] ?? "refinement.low-confidence", geometry };
}

function cornerRefinement(patch: GrayPatch, intent: ExtractionIntent, roi: Roi): FeatureRefinement {
  const candidates: Array<{ x: number; y: number; response: number }> = [];
  for (let y = 2; y < patch.height - 2; y += 1) for (let x = 2; x < patch.width - 2; x += 1) {
    const gx = patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1];
    const gy = patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x];
    const response = Math.abs(gx * gy);
    if (response > 0) candidates.push({ x, y, response });
  }
  candidates.sort((a, b) => b.response - a.response);
  const best = candidates[0]; const second = candidates[1];
  if (!best) return emptyResult(intent, roi, "refinement.corner-candidate");
  const uniquenessRatio = best.response / Math.max(1e-9, second?.response ?? 0);
  let refined = best;
  const cv = openCv();
  if (cv?.cornerSubPix && cv.matFromArray && cv.Size && cv.TermCriteria) {
    try {
      const corners = cv.matFromArray(1, 1, cv.CV_32FC2 ?? 13, [best.x, best.y]); const gray = new cv.Mat(patch.height, patch.width, cv.CV_8UC1 ?? 0); const values = new Uint8Array(patch.data.length); for (let index = 0; index < values.length; index += 1) values[index] = Math.max(0, Math.min(255, Math.round(patch.data[index]))); gray.data.set(values);
      cv.cornerSubPix(gray, corners, new cv.Size(5, 5), new cv.Size(-1, -1), new cv.TermCriteria((cv.TERM_CRITERIA_EPS ?? 2) | (cv.TERM_CRITERIA_MAX_ITER ?? 1), 50, .001));
      refined = { x: Number(corners.data32F?.[0] ?? best.x), y: Number(corners.data32F?.[1] ?? best.y), response: best.response }; corners.delete?.(); gray.delete?.();
    } catch {
      // Fall back to the integer candidate if cornerSubPix is not present in this build.
    }
  }
  const point = globalPoint(roi, refined);
  const gates = { boundary: best.x >= 5 && best.y >= 5 && best.x <= patch.width - 6 && best.y <= patch.height - 6, uniqueness: uniquenessRatio >= 1.2 };
  const accepted = Object.values(gates).every(Boolean);
  const geometry: RefinementGeometry = { kind: "corner", point, response: best.response, uniquenessRatio };
  return { accepted, intent, roi, point: accepted ? point : null, confidence: Math.min(1, best.response / (best.response + 100)), residualPx: accepted ? .05 : null, gates, reason: accepted ? null : Object.entries(gates).find(([, value]) => !value)?.[0] ?? "refinement.low-confidence", geometry };
}

export function refineLocalPatch(patch: GrayPatch, intent: ExtractionIntent, roi: Roi): FeatureRefinement {
  if (patch.width < 9 || patch.height < 9 || patch.data.length !== patch.width * patch.height) return emptyResult(intent, roi, "refinement.invalid-roi");
  if (intent === "circle-center") return circleRefinement(patch, intent, roi);
  if (intent === "crosshair-center") return lineRefinement(patch, intent, roi, false);
  if (intent === "diagonal-center") return lineRefinement(patch, intent, roi, true);
  if (intent === "corner" || intent === "natural-keypoint") return cornerRefinement(patch, intent, roi);
  const type = intent === "blob-center" ? "blob" : "speckle";
  const result = featureModels[type].refineSubpixel(patch);
  const point = globalPoint(roi, { x: result.x, y: result.y });
  const accepted = result.confidence >= .2 && Number.isFinite(point.x) && Number.isFinite(point.y);
  return { accepted, intent, roi, point: accepted ? point : null, confidence: result.confidence, residualPx: result.residual, gates: { signal: accepted }, reason: accepted ? null : "refinement.low-confidence", geometry: null };
}
