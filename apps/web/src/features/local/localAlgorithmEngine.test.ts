import { describe, expect, it, vi } from "vitest";
import { createMultiPointTracker, type GrayPatch } from "@subpixel/algorithms";
import type { PointSeed } from "@subpixel/contracts";
import { adjacentSampleRois, LocalAlgorithmEngine, naturalDescriptorSearchRoi, type BrowserFrame, type LocalSearchRegion, type LocalTrackContext } from "./localAlgorithmEngine";

type PixelSource = { width: number; height: number; pixels: Float32Array };

function installCanvasReader() {
  let source: PixelSource | undefined;
  let sx = 0; let sy = 0; let sw = 0; let sh = 0;
  const context = {
    drawImage(value: PixelSource, x: number, y: number, width: number, height: number) {
      source = value; sx = x; sy = y; sw = width; sh = height;
    },
    getImageData() {
      const rgba = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y += 1) for (let x = 0; x < sw; x += 1) {
        const sourceX = Math.round(sx + x); const sourceY = Math.round(sy + y);
        const value = sourceX >= 0 && source && sourceX < source.width && sourceY >= 0 && sourceY < source.height ? source.pixels[sourceY * source.width + sourceX] : 0;
        const index = (y * sw + x) * 4; rgba[index] = value; rgba[index + 1] = value; rgba[index + 2] = value; rgba[index + 3] = 255;
      }
      return { data: rgba };
    }
  };
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
}

function featureSource(width: number, height: number, center?: { x: number; y: number }): PixelSource {
  const pixels = new Float32Array(width * height);
  if (center) for (let y = -4; y <= 4; y += 1) for (let x = -4; x <= 4; x += 1) {
    const px = center.x + x; const py = center.y + y;
    if (px >= 0 && px < width && py >= 0 && py < height) pixels[py * width + px] = ((x + 4) * 29 + (y + 4) * 47 + x * y * 7) % 251;
  }
  return { width, height, pixels };
}

function nativePatch(source: PixelSource, roi: { x: number; y: number; width: number; height: number }): GrayPatch {
  const data = new Float32Array(roi.width * roi.height);
  for (let y = 0; y < roi.height; y += 1) for (let x = 0; x < roi.width; x += 1) data[y * roi.width + x] = source.pixels[(roi.y + y) * source.width + roi.x + x];
  return { width: roi.width, height: roi.height, data };
}

const seed: PointSeed = {
  pointId: "p-001", click: { x: 20, y: 30 }, snapped: { x: 20, y: 30 },
  roi: { x: 15, y: 25, width: 11, height: 11 }, groupId: "natural",
  candidateScore: .9, model: "natural-keypoint", selectionMethod: "roi", intent: "natural-keypoint"
};

function frame(image: PixelSource, index: number): BrowserFrame {
  return { frame: index, timestampMs: index * 33, width: image.width, height: image.height, source: "video", image: image as unknown as CanvasImageSource };
}

function context(template: GrayPatch, previousSearch: LocalSearchRegion): LocalTrackContext {
  const tracker = createMultiPointTracker([seed]); tracker.initialize();
  return {
    tracker,
    templates: new Map([[seed.pointId, template]]),
    positions: new Map([[seed.pointId, seed.snapped]]),
    previousSearches: new Map([[seed.pointId, previousSearch]])
  };
}

