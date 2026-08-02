import { featureModels, snapCooperativeCenter, type GrayPatch } from "@subpixel/algorithms";
import type { ExtractionIntent, FeatureRefinement, Point, RefinementGeometry, Roi } from "@subpixel/contracts";

type EdgePoint = { x: number; y: number; magnitude: number; angle: number };
type CenterComponent = { center: Point; boundary: EdgePoint[] };
type CircleCandidate = CenterComponent & { score: number; distanceFromRoiCenter: number; major: number; minor: number };
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

function roiCircleCandidates(patch: GrayPatch): CircleCandidate[] {
  const total = patch.width * patch.height;
  const border: number[] = [];
  for (let x = 0; x < patch.width; x += 1) border.push(patch.data[x], patch.data[(patch.height - 1) * patch.width + x]);
  for (let y = 1; y < patch.height - 1; y += 1) border.push(patch.data[y * patch.width], patch.data[y * patch.width + patch.width - 1]);
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)] ?? 0;
  let minimum = Infinity; let maximum = -Infinity;
  for (const value of patch.data) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  const range = maximum - minimum;
  if (!Number.isFinite(range) || range <= 1e-6) return [];

  const thresholds: Array<{ value: number; polarity: 1 | -1 }> = [];
  for (const fraction of [.18, .3, .45, .6]) {
    if (maximum - background >= range * .12) thresholds.push({ value: background + (maximum - background) * fraction, polarity: 1 });
    if (background - minimum >= range * .12) thresholds.push({ value: background - (background - minimum) * fraction, polarity: -1 });
  }

  const candidates: CircleCandidate[] = [];
  const queue = new Int32Array(total);
  for (const threshold of thresholds) {
    const included = (value: number) => threshold.polarity > 0 ? value >= threshold.value : value <= threshold.value;
    const visited = new Uint8Array(total);
    for (let seed = 0; seed < total; seed += 1) {
      if (visited[seed] || !included(patch.data[seed])) continue;
      let head = 0; let tail = 0; let count = 0; let xSum = 0; let ySum = 0; let valueSum = 0; let touchesBorder = false;
      queue[tail++] = seed; visited[seed] = 1;
      while (head < tail) {
        const index = queue[head++]; const x = index % patch.width; const y = Math.floor(index / patch.width);
        count += 1; xSum += x; ySum += y; valueSum += patch.data[index];
        if (x === 0 || y === 0 || x === patch.width - 1 || y === patch.height - 1) touchesBorder = true;
        for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
          if (!(ox || oy)) continue;
          const nextX = x + ox; const nextY = y + oy;
          if (nextX < 0 || nextX >= patch.width || nextY < 0 || nextY >= patch.height) continue;
          const nextIndex = nextY * patch.width + nextX;
          if (!visited[nextIndex] && included(patch.data[nextIndex])) { visited[nextIndex] = 1; queue[tail++] = nextIndex; }
        }
      }
      if (touchesBorder || count < 32 || count / total > .65) continue;

      const boundary: EdgePoint[] = [];
      for (let offset = 0; offset < tail; offset += 1) {
        const index = queue[offset]; const x = index % patch.width; const y = Math.floor(index / patch.width);
        if (x <= 0 || y <= 0 || x >= patch.width - 1 || y >= patch.height - 1) continue;
        if (included(patch.data[index - 1]) && included(patch.data[index + 1]) && included(patch.data[index - patch.width]) && included(patch.data[index + patch.width])) continue;
        const gx = patch.data[index + 1] - patch.data[index - 1]; const gy = patch.data[index + patch.width] - patch.data[index - patch.width];
        boundary.push({ x, y, magnitude: Math.hypot(gx, gy), angle: (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180 });
      }
      if (boundary.length < 32) continue;
      const center = { x: xSum / count, y: ySum / count };
      const ellipse = estimateEllipseFromEdges(boundary, center);
      const residual = ellipseEdgeResidual(boundary, center, ellipse.major, ellipse.minor, ellipse.angleDeg);
      const axisRatio = ellipse.minor / Math.max(ellipse.major, 1e-9);
      const angularBins = new Set(boundary.map(edge => (Math.floor(Math.atan2(edge.y - center.y, edge.x - center.x) * 18 / Math.PI + 18) + 36) % 36));
      const coverage = angularBins.size / 36;
      if (coverage < .6 || axisRatio < .15 || residual > Math.max(.75, .02 * ellipse.minor)) continue;
      const contrast = Math.abs(valueSum / count - background) / range;
      const significance = Math.min(1, Math.sqrt(count / total) * 3);
      const distance = Math.hypot(center.x - patch.width / 2, center.y - patch.height / 2);
      const normalizedDistance = distance / Math.max(1, Math.hypot(patch.width, patch.height) / 2);
      const score = contrast * 2.4 + coverage * 1.2 + Math.min(1, axisRatio) * .8 + significance * .8 + Math.exp(-residual) * .8 - normalizedDistance * .2;
      const candidate = { center, boundary, score, distanceFromRoiCenter: distance, major: ellipse.major, minor: ellipse.minor };
      const duplicateIndex = candidates.findIndex(existing => {
        const centerDistance = Math.hypot(existing.center.x - center.x, existing.center.y - center.y);
        const sizeDifference = Math.max(Math.abs(existing.major - ellipse.major) / Math.max(existing.major, ellipse.major), Math.abs(existing.minor - ellipse.minor) / Math.max(existing.minor, ellipse.minor));
        return centerDistance <= Math.max(3, .08 * Math.min(existing.minor, ellipse.minor)) && sizeDifference <= .25;
      });
      if (duplicateIndex < 0) candidates.push(candidate);
      else if (score > candidates[duplicateIndex].score) candidates[duplicateIndex] = candidate;
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function selectCircleComponent(patch: GrayPatch): { component?: CenterComponent; ambiguous: boolean } {
  const candidates = roiCircleCandidates(patch);
  if (!candidates.length) return { component: centeredComponent(patch), ambiguous: false };
  const best = candidates[0]; const second = candidates[1];
  if (second) {
    const relativeScoreGap = (best.score - second.score) / Math.max(1, Math.abs(best.score));
    const distanceGap = Math.abs(best.distanceFromRoiCenter - second.distanceFromRoiCenter);
    if (relativeScoreGap < .06 && distanceGap < Math.max(3, Math.hypot(patch.width, patch.height) * .025)) return { ambiguous: true };
  }
  return { component: best, ambiguous: false };
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
  const selection = selectCircleComponent(patch);
  if (selection.ambiguous) return emptyResult(intent, roi, "refinement.circle-ambiguous");
  const component = selection.component;
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

function shiTomasiResponses(patch: GrayPatch, radius = 2) {
  const response = new Float32Array(patch.width * patch.height);
  const verticalA = new Float64Array(patch.width); const verticalB = new Float64Array(patch.width); const verticalC = new Float64Array(patch.width);
  const rowA = new Float64Array(patch.width); const rowB = new Float64Array(patch.width); const rowC = new Float64Array(patch.width);
  const accumulateRow = (y: number, factor: number) => {
    rowA.fill(0); rowB.fill(0); rowC.fill(0);
    for (let x = 1; x < patch.width - 1; x += 1) {
      const gx = (patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1]) * .5;
      const gy = (patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x]) * .5;
      rowA[x] = gx * gx; rowB[x] = gx * gy; rowC[x] = gy * gy;
    }
    let sumA = 0; let sumB = 0; let sumC = 0;
    for (let x = 0; x < patch.width; x += 1) {
      const add = x + radius; const remove = x - radius - 1;
      if (add >= 1 && add < patch.width - 1) { sumA += rowA[add]; sumB += rowB[add]; sumC += rowC[add]; }
      if (remove >= 1 && remove < patch.width - 1) { sumA -= rowA[remove]; sumB -= rowB[remove]; sumC -= rowC[remove]; }
      verticalA[x] += factor * sumA; verticalB[x] += factor * sumB; verticalC[x] += factor * sumC;
    }
  };
  for (let row = 1; row <= Math.min(patch.height - 2, 1 + radius); row += 1) accumulateRow(row, 1);
  for (let y = 1; y < patch.height - 1; y += 1) {
    for (let x = 1; x < patch.width - 1; x += 1) {
      const trace = verticalA[x] + verticalC[x];
      response[y * patch.width + x] = Math.max(0, .5 * (trace - Math.sqrt((verticalA[x] - verticalC[x]) ** 2 + 4 * verticalB[x] ** 2)));
    }
    const remove = y - radius; const add = y + radius + 1;
    if (remove >= 1 && remove < patch.height - 1) accumulateRow(remove, -1);
    if (add >= 1 && add < patch.height - 1) accumulateRow(add, 1);
  }
  return response;
}

function refineCornerWithEdgeLines(patch: GrayPatch, initial: Point): Point | undefined {
  const samples: Array<{ x: number; y: number; nx: number; ny: number; magnitude: number }> = [];
  const centerX = Math.round(initial.x); const centerY = Math.round(initial.y);
  for (let y = Math.max(1, centerY - 6); y <= Math.min(patch.height - 2, centerY + 6); y += 1) for (let x = Math.max(1, centerX - 6); x <= Math.min(patch.width - 2, centerX + 6); x += 1) {
    const gx = (patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1]) * .5;
    const gy = (patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x]) * .5;
    const magnitude = Math.hypot(gx, gy);
    if (magnitude > 1e-6) samples.push({ x, y, nx: gx / magnitude, ny: gy / magnitude, magnitude });
  }
  if (samples.length < 8) return undefined;
  const coarse = refineCornerWithGradients(patch, initial) ?? initial;
  const directionalSamples = samples.filter(sample => Math.hypot(sample.x - coarse.x, sample.y - coarse.y) >= 2.5);
  if (directionalSamples.length < 8) return undefined;
  directionalSamples.sort((left, right) => right.magnitude - left.magnitude);
  let first = { x: directionalSamples[0].nx, y: directionalSamples[0].ny };
  const alternate = directionalSamples.reduce((best, sample) => {
    const score = sample.magnitude * (1 - Math.abs(sample.nx * first.x + sample.ny * first.y));
    return score > best.score ? { sample, score } : best;
  }, { sample: directionalSamples[0], score: -Infinity });
  let second = { x: alternate.sample.nx, y: alternate.sample.ny };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let firstX = 0; let firstY = 0; let secondX = 0; let secondY = 0; let firstWeight = 0; let secondWeight = 0;
    for (const sample of directionalSamples) {
      const dotFirst = sample.nx * first.x + sample.ny * first.y; const dotSecond = sample.nx * second.x + sample.ny * second.y;
      if (Math.abs(dotFirst) >= Math.abs(dotSecond)) {
        const sign = dotFirst < 0 ? -1 : 1; firstX += sign * sample.nx * sample.magnitude; firstY += sign * sample.ny * sample.magnitude; firstWeight += sample.magnitude;
      } else {
        const sign = dotSecond < 0 ? -1 : 1; secondX += sign * sample.nx * sample.magnitude; secondY += sign * sample.ny * sample.magnitude; secondWeight += sample.magnitude;
      }
    }
    if (firstWeight <= 0 || secondWeight <= 0) return undefined;
    const firstLength = Math.hypot(firstX, firstY); const secondLength = Math.hypot(secondX, secondY);
    if (firstLength <= 1e-9 || secondLength <= 1e-9) return undefined;
    first = { x: firstX / firstLength, y: firstY / firstLength }; second = { x: secondX / secondLength, y: secondY / secondLength };
  }
  const separation = Math.abs(first.x * second.y - first.y * second.x);
  if (separation < .35) return undefined;
  const lineOffset = (normal: Point) => {
    let weightedOffset = 0; let weight = 0;
    for (const sample of directionalSamples) {
      const alignment = Math.abs(sample.nx * normal.x + sample.ny * normal.y);
      if (alignment < .94) continue;
      weightedOffset += (normal.x * sample.x + normal.y * sample.y) * sample.magnitude;
      weight += sample.magnitude;
    }
    return weight > 0 ? weightedOffset / weight : NaN;
  };
  const firstOffset = lineOffset(first); const secondOffset = lineOffset(second);
  if (!Number.isFinite(firstOffset) || !Number.isFinite(secondOffset)) return undefined;
  const determinant = first.x * second.y - first.y * second.x;
  const refined = { x: (firstOffset * second.y - first.y * secondOffset) / determinant, y: (first.x * secondOffset - firstOffset * second.x) / determinant };
  return Number.isFinite(refined.x) && Number.isFinite(refined.y) && Math.hypot(refined.x - initial.x, refined.y - initial.y) <= 6 ? refined : undefined;
}

