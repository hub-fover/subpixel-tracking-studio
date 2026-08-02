import { featureModels, snapCooperativeCenter, type GrayPatch } from "@subpixel/algorithms";
import type { ExtractionIntent, FeatureRefinement, Point, RefinementGeometry, Roi } from "@subpixel/contracts";

type EdgePoint = { x: number; y: number; magnitude: number; angle: number };
type CenterComponent = { center: Point; boundary: EdgePoint[] };
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

function centeredComponent(patch: GrayPatch): CenterComponent | undefined {
  const centerX = Math.floor(patch.width / 2); const centerY = Math.floor(patch.height / 2);
  const border: number[] = [];
  for (let x = 0; x < patch.width; x += 1) border.push(patch.data[x], patch.data[(patch.height - 1) * patch.width + x]);
  for (let y = 1; y < patch.height - 1; y += 1) border.push(patch.data[y * patch.width], patch.data[y * patch.width + patch.width - 1]);
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)] ?? 0;
  let centerValue = 0; let centerCount = 0;
  for (let y = Math.max(0, centerY - 1); y <= Math.min(patch.height - 1, centerY + 1); y += 1) for (let x = Math.max(0, centerX - 1); x <= Math.min(patch.width - 1, centerX + 1); x += 1) {
    centerValue += patch.data[y * patch.width + x]; centerCount += 1;
  }
  centerValue /= Math.max(1, centerCount);
  let minimum = Infinity; let maximum = -Infinity;
  for (const value of patch.data) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  const range = maximum - minimum;
  const polarity = Math.sign(centerValue - background);
  if (!polarity || Math.abs(centerValue - background) < Math.max(1e-6, range * .12)) return undefined;
  const threshold = (centerValue + background) / 2;
  const accepted = (value: number) => polarity > 0 ? value >= threshold : value <= threshold;
  const visited = new Uint8Array(patch.width * patch.height); const component = new Uint8Array(patch.width * patch.height);
  const seedIndex = centerY * patch.width + centerX; const queue: number[] = [seedIndex]; visited[seedIndex] = 1;
  let cursor = 0; let count = 0; let xSum = 0; let ySum = 0; let touchesBorder = false;
  while (cursor < queue.length) {
    const index = queue[cursor++]; const x = index % patch.width; const y = Math.floor(index / patch.width);
    if (!accepted(patch.data[index])) continue;
    component[index] = 1; count += 1; xSum += x; ySum += y;
    if (x === 0 || y === 0 || x === patch.width - 1 || y === patch.height - 1) touchesBorder = true;
    for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
      const nextX = x + ox; const nextY = y + oy;
      if (!(ox || oy) || nextX < 0 || nextX >= patch.width || nextY < 0 || nextY >= patch.height) continue;
      const nextIndex = nextY * patch.width + nextX;
      if (!visited[nextIndex]) { visited[nextIndex] = 1; queue.push(nextIndex); }
    }
  }
  const fraction = count / Math.max(1, patch.width * patch.height);
  if (touchesBorder || count < 32 || fraction > .65) return undefined;
  const boundary: EdgePoint[] = [];
  for (let y = 1; y < patch.height - 1; y += 1) for (let x = 1; x < patch.width - 1; x += 1) {
    const index = y * patch.width + x;
    if (!component[index]) continue;
    if (component[index - 1] && component[index + 1] && component[index - patch.width] && component[index + patch.width]) continue;
    const gx = patch.data[index + 1] - patch.data[index - 1]; const gy = patch.data[index + patch.width] - patch.data[index - patch.width];
    boundary.push({ x, y, magnitude: Math.hypot(gx, gy), angle: (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180 });
  }
  return boundary.length >= 32 ? { center: { x: xSum / count, y: ySum / count }, boundary } : undefined;
}

function globalPoint(roi: Roi, point: Point): Point { return { x: roi.x + point.x, y: roi.y + point.y }; }

