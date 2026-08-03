import { applyLocalAffine, createMultiPointTracker, matchTemplateNcc, sampsonError, validateNaturalMatch, type GrayPatch, type MultiPointObservation } from "@subpixel/algorithms";
import type { EngineStatus, ExtractionIntent, FeatureRefinement, FrameRegistration, LocalFrame, MultiPointTrack, PointSeed, Roi } from "@subpixel/contracts";
import { extractNativePatch, imageDimensions } from "./frameUtils";
import { loadOpenCv } from "./opencvRuntime";
import { refineLocalPatch } from "./localRefinement";
import { registerAdjacentAnchors, registerLocalPatches } from "./localRegistration";
import type { RegistrationGuidance, SceneRegistrationAnchor } from "./localRegistration";
import { relocateNaturalDescriptor, type DescriptorRelocation } from "./localDescriptor";

export type BrowserFrame = LocalFrame & { image: CanvasImageSource };
export type LocalSearchRegion = { patch: GrayPatch; roi: Roi };
export type LocalTrackContext = {
  templates: Map<string, GrayPatch>;
  positions: Map<string, { x: number; y: number }>;
  previousSearches: Map<string, LocalSearchRegion>;
  referencePositions?: Map<string, { x: number; y: number }>;
  registration?: RegistrationGuidance;
  tracker: ReturnType<typeof createMultiPointTracker>;
};

export type LocalAlgorithmDependencies = {
  relocateNaturalDescriptor: (template: GrayPatch, search: GrayPatch) => DescriptorRelocation | null;
  refineFeature: typeof refineLocalPatch;
};

function pointIntent(seed: PointSeed): ExtractionIntent {
  if (seed.intent) return seed.intent;
  if (seed.model === "circle") return "circle-center";
  if (seed.model === "crosshair") return "crosshair-center";
  if (seed.model === "diagonal") return "diagonal-center";
  if (seed.model === "blob") return "blob-center";
  if (seed.model === "speckle") return "speckle-center";
  return "natural-keypoint";
}

function nearestLocalPrediction(point: { x: number; y: number }, anchors: SceneRegistrationAnchor[] | undefined) {
  if (!anchors || anchors.length < 4) return { result: undefined, failure: undefined };
  const nearest = [...anchors]
    .sort((a, b) => Math.hypot(a.reference.x - point.x, a.reference.y - point.y) - Math.hypot(b.reference.x - point.x, b.reference.y - point.y))
    .slice(0, 6)
    .map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: anchor.residualPx <= 3 }));
  if (nearest.filter(anchor => anchor.reliable).length < 4) return { result: undefined, failure: "tracking.local-affine-degenerate" };
  const result = applyLocalAffine(point, nearest);
  return result.accepted && result.residual <= 3
    ? { result, failure: undefined }
    : { result: undefined, failure: "tracking.local-affine-degenerate" };
}

function transformPoint(point: { x: number; y: number }, matrix?: number[]) {
  if (!matrix || matrix.length !== 9) return point;
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-9) return point;
  return { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator, y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator };
}

export function naturalDescriptorSearchRoi(point: { x: number; y: number }, size: { width: number; height: number }, template: { width: number; height: number }, localRadius: number): Roi {
  const targetWidth = Math.min(size.width, 1536, Math.max(256, Math.ceil(template.width + localRadius * 8)));
  const targetHeight = Math.min(size.height, 1536, Math.max(256, Math.ceil(template.height + localRadius * 8)));
  const x = Math.max(0, Math.min(size.width - targetWidth, Math.round(point.x - targetWidth / 2)));
  const y = Math.max(0, Math.min(size.height - targetHeight, Math.round(point.y - targetHeight / 2)));
  return { x, y, width: targetWidth, height: targetHeight };
}

export function adjacentSampleRois(size: { width: number; height: number }, requestedMotion = 12) {
  const radius = 2;
  const motion = Math.max(2, Math.min(requestedMotion, Math.floor(Math.min(size.width, size.height) / 8)));
  const margin = radius + motion + 1;
  return Array.from({ length: 6 }, (_, row) => Array.from({ length: 10 }, (_, column) => {
    const x = Math.round(margin + (column + .5) * Math.max(1, size.width - margin * 2) / 10);
    const y = Math.round(margin + (row + .5) * Math.max(1, size.height - margin * 2) / 6);
    return {
      point: { x, y },
      template: { x: x - radius, y: y - radius, width: radius * 2 + 1, height: radius * 2 + 1 },
      search: { x: x - radius - motion, y: y - radius - motion, width: (radius + motion) * 2 + 1, height: (radius + motion) * 2 + 1 }
    };
  })).flat();
}