describe("LocalAlgorithmEngine natural relocation", () => {
  it("samples adjacent motion from native small patches instead of allocating full 8K gray frames", () => {
    const samples = adjacentSampleRois({ width: 6144, height: 8192 }, 12);
    expect(samples).toHaveLength(60);
    expect(samples.every(sample => sample.template.width === 5 && sample.template.height === 5)).toBe(true);
    expect(samples.every(sample => sample.search.width === 29 && sample.search.height === 29)).toBe(true);
    expect(samples.reduce((sum, sample) => sum + sample.template.width * sample.template.height + sample.search.width * sample.search.height, 0)).toBeLessThan(100_000);
  });

  it("applies a reference-to-current transform to the immutable seed instead of the previous position", () => {
    installCanvasReader();
    const cooperativeSeed: PointSeed = {
      ...seed,
      model: "blob",
      intent: "blob-center",
      groupId: "cooperative"
    };
    const reference = featureSource(260, 80, cooperativeSeed.snapped);
    const current = featureSource(260, 80, { x: 120, y: 30 });
    const template = nativePatch(reference, cooperativeSeed.roi);
    const tracker = createMultiPointTracker([cooperativeSeed]); tracker.initialize();
    const result = new LocalAlgorithmEngine().track(frame(current, 5), [cooperativeSeed], {
      tracker,
      templates: new Map([[cooperativeSeed.pointId, template]]),
      positions: new Map([[cooperativeSeed.pointId, { x: 100, y: 30 }]]),
      previousSearches: new Map(),
      registration: {
        frame: 5,
        method: "homography",
        matchCount: 100,
        inlierCount: 90,
        inlierRatio: .9,
        medianReprojectionError: .5,
        accepted: true,
        transform: { kind: "homography", matrix: [1, 0, 100, 0, 1, 0, 0, 0, 1] }
      }
    });

    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].predicted.x).toBeCloseTo(120, 4);
    expect(Math.abs(result.tracks[0].refined.x - 120)).toBeLessThanOrEqual(.5);
  });

  it("uses nearby scene anchors before searching when parallax disagrees with the global homography", () => {
    installCanvasReader();
    const cooperativeSeed: PointSeed = { ...seed, model: "blob", intent: "blob-center" };
    const reference = featureSource(220, 100, cooperativeSeed.snapped);
    const current = featureSource(220, 100, { x: 70, y: 30 });
    const template = nativePatch(reference, cooperativeSeed.roi);
    const tracker = createMultiPointTracker([cooperativeSeed]); tracker.initialize();
    const anchors = [
      { reference: { x: 10, y: 20 }, current: { x: 60, y: 20 }, residualPx: .5 },
      { reference: { x: 30, y: 20 }, current: { x: 80, y: 20 }, residualPx: .5 },
      { reference: { x: 10, y: 40 }, current: { x: 60, y: 40 }, residualPx: .5 },
      { reference: { x: 30, y: 40 }, current: { x: 80, y: 40 }, residualPx: .5 }
    ];
    const result = new LocalAlgorithmEngine().track(frame(current, 5), [cooperativeSeed], {
      tracker,
      templates: new Map([[cooperativeSeed.pointId, template]]),
      positions: new Map([[cooperativeSeed.pointId, cooperativeSeed.snapped]]),
      previousSearches: new Map(),
      registration: {
        frame: 5, method: "homography", matchCount: 100, inlierCount: 80, inlierRatio: .8,
        medianReprojectionError: 1, accepted: true,
        transform: { kind: "homography", matrix: [1, 0, 100, 0, 1, 0, 0, 0, 1] },
        sceneAnchors: anchors
      } as never
    });

    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].predicted.x).toBeCloseTo(70, 4);
    expect(result.tracks[0].predictionSource).toBe("local-affine");
  });

  it("falls back to global prediction when nearby scene anchors produce a degenerate local affine", () => {
    installCanvasReader();
    const cooperativeSeed: PointSeed = { ...seed, model: "blob", intent: "blob-center" };
    const current = featureSource(160, 80, { x: 40, y: 30 });
    const template = nativePatch(featureSource(160, 80, cooperativeSeed.snapped), cooperativeSeed.roi);
    const tracker = createMultiPointTracker([cooperativeSeed]); tracker.initialize();
    const result = new LocalAlgorithmEngine().track(frame(current, 5), [cooperativeSeed], {
      tracker, templates: new Map([[cooperativeSeed.pointId, template]]), positions: new Map([[cooperativeSeed.pointId, cooperativeSeed.snapped]]), previousSearches: new Map(),
      registration: {
        frame: 5, sourceFrame: 0, targetFrame: 5, method: "sift-homography", matchCount: 100, inlierCount: 80, inlierRatio: .8,
        medianReprojectionError: 1, accepted: true, transform: { kind: "homography", matrix: [1, 0, 20, 0, 1, 0, 0, 0, 1] },
        sceneAnchors: [10, 20, 30, 40].map(x => ({ reference: { x, y: 20 }, current: { x: x + 20, y: 20 }, residualPx: .2 }))
      }
    });

    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].predictionSource).toBe("reference-homography");
    expect(result.tracks[0].gateFailures).not.toContain("tracking.local-affine-degenerate");
  });

  it("runs the cooperative model refinement on the current native ROI", () => {
    installCanvasReader();
    const cooperativeSeed: PointSeed = { ...seed, model: "blob", intent: "blob-center" };
    const reference = featureSource(120, 80, cooperativeSeed.snapped);
    const current = featureSource(120, 80, { x: 25, y: 30 });
    const template = nativePatch(reference, cooperativeSeed.roi);
    const tracker = createMultiPointTracker([cooperativeSeed]); tracker.initialize();
    const geometry = { kind: "ellipse" as const, center: { x: 25.25, y: 30.125 }, majorAxis: 12, minorAxis: 10, angleDeg: 4, edgeCoverage: .9, inlierCount: 48 };
    const refineFeature = vi.fn((_patch, intent, roi) => ({
      accepted: true, intent, roi, point: { x: 25.25, y: 30.125 }, confidence: .95,
      residualPx: .08, gates: { signal: true }, reason: null, geometry
    }));
    const engine = new LocalAlgorithmEngine({ relocateNaturalDescriptor: () => null, refineFeature } as never);
    const result = engine.track(frame(current, 1), [cooperativeSeed], {
      tracker,
      templates: new Map([[cooperativeSeed.pointId, template]]),
      positions: new Map([[cooperativeSeed.pointId, cooperativeSeed.snapped]]),
      previousSearches: new Map()
    });

    expect(refineFeature).toHaveBeenCalledOnce();
    expect(result.tracks[0]).toMatchObject({ refined: { x: 25.25, y: 30.125 }, geometry, relocationMethod: "feature-refine" });
  });

  it("rejects a high-NCC cooperative candidate when current-frame geometry is ambiguous", () => {
    installCanvasReader();
    const cooperativeSeed: PointSeed = { ...seed, model: "circle", intent: "circle-center" };
    const reference = featureSource(120, 80, cooperativeSeed.snapped);
    const template = nativePatch(reference, cooperativeSeed.roi);
    const tracker = createMultiPointTracker([cooperativeSeed]); tracker.initialize();
    const engine = new LocalAlgorithmEngine({ refineFeature: (_patch, intent, roi) => ({
      accepted: false, intent, roi, point: null, confidence: .8, residualPx: .3,
      gates: { uniqueness: false }, reason: "refinement.circle-ambiguous", geometry: null
    }) });

    const result = engine.track(frame(reference, 1), [cooperativeSeed], {
      tracker, templates: new Map([[cooperativeSeed.pointId, template]]),
      positions: new Map([[cooperativeSeed.pointId, cooperativeSeed.snapped]]), previousSearches: new Map()
    });

    expect(result.tracks[0].state).toBe("suspect");
    expect(result.tracks[0].gateFailures).toContain("refinement.circle-ambiguous");
    expect(result.tracks[0].relocationMethod).toBe("feature-refine");
  });

  it("keeps descriptor relocation on original pixels within a bounded search window", () => {
    const roi = naturalDescriptorSearchRoi({ x: 5000, y: 7000 }, { width: 6144, height: 8192 }, { width: 31, height: 31 }, 48);
    expect(roi.x).toBeLessThanOrEqual(5000);
    expect(roi.y).toBeLessThanOrEqual(7000);
    expect(roi.x + roi.width).toBeGreaterThanOrEqual(5000);
    expect(roi.y + roi.height).toBeGreaterThanOrEqual(7000);
    expect(roi.width * roi.height).toBeLessThanOrEqual(4_000_000);
    expect(roi.width).toBeLessThan(6144);
    expect(roi.height).toBeLessThan(8192);
  });

  it("does not replace the previous identity search after a failed descriptor candidate", () => {
    installCanvasReader();
    const reference = featureSource(160, 90, seed.snapped);
    const current = featureSource(160, 90);
    const template = nativePatch(reference, seed.roi);
    const previousSearch = { patch: template, roi: seed.roi };
    const trackContext = context(template, previousSearch);
    const relocate = vi.fn(() => ({ point: { x: 80, y: 45 }, distance: 22, loweRatio: .6, method: "sift" as const }));
    const engine = new LocalAlgorithmEngine({ relocateNaturalDescriptor: relocate });

    const result = engine.track(frame(current, 1), [seed], trackContext);

    expect(relocate).toHaveBeenCalledOnce();
    expect(result.tracks[0].pointId).toBe(seed.pointId);
    expect(result.tracks[0].state).not.toBe("valid");
    expect(trackContext.previousSearches.get(seed.pointId)).toBe(previousSearch);
  });

  it("keeps the same pointId when a distant descriptor candidate passes identity gates", () => {
    installCanvasReader();
    const relocated = { x: 125, y: 30 };
    const reference = featureSource(160, 90, seed.snapped);
    const current = featureSource(160, 90, relocated);
    const template = nativePatch(reference, seed.roi);
    const previousSearch = { patch: template, roi: seed.roi };
    const trackContext = context(template, previousSearch);
    trackContext.registration = {
      frame: 1, sourceFrame: 0, targetFrame: 1, method: "sift-homography",
      matchCount: 100, inlierCount: 80, inlierRatio: .8, medianReprojectionError: .5,
      accepted: true, transform: { kind: "homography", matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      fundamentalMatrix: [0, 0, 0, 0, 0, -1, 0, 1, 0]
    };
    const relocate = vi.fn(() => ({ point: relocated, distance: 18, loweRatio: .62, method: "sift" as const }));
    const engine = new LocalAlgorithmEngine({ relocateNaturalDescriptor: relocate });

    const result = engine.track(frame(current, 1), [seed], trackContext);

    expect(result.tracks[0].pointId).toBe(seed.pointId);
    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].refined.x).toBeCloseTo(relocated.x, 1);
    expect(result.tracks[0].refined.y).toBeCloseTo(relocated.y, 1);
    expect(result.tracks[0].relocationMethod).toBe("sift");
    expect(result.tracks[0].descriptorDistance).toBe(18);
    expect(result.tracks[0].epipolarError).toBeCloseTo(0, 8);
  });

  it("marks distant descriptor relocation suspect when pointwise epipolar geometry is unavailable", () => {
    installCanvasReader();
    const relocated = { x: 125, y: 45 };
    const reference = featureSource(160, 90, seed.snapped);
    const current = featureSource(160, 90, relocated);
    const template = nativePatch(reference, seed.roi);
    const previousSearch = { patch: template, roi: seed.roi };
    const trackContext = context(template, previousSearch);
    const engine = new LocalAlgorithmEngine({ relocateNaturalDescriptor: () => ({ point: relocated, distance: 18, loweRatio: .62, method: "sift" }) });

    const result = engine.track(frame(current, 1), [seed], trackContext);

    expect(result.tracks[0].state).toBe("suspect");
    expect(result.tracks[0].gateFailures).toContain("tracking.epipolar-unavailable");
    expect(trackContext.previousSearches.get(seed.pointId)).toBe(previousSearch);
  });
});
