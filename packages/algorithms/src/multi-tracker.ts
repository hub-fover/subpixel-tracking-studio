import type { MultiPointTrack, PointSeed } from "@subpixel/contracts";
import { validateNaturalMatch } from "./natural-features";
import { applyLocalAffine, shouldPauseMultiPoint, type Anchor } from "./anchor-propagation";

export type MultiPointObservation = {
  pointId: string;
  predicted: { x: number; y: number };
  refined?: { x: number; y: number };
  confidence: number;
  residual: number;
  metrics?: { forwardBackwardError?: number; ncc?: number; epipolarError?: number; loweRatio?: number };
  relocationMethod?: MultiPointTrack["relocationMethod"];
};

export type MultiPointFrameResult = {
  tracks: MultiPointTrack[];
  paused: boolean;
  lostRatio: number;
};

export function createMultiPointTracker(seeds: PointSeed[], options: { pauseLostRatio?: number } = {}) {
  const pauseLostRatio = options.pauseLostRatio ?? 0.2;
  let frame = 0;
  let previous = new Map<string, { x: number; y: number }>();
  let paused = false;

  function process(observations: MultiPointObservation[], timestampMs = 0, registration?: { matchCount: number; inlierRatio: number; medianReprojectionError: number; accepted?: boolean }): MultiPointFrameResult {
    const byPoint = new Map(observations.map(observation => [observation.pointId, observation]));
    const anchors: Anchor[] = observations
      .filter(observation => observation.refined && observation.confidence >= 0.55 && previous.has(observation.pointId))
      .map(observation => ({ reference: previous.get(observation.pointId)!, current: observation.refined!, reliable: true }));
    const propagated = anchors.length >= 3 ? new Map(seeds.map(seed => [seed.pointId, applyLocalAffine(previous.get(seed.pointId) ?? seed.snapped, anchors)])) : new Map();
    const tracks: MultiPointTrack[] = seeds.map(seed => {
      const observation = byPoint.get(seed.pointId);
      const localPrediction = propagated.get(seed.pointId);
      const predicted = localPrediction?.accepted ? localPrediction.point : observation?.predicted ?? previous.get(seed.pointId) ?? seed.snapped;
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
        state = naturalGate && observation.confidence >= 0.35 ? "valid" : "suspect";
      }
      if (state === "valid") previous.set(seed.pointId, refined);
      return { pointId: seed.pointId, frame, timestampMs, predicted, refined, model: seed.model, confidence: observation?.confidence ?? 0, residual: observation?.residual ?? Infinity, flowErrorForwardBackward: observation?.metrics?.forwardBackwardError ?? null, ncc: observation?.metrics?.ncc ?? null, descriptorDistance: null, epipolarError: observation?.metrics?.epipolarError ?? null, state, relocationMethod: observation?.relocationMethod ?? "none" } satisfies MultiPointTrack;
    });
    const lost = tracks.filter(track => track.state === "lost").length;
    const registrationPause = registration && registration.accepted === false ? shouldPauseMultiPoint({ total: seeds.length, lost, matchCount: registration.matchCount, inlierRatio: registration.inlierRatio, medianReprojectionError: registration.medianReprojectionError }) : false;
    paused = paused || lost / Math.max(seeds.length, 1) >= pauseLostRatio || registrationPause;
    if (paused) for (const track of tracks) if (track.state === "valid") track.state = "paused";
    frame += 1;
    return { tracks, paused, lostRatio: lost / Math.max(seeds.length, 1) };
  }

  return {
    initialize() { frame = 0; paused = false; previous = new Map(seeds.map(seed => [seed.pointId, seed.snapped])); },
    process,
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