function refineCornerWithGradients(patch: GrayPatch, initial: Point): Point | undefined {
  let current = { ...initial };
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const centerX = Math.round(current.x); const centerY = Math.round(current.y);
    let a = 0; let b = 0; let c = 0; let rhsX = 0; let rhsY = 0;
    for (let y = Math.max(1, centerY - 5); y <= Math.min(patch.height - 2, centerY + 5); y += 1) for (let x = Math.max(1, centerX - 5); x <= Math.min(patch.width - 2, centerX + 5); x += 1) {
      const gx = (patch.data[y * patch.width + x + 1] - patch.data[y * patch.width + x - 1]) * .5;
      const gy = (patch.data[(y + 1) * patch.width + x] - patch.data[(y - 1) * patch.width + x]) * .5;
      const magnitude = Math.hypot(gx, gy);
      if (magnitude <= 1e-9) continue;
      const xx = gx * gx / magnitude; const xy = gx * gy / magnitude; const yy = gy * gy / magnitude;
      a += xx; b += xy; c += yy; rhsX += xx * x + xy * y; rhsY += xy * x + yy * y;
    }
    const determinant = a * c - b * b;
    if (!Number.isFinite(determinant) || determinant <= Math.max(1e-9, (a + c) ** 2 * 1e-8)) return undefined;
    const next = { x: (c * rhsX - b * rhsY) / determinant, y: (a * rhsY - b * rhsX) / determinant };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || Math.hypot(next.x - initial.x, next.y - initial.y) > 6) return undefined;
    const shift = Math.hypot(next.x - current.x, next.y - current.y); current = next;
    if (shift <= .001) return current;
  }
  return current;
}