function clusteredResidual(values: number[], scale: number) {
  if (!values.length) return Infinity;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const single = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) * scale;
  const sorted = [...values].sort((a, b) => a - b);
  let low = sorted[Math.floor(sorted.length * .25)] ?? mean;
  let high = sorted[Math.floor(sorted.length * .75)] ?? mean;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const lowValues: number[] = []; const highValues: number[] = [];
    for (const value of values) (Math.abs(value - low) <= Math.abs(value - high) ? lowValues : highValues).push(value);
    if (!lowValues.length || !highValues.length) break;
    low = lowValues.reduce((sum, value) => sum + value, 0) / lowValues.length;
    high = highValues.reduce((sum, value) => sum + value, 0) / highValues.length;
  }
  const lowValues = values.filter(value => Math.abs(value - low) <= Math.abs(value - high));
  const highValues = values.filter(value => Math.abs(value - low) > Math.abs(value - high));
  const separation = Math.abs(high - low);
  const balanced = Math.min(lowValues.length, highValues.length) >= values.length * .2;
  if (!balanced || separation < .03 || separation > .35) return single;
  const clustered = Math.sqrt(values.reduce((sum, value) => sum + Math.min((value - low) ** 2, (value - high) ** 2), 0) / values.length) * scale;
  return clustered <= single * .65 ? clustered : single;
}

function ellipseEdgeResidual(edgePoints: EdgePoint[], center: Point, major: number, minor: number, angleDeg: number) {
  const angle = angleDeg * Math.PI / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const a = Math.max(major / 2, 1e-6); const b = Math.max(minor / 2, 1e-6);
  const normalizedRadii = edgePoints.map(edge => {
    const dx = edge.x - center.x; const dy = edge.y - center.y;
    const x = cos * dx + sin * dy; const y = -sin * dx + cos * dy;
    return Math.sqrt((x / a) ** 2 + (y / b) ** 2);
  });
  return clusteredResidual(normalizedRadii, b);
}

function estimateEllipseFromEdges(edgePoints: EdgePoint[], center: Point) {
  let xx = 0; let yy = 0; let xy = 0;
  for (const edge of edgePoints) {
    const dx = edge.x - center.x; const dy = edge.y - center.y;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= edgePoints.length; yy /= edgePoints.length; xy /= edgePoints.length;
  const difference = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2));
  const majorVariance = Math.max(1e-6, (xx + yy + difference) / 2);
  const minorVariance = Math.max(1e-6, (xx + yy - difference) / 2);
  return {
    major: 2 * Math.sqrt(2 * majorVariance),
    minor: 2 * Math.sqrt(2 * minorVariance),
    angleDeg: .5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI,
  };
}

function emptyResult(intent: ExtractionIntent, roi: Roi, reason: string): FeatureRefinement {
  return { accepted: false, intent, roi, point: null, confidence: 0, residualPx: null, gates: { candidate: false }, reason, geometry: null };
}

