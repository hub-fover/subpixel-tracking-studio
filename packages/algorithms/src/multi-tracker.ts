import type { MultiPointTrack, PointSeed } from "@subpixel/contracts";
import { validateNaturalMatch } from "./natural-features";
import { applyLocalAffine, shouldPauseMultiPoint, type Anchor } from "./anchor-propagation";

export type MultiPointObservation = {
  pointId: string;
  predicted: { x: number; y: number };
  refined?: { x: number; y: number };
  confidence: number;
  residual: number;
  metrics?: { forwardBackwardError?: number; ncc?: number; epipolarError?: number; loweRatio?: number; descriptorDistance?: number };
  relocationMethod?: MultiPointTrack["relocationMethod"];
  predictionSource?: MultiPointTrack["predictionSource"];
  localAffineResidualPx?: number | null;
  gateFailures?: string[];
  candidateUniqueness?: number | null;
};

export type MultiPointFrameResult = {
  tracks: MultiPointTrack[];
  paused: boolean;
  lostRatio: number;
  invalidRatio: number;
};

export type MultiPointTrackerSnapshot = {
  frame: number;
  paused: boolean;
  positions: Array<readonly [string, { x: number; y: number }]>;
};

export function createMultiPointTracker(seeds: PointSeed[], options: { pauseLostRatio?: number } = {}) {
  const pauseLostRatio = options.pauseLostRatio ?? 0.2;
  let frame = 0;
  let previous = new Map<string, { x: number; y: number }>();
  let paused = false;

  function process(observations: MultiPointObservation[], timestampMs = 0, registration?: { matchCount: number; inlierRatio: number; medianReprojectionError: number; accepted?: boolean }): MultiPointFrameResult {
    const byPoint = new Map(observations.map(observation => [observation.pointId, observation]));
    const tracks: MultiPointTrack[] = seeds.map(seed => {
      const observation = byPoint.get(seed.pointId);
      const predicted = observation?.predicted ?? previous.get(seed.pointId) ?? seed.snapped;
      const refined = observation?.refined ?? predicted;
      let state: MultiPointTrack["state"] = "lost";
      if (observation) {
        const metrics = observation.metrics;
        const naturalGate = seed.model !== "natural-keypoint" || Boolean(metrics && validateNaturalMatch({
          forwardBackwardError: metrics.forwardBackwardError ?? Infinity,
          ncc: metrics.ncc ?? -1,
          epipolarError: metrics.epipolarError,
          loweRatio: metrics.loweRatio
        }).accepted);
        state = naturalGate && observation.confidence >= 0.35 && !(observation.gateFailures?.length) ? "valid" : "suspect";
      }
      if (state === "valid") previous.set(seed.pointId, refined);
      return { pointId: seed.pointId, frame, timestampMs, predicted, refined, model: seed.model, confidence: observation?.confidence ?? 0, residual: observation?.residual ?? Infinity, flowErrorForwardBackward: observation?.metrics?.forwardBackwardError ?? null, ncc: observation?.metrics?.ncc ?? null, descriptorDistance: observation?.metrics?.descriptorDistance ?? null, epipolarError: observation?.metrics?.epipolarError ?? null, predictionSource: observation?.predictionSource ?? "previous-position", innovationPx: Math.hypot(refined.x - predicted.x, refined.y - predicted.y), localAffineResidualPx: observation?.localAffineResidualPx ?? null, gateFailures: observation?.gateFailures ?? [], candidateUniqueness: observation?.candidateUniqueness ?? null, state, relocationMethod: observation?.relocationMethod ?? "none" } satisfies MultiPointTrack;
    });
    const lost = tracks.filter(track => track.state === "lost").length;
    const invalid = tracks.filter(track => track.state === "lost" || track.state === "suspect").length;
    const registrationPause = registration?.accepted === false || Boolean(registration && shouldPauseMultiPoint({ total: seeds.length, lost, matchCount: registration.matchCount, inlierRatio: registration.inlierRatio, medianReprojectionError: registration.medianReprojectionError }));
    paused = paused || invalid / Math.max(seeds.length, 1) >= pauseLostRatio || registrationPause;
    if (paused) for (const track of tracks) if (track.state === "valid") track.state = "paused";
    frame += 1;
    return { tracks, paused, lostRatio: lost / Math.max(seeds.length, 1), invalidRatio: invalid / Math.max(seeds.length, 1) };
  }

  return {
    initialize() { frame = 0; paused = false; previous = new Map(seeds.map(seed => [seed.pointId, seed.snapped])); },
    process,
    snapshot(): MultiPointTrackerSnapshot {
      return {
        frame,
        paused,
        positions: [...previous.entries()].map(([pointId, point]) => [pointId, { ...point }] as const)
      };
    },
    restore(snapshot: MultiPointTrackerSnapshot) {
      const validIds = new Set(seeds.map(seed => seed.pointId));
      frame = snapshot.frame;
      paused = snapshot.paused;
      previous = new Map(snapshot.positions.filter(([pointId]) => validIds.has(pointId)).map(([pointId, point]) => [pointId, { ...point }]));
    },
    applyAnchors(anchors: Anchor[]) {
      const reliable = anchors.filter(anchor => anchor.reliable !== false);
      const used = new Set<number>();
      const affine = reliable.length >= 3 ? applyLocalAffine({ x: 0, y: 0 }, reliable) : undefined;
      for (const seed of seeds) {
        let nearest = -1; let nearestDistance = Infinity;
        reliable.forEach((anchor, index) => { if (used.has(index)) return; const distance = Math.hypot(anchor.reference.x - seed.snapped.x, anchor.reference.y - seed.snapped.y); if (distance < nearestDistance) { nearest = index; nearestDistance = distance; } });
        if (nearest >= 0 && nearestDistance <= 24) { previous.set(seed.pointId, reliable[nearest].current); used.add(nearest); continue; }
        if (affine?.accepted) { const propagated = applyLocalAffine(seed.snapped, reliable); if (propagated.accepted) previous.set(seed.pointId, propagated.point); }
      }
      paused = false;
    },
    reset() { frame = 0; paused = false; previous.clear(); },
    get paused() { return paused; }
  };
}

export { applyLocalAffine };