export class LocalAlgorithmEngine {
  private status: EngineStatus = { opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } };
  private readonly dependencies: LocalAlgorithmDependencies;

  constructor(dependencies: Partial<LocalAlgorithmDependencies> = {}) {
    this.dependencies = { relocateNaturalDescriptor, refineFeature: refineLocalPatch, ...dependencies };
  }

  async load() { this.status = await loadOpenCv(); return this.status; }
  get engineStatus() { return this.status; }

  refine(frame: BrowserFrame, roi: Roi, intent: ExtractionIntent): FeatureRefinement {
    return refineLocalPatch(extractNativePatch(frame.image, roi), intent, roi);
  }

  register(reference: BrowserFrame, current: BrowserFrame, frame: number): FrameRegistration {
    const referenceSize = imageDimensions(reference.image);
    const currentSize = imageDimensions(current.image);
    if (!referenceSize || !currentSize || referenceSize.width !== currentSize.width || referenceSize.height !== currentSize.height) {
      return { frame, method: "none", matchCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, accepted: false, reason: "registration.dimension-mismatch" };
    }
    return registerLocalPatches(extractNativePatch(reference.image, { x: 0, y: 0, width: referenceSize.width, height: referenceSize.height }), extractNativePatch(current.image, { x: 0, y: 0, width: currentSize.width, height: currentSize.height }), frame, reference.frame);
  }

  registerAdjacent(reference: BrowserFrame, current: BrowserFrame): RegistrationGuidance {
    const referenceSize = imageDimensions(reference.image);
    const currentSize = imageDimensions(current.image);
    if (!referenceSize || !currentSize || referenceSize.width !== currentSize.width || referenceSize.height !== currentSize.height) {
      return { frame: current.frame, sourceFrame: reference.frame, targetFrame: current.frame, method: "adjacent-flow", matchCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionError: Infinity, accepted: false, reason: "registration.dimension-mismatch" };
    }
    const anchors: SceneRegistrationAnchor[] = [];
    for (const sample of adjacentSampleRois(referenceSize)) {
      const template = extractNativePatch(reference.image, sample.template);
      const search = extractNativePatch(current.image, sample.search);
      const match = matchTemplateNcc(search, template);
      if (match.ncc < .55) continue;
      anchors.push({ reference: sample.point, current: { x: sample.search.x + match.x, y: sample.search.y + match.y }, residualPx: match.residual });
    }
    return registerAdjacentAnchors(anchors, referenceSize, current.frame, reference.frame);
  }

  track(frame: BrowserFrame, seeds: PointSeed[], context: LocalTrackContext): { tracks: MultiPointTrack[]; paused: boolean; lostRatio: number; invalidRatio: number } {
    const observations: MultiPointObservation[] = [];
    const descriptorSearches = new Map<string, LocalSearchRegion>();
    for (const seed of seeds) {
      const template = context.templates.get(seed.pointId);
      if (!template) continue;
      const previous = context.positions.get(seed.pointId) ?? seed.snapped;
      const referencePoint = context.referencePositions?.get(seed.pointId) ?? seed.snapped;
      const hasRegistration = Boolean(context.registration?.accepted && context.registration.transform?.matrix);
      const globalPrediction = hasRegistration ? transformPoint(referencePoint, context.registration?.transform?.matrix) : previous;
      const localGuidance = hasRegistration ? nearestLocalPrediction(referencePoint, context.registration?.sceneAnchors) : { result: undefined, failure: undefined };
      const localPrediction = localGuidance.result;
      const predicted = localPrediction?.point ?? globalPrediction;
      const predictionSource: MultiPointTrack["predictionSource"] = localPrediction ? "local-affine" : hasRegistration ? "reference-homography" : "previous-position";
      const registrationError = context.registration?.accepted ? context.registration.medianReprojectionError : 0;
      const radius = seed.model === "natural-keypoint"
        ? Math.min(192, Math.max(24, Math.max(template.width, template.height) * 1.5, registrationError * 3 + 24))
        : Math.max(10, Math.min(96, Math.max(template.width, template.height) * .5));
      const roi = { x: predicted.x - template.width / 2 - radius, y: predicted.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 };
      try {
        const search = extractNativePatch(frame.image, roi);
        let match = matchTemplateNcc(search, template);
        let refined = { x: roi.x + match.x, y: roi.y + match.y };
        let descriptor: DescriptorRelocation | undefined;
        let relocationMethod: MultiPointTrack["relocationMethod"] = predictionSource === "local-affine" ? "local-affine" : "local-correlation";
        let confidence = Math.max(0, Math.min(1, (match.ncc + 1) / 2));
        let residual = match.residual;
        let gateFailures: string[] = localGuidance.failure ? [localGuidance.failure] : [];
        let candidateUniqueness: number | null = null;
        if (seed.model === "natural-keypoint" && match.ncc < .7) {
          const size = imageDimensions(frame.image);
          if (!size) continue;
          const descriptorRoi = naturalDescriptorSearchRoi(predicted, size, template, radius);
          const descriptorKey = `${descriptorRoi.x}:${descriptorRoi.y}:${descriptorRoi.width}:${descriptorRoi.height}`;
          let descriptorSearch = descriptorSearches.get(descriptorKey);
          if (!descriptorSearch) {
            descriptorSearch = { patch: extractNativePatch(frame.image, descriptorRoi), roi: descriptorRoi };
            descriptorSearches.set(descriptorKey, descriptorSearch);
          }
          descriptor = this.dependencies.relocateNaturalDescriptor(template, descriptorSearch.patch) ?? undefined;
          if (!descriptor) continue;
          refined = { x: descriptorSearch.roi.x + descriptor.point.x, y: descriptorSearch.roi.y + descriptor.point.y };
          const candidateRoi = { x: refined.x - template.width / 2, y: refined.y - template.height / 2, width: template.width, height: template.height };
          const verification = matchTemplateNcc(extractNativePatch(frame.image, candidateRoi), template);
          match = verification;
          if (match.ncc < .7) continue;
          relocationMethod = descriptor.method;
        } else if (match.ncc < (seed.model === "natural-keypoint" ? .7 : .35)) continue;
        if (seed.model !== "natural-keypoint") {
          const refinementRoi = { x: refined.x - seed.roi.width / 2, y: refined.y - seed.roi.height / 2, width: seed.roi.width, height: seed.roi.height };
          const modelResult = this.dependencies.refineFeature(extractNativePatch(frame.image, refinementRoi), pointIntent(seed), refinementRoi);
          if (!modelResult.accepted || !modelResult.point) {
            observations.push({
              pointId: seed.pointId, predicted, refined, confidence: modelResult.confidence,
              residual: modelResult.residualPx ?? match.residual, relocationMethod: "feature-refine", predictionSource,
              localAffineResidualPx: localPrediction?.residual ?? null,
              gateFailures: [...gateFailures, modelResult.reason ?? "refinement.geometry-gate-failed"],
              candidateUniqueness: modelResult.geometry?.kind === "corner" ? modelResult.geometry.uniquenessRatio : null
            });
            continue;
          }
          const innovation = Math.hypot(modelResult.point.x - predicted.x, modelResult.point.y - predicted.y);
          const innovationLimit = Math.max(6, Math.hypot(seed.roi.width, seed.roi.height) * .5, (Number.isFinite(registrationError) ? registrationError : 0) * 3);
          if (innovation > innovationLimit) gateFailures.push("tracking.innovation-too-large");
          refined = modelResult.point;
          confidence = modelResult.confidence;
          residual = modelResult.residualPx ?? match.residual;
          relocationMethod = "feature-refine";
          candidateUniqueness = modelResult.geometry?.kind === "corner" ? modelResult.geometry.uniquenessRatio : null;
        }
        let forwardBackwardError: number | undefined;
        let epipolarError: number | undefined;
        if (seed.model === "natural-keypoint") {
          const candidateRoi = { x: refined.x - template.width / 2, y: refined.y - template.height / 2, width: template.width, height: template.height };
          const candidatePatch = extractNativePatch(frame.image, candidateRoi);
          const previousSearch = context.previousSearches.get(seed.pointId);
          if (previousSearch && candidatePatch.width <= previousSearch.patch.width && candidatePatch.height <= previousSearch.patch.height) {
            const backward = matchTemplateNcc(previousSearch.patch, candidatePatch);
            forwardBackwardError = Math.hypot(previousSearch.roi.x + backward.x - previous.x, previousSearch.roi.y + backward.y - previous.y);
          }
          epipolarError = context.registration?.fundamentalMatrix
            ? sampsonError(referencePoint, refined, context.registration.fundamentalMatrix)
            : undefined;
          if (descriptor && epipolarError === undefined) gateFailures.push("tracking.epipolar-unavailable");
          const metrics = { forwardBackwardError: forwardBackwardError ?? Infinity, ncc: match.ncc, epipolarError, loweRatio: descriptor?.loweRatio };
          if (validateNaturalMatch(metrics).accepted && gateFailures.length === 0) {
            const acceptedRoi = { x: refined.x - template.width / 2 - radius, y: refined.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 };
            context.previousSearches.set(seed.pointId, { patch: extractNativePatch(frame.image, acceptedRoi), roi: acceptedRoi });
          }
        }
        observations.push({ pointId: seed.pointId, predicted, refined, confidence, residual, relocationMethod, predictionSource, localAffineResidualPx: localPrediction?.residual ?? null, gateFailures, candidateUniqueness, metrics: seed.model === "natural-keypoint" ? { forwardBackwardError: forwardBackwardError ?? Infinity, ncc: match.ncc, epipolarError, loweRatio: descriptor?.loweRatio, descriptorDistance: descriptor?.distance } : undefined });
      } catch { /* The tracker records this point as lost. */ }
    }
    return context.tracker.process(observations, frame.timestampMs, context.registration);
  }
}