function circleRefinement(patch: GrayPatch, intent: ExtractionIntent, roi: Roi): FeatureRefinement {
  // A centered connected component isolates a selected disc from nearby targets and background texture.
  const component = centeredComponent(patch);
  const edgePoints = component?.boundary ?? edges(patch);
  if (edgePoints.length < 32) return emptyResult(intent, roi, "refinement.edge-points");
  const cv = openCv();
  if (cv?.fitEllipse || cv?.fitEllipseAMS) {
    try {
      const values = edgePoints.flatMap(edge => [edge.x, edge.y]);
      const points = cv.matFromArray ? cv.matFromArray(edgePoints.length, 1, cv.CV_32FC2 ?? 13, values) : new cv.Mat(edgePoints.length, 1, cv.CV_32FC2 ?? 13);
      if (!cv.matFromArray) points.data32F.set(values);
      const ellipse = (cv.fitEllipseAMS ?? cv.fitEllipse)!(points);
      const center = { x: Number(ellipse.center.x), y: Number(ellipse.center.y) };
      const ellipseWidth = Number(ellipse.size.width); const ellipseHeight = Number(ellipse.size.height);
      const major = Math.max(ellipseWidth, ellipseHeight); const minor = Math.min(ellipseWidth, ellipseHeight);
      const angle = (Number(ellipse.angle) || 0) + (ellipseWidth < ellipseHeight ? 90 : 0);
      const residual = ellipseEdgeResidual(edgePoints, center, major, minor, angle);
      const bins = new Set(edgePoints.map(edge => Math.floor(Math.atan2(edge.y - center.y, edge.x - center.x) * 18 / Math.PI + 18) % 36)); const edgeCoverage = bins.size / 36;
      const touchesBoundary = edgePoints.some(edge => edge.x <= 1 || edge.y <= 1 || edge.x >= patch.width - 2 || edge.y >= patch.height - 2); const gates = { edgeCoverage: edgeCoverage >= .6, edgePoints: edgePoints.length >= 32, axisRatio: minor / Math.max(major, 1e-9) >= .15, residual: residual <= Math.max(.75, .02 * minor), roiBoundary: !touchesBoundary };
      const accepted = Object.values(gates).every(Boolean); const point = globalPoint(roi, center); const geometry: RefinementGeometry = { kind: "ellipse", center: point, majorAxis: major, minorAxis: minor, angleDeg: angle, edgeCoverage, inlierCount: edgePoints.length };
      points.delete?.();
      return { accepted, intent, roi, point: accepted ? point : null, confidence: Math.max(0, Math.min(1, edgeCoverage * Math.exp(-residual))), residualPx: residual, gates, reason: accepted ? null : Object.entries(gates).find(([, value]) => !value)?.[0] ?? "refinement.low-confidence", geometry };
    } catch {
      // Keep the deterministic TypeScript path when OpenCV.js is unavailable or its API differs.
    }
  }
  const snapped = component ? undefined : snapCooperativeCenter(patch, "circle");
  const center = component?.center ?? { x: snapped!.x, y: snapped!.y };
  const ellipse = estimateEllipseFromEdges(edgePoints, center);
  const residual = ellipseEdgeResidual(edgePoints, center, ellipse.major, ellipse.minor, ellipse.angleDeg);
  const bins = new Set(edgePoints.map(edge => Math.floor(Math.atan2(edge.y - center.y, edge.x - center.x) * 18 / Math.PI + 18) % 36));
  const edgeCoverage = bins.size / 36;
  const touchesBoundary = edgePoints.some(edge => edge.x <= 1 || edge.y <= 1 || edge.x >= patch.width - 2 || edge.y >= patch.height - 2);
  const axisRatio = ellipse.minor / Math.max(ellipse.major, 1e-9);
  const gates = { edgeCoverage: edgeCoverage >= .6, edgePoints: edgePoints.length >= 32, axisRatio: axisRatio >= .15, residual: residual <= Math.max(.75, .02 * ellipse.minor), roiBoundary: !touchesBoundary };
  const accepted = Object.values(gates).every(Boolean) && (component ? true : snapped!.confidence >= .2);
  const point = globalPoint(roi, center);
  const geometry: RefinementGeometry = { kind: "ellipse", center: point, majorAxis: ellipse.major, minorAxis: ellipse.minor, angleDeg: ellipse.angleDeg, edgeCoverage, inlierCount: edgePoints.length };
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
  const cornerResponse = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= patch.width - 1 || y >= patch.height - 1) return -Infinity;
    const gx = patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1];
    const gy = patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x];
    return Math.min(gx * gx, gy * gy);
  };
  const candidates: Array<{ x: number; y: number; response: number }> = [];
  for (let y = 2; y < patch.height - 2; y += 1) for (let x = 2; x < patch.width - 2; x += 1) {
    const response = cornerResponse(x, y);
    if (response <= 0) continue;
    let localMaximum = true;
    for (let oy = -2; oy <= 2 && localMaximum; oy += 1) for (let ox = -2; ox <= 2; ox += 1) {
      if (ox === 0 && oy === 0) continue;
      if (cornerResponse(x + ox, y + oy) > response) localMaximum = false;
    }
    if (localMaximum) candidates.push({ x, y, response });
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
