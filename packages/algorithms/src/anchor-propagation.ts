export type Anchor = { reference: { x: number; y: number }; current: { x: number; y: number }; reliable?: boolean };
type Affine = [number, number, number, number, number, number];

function solve3(matrix: number[][], values: number[]): number[] | undefined {
  const a = matrix.map((row, i) => [...row, values[i]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-8) return undefined;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < 3; row += 1) if (row !== column) { const factor = a[row][column] / a[column][column]; for (let c = column; c < 4; c += 1) a[row][c] -= factor * a[column][c]; }
  }
  return a.map(row => row[3] / row[0 + a.indexOf(row)] || 0);
}

function fitAffine(anchors: Anchor[]): Affine | undefined {
  const reliable = anchors.filter(anchor => anchor.reliable !== false);
  if (reliable.length < 3) return undefined;
  const normal = Array.from({ length: 3 }, () => [0, 0, 0]); const bx = [0, 0, 0]; const by = [0, 0, 0];
  for (const anchor of reliable) {
    const row = [anchor.reference.x, anchor.reference.y, 1];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) normal[i][j] += row[i] * row[j];
    for (let i = 0; i < 3; i += 1) { bx[i] += row[i] * anchor.current.x; by[i] += row[i] * anchor.current.y; }
  }
  const x = solve3(normal.map(row => [...row]), bx); const y = solve3(normal.map(row => [...row]), by);
  return x && y ? [x[0], x[1], x[2], y[0], y[1], y[2]] : undefined;
}

export function applyLocalAffine(point: { x: number; y: number }, anchors: Anchor[]) {
  const affine = fitAffine(anchors);
  if (!affine) return { accepted: false, point, residual: Infinity, reason: "insufficient or degenerate anchors" };
  const predicted = { x: affine[0] * point.x + affine[1] * point.y + affine[2], y: affine[3] * point.x + affine[4] * point.y + affine[5] };
  const residuals = anchors.map(anchor => Math.hypot(affine[0] * anchor.reference.x + affine[1] * anchor.reference.y + affine[2] - anchor.current.x, affine[3] * anchor.reference.x + affine[4] * anchor.reference.y + affine[5] - anchor.current.y));
  const residual = residuals.sort((a, b) => a - b)[Math.floor(residuals.length / 2)] ?? Infinity;
  return { accepted: residual <= 5, point: predicted, residual, matrix: affine, reason: residual <= 5 ? undefined : "predicted median error exceeds 5 px" };
}

export function evaluateRecoveryAnchors(anchors: Anchor[], bounds: { width: number; height: number }) {
  if (anchors.length < 4) return { accepted: false, coverage: 0, reason: "at least four anchors required" };
  const points = anchors.map(anchor => anchor.reference).sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower: typeof points = []; const upper: typeof points = [];
  for (const point of points) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (const point of [...points].reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const area = Math.abs(hull.reduce((sum, point, index) => { const next = hull[(index + 1) % hull.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
  const coverage = area / (bounds.width * bounds.height);
  if (coverage < 0.1 || area < 1e-3) return { accepted: false, coverage, reason: coverage < 0.1 ? "anchor coverage below 10%" : "anchors are nearly collinear" };
  const propagation = applyLocalAffine(anchors[0].reference, anchors);
  return { accepted: propagation.accepted, coverage, predictedMedianError: propagation.residual, reason: propagation.reason };
}

export function shouldPauseMultiPoint(input: { total: number; lost: number; matchCount: number; inlierRatio: number; medianReprojectionError: number }) {
  return input.total > 0 && input.lost / input.total >= 0.2 || input.matchCount < 50 || input.inlierRatio < 0.35 || input.medianReprojectionError > 3;
}
