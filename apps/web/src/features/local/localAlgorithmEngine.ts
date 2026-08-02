import { createMultiPointTracker, matchTemplateNcc, validateNaturalMatch, type GrayPatch, type MultiPointObservation } from "@subpixel/algorithms";
import type { EngineStatus, ExtractionIntent, FeatureRefinement, FrameRegistration, LocalFrame, MultiPointTrack, PointSeed, Roi } from "@subpixel/contracts";
import { extractNativePatch, imageDimensions } from "./frameUtils";
import { loadOpenCv } from "./opencvRuntime";
import { refineLocalPatch } from "./localRefinement";
import { registerLocalPatches } from "./localRegistration";
import { relocateNaturalDescriptor, type DescriptorRelocation } from "./localDescriptor";

export type BrowserFrame = LocalFrame & { image: CanvasImageSource };
export type LocalSearchRegion = { patch: GrayPatch; roi: Roi };
export type LocalTrackContext = {
  templates: Map<string, GrayPatch>;
  positions: Map<string, { x: number; y: number }>;
  previousSearches: Map<string, LocalSearchRegion>;
  registration?: FrameRegistration;
  tracker: ReturnType<typeof createMultiPointTracker>;
};

export type LocalAlgorithmDependencies = {
  relocateNaturalDescriptor: (template: GrayPatch, search: GrayPatch) => DescriptorRelocation | null;
};

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

export class LocalAlgorithmEngine {
  private status: EngineStatus = { opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } };

  constructor(private readonly dependencies: LocalAlgorithmDependencies = { relocateNaturalDescriptor }) {}

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
    return registerLocalPatches(extractNativePatch(reference.image, { x: 0, y: 0, width: referenceSize.width, height: referenceSize.height }), extractNativePatch(current.image, { x: 0, y: 0, width: currentSize.width, height: currentSize.height }), frame);
  }

  track(frame: BrowserFrame, seeds: PointSeed[], context: LocalTrackContext): { tracks: MultiPointTrack[]; paused: boolean; lostRatio: number } {
    const observations: MultiPointObservation[] = [];
    const descriptorSearches = new Map<string, LocalSearchRegion>();
    for (const seed of seeds) {
      const template = context.templates.get(seed.pointId);
      if (!template) continue;
      const previous = context.positions.get(seed.pointId) ?? seed.snapped;
      const predicted = transformPoint(previous, context.registration?.accepted ? context.registration.transform?.matrix : undefined);
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
        let relocationMethod: MultiPointTrack["relocationMethod"] = context.registration?.accepted ? "local-affine" : "local-correlation";
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
        let forwardBackwardError: number | undefined;
        if (seed.model === "natural-keypoint") {
          const candidateRoi = { x: refined.x - template.width / 2, y: refined.y - template.height / 2, width: template.width, height: template.height };
          const candidatePatch = extractNativePatch(frame.image, candidateRoi);
          const previousSearch = context.previousSearches.get(seed.pointId);
          if (previousSearch && candidatePatch.width <= previousSearch.patch.width && candidatePatch.height <= previousSearch.patch.height) {
            const backward = matchTemplateNcc(previousSearch.patch, candidatePatch);
            forwardBackwardError = Math.hypot(previousSearch.roi.x + backward.x - previous.x, previousSearch.roi.y + backward.y - previous.y);
          }
          const metrics = { forwardBackwardError: forwardBackwardError ?? Infinity, ncc: match.ncc, epipolarError: context.registration?.accepted ? context.registration.medianReprojectionError : undefined, loweRatio: descriptor?.loweRatio };
          if (validateNaturalMatch(metrics).accepted) {
            const acceptedRoi = { x: refined.x - template.width / 2 - radius, y: refined.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 };
            context.previousSearches.set(seed.pointId, { patch: extractNativePatch(frame.image, acceptedRoi), roi: acceptedRoi });
          }
        }
        observations.push({ pointId: seed.pointId, predicted, refined, confidence: Math.max(0, Math.min(1, (match.ncc + 1) / 2)), residual: match.residual, relocationMethod, metrics: seed.model === "natural-keypoint" ? { forwardBackwardError: forwardBackwardError ?? Infinity, ncc: match.ncc, epipolarError: context.registration?.accepted ? context.registration.medianReprojectionError : undefined, loweRatio: descriptor?.loweRatio, descriptorDistance: descriptor?.distance } : undefined });
      } catch { /* The tracker records this point as lost. */ }
    }
    return context.tracker.process(observations, frame.timestampMs, context.registration);
  }
}