function cornerRefinement(patch: GrayPatch, intent: ExtractionIntent, roi: Roi): FeatureRefinement {
  const responses = shiTomasiResponses(patch);
  let maximum = 0; let minimumIntensity = Infinity; let maximumIntensity = -Infinity;
  for (const response of responses) maximum = Math.max(maximum, response);
  for (const value of patch.data) { minimumIntensity = Math.min(minimumIntensity, value); maximumIntensity = Math.max(maximumIntensity, value); }
  const candidates: Array<{ x: number; y: number; response: number }> = [];
  const margin = 5;
  for (let y = margin; y < patch.height - margin; y += 1) for (let x = margin; x < patch.width - margin; x += 1) {
    const response = responses[y * patch.width + x];
    if (response <= maximum * .01 || response <= 0) continue;
    let localMaximum = true;
    for (let oy = -2; oy <= 2 && localMaximum; oy += 1) for (let ox = -2; ox <= 2; ox += 1) {
      if (!(ox || oy)) continue;
      if (responses[(y + oy) * patch.width + x + ox] > response) { localMaximum = false; break; }
    }
    if (localMaximum) candidates.push({ x, y, response });
  }
  candidates.sort((left, right) => right.response - left.response);
  const best = candidates[0];
  if (!best) return emptyResult(intent, roi, "refinement.corner-candidate");
  const second = candidates.find(candidate => Math.hypot(candidate.x - best.x, candidate.y - best.y) >= 8);
  const uniquenessRatio = best.response / Math.max(1e-9, second?.response ?? 0);
  const edgeRefined = refineCornerWithEdgeLines(patch, best);
  const localRefined = edgeRefined ?? refineCornerWithGradients(patch, best);
  if (!localRefined) return emptyResult(intent, roi, "refinement.corner-subpixel");
  let refined = { ...localRefined, response: best.response };
  const cv = openCv();
  if (!edgeRefined && cv?.cornerSubPix && cv.matFromArray && cv.Size && cv.TermCriteria) {
    try {
      const corners = cv.matFromArray(1, 1, cv.CV_32FC2 ?? 13, [refined.x, refined.y]); const gray = new cv.Mat(patch.height, patch.width, cv.CV_8UC1 ?? 0); const values = new Uint8Array(patch.data.length); for (let index = 0; index < values.length; index += 1) values[index] = Math.max(0, Math.min(255, Math.round(patch.data[index]))); gray.data.set(values);
      cv.cornerSubPix(gray, corners, new cv.Size(5, 5), new cv.Size(-1, -1), new cv.TermCriteria((cv.TERM_CRITERIA_EPS ?? 2) | (cv.TERM_CRITERIA_MAX_ITER ?? 1), 50, .001));
      const enhanced = { x: Number(corners.data32F?.[0]), y: Number(corners.data32F?.[1]) };
      if (Number.isFinite(enhanced.x) && Number.isFinite(enhanced.y) && Math.hypot(enhanced.x - localRefined.x, enhanced.y - localRefined.y) <= 1.5) refined = { ...enhanced, response: best.response };
      corners.delete?.(); gray.delete?.();
    } catch {
      // The deterministic subpixel result remains valid when this OpenCV build differs.
    }
  }
  const point = globalPoint(roi, refined);
  const gates = { boundary: refined.x >= 5 && refined.y >= 5 && refined.x <= patch.width - 6 && refined.y <= patch.height - 6, uniqueness: uniquenessRatio >= 1.2, signal: maximumIntensity - minimumIntensity >= 5 };
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
