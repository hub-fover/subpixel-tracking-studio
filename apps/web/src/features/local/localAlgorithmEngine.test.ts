import { describe, expect, it, vi } from "vitest";
import { createMultiPointTracker, type GrayPatch } from "@subpixel/algorithms";
import type { PointSeed } from "@subpixel/contracts";
import { LocalAlgorithmEngine, naturalDescriptorSearchRoi, type BrowserFrame, type LocalSearchRegion } from "./localAlgorithmEngine";

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

function context(template: GrayPatch, previousSearch: LocalSearchRegion) {
  const tracker = createMultiPointTracker([seed]); tracker.initialize();
  return {
    tracker,
    templates: new Map([[seed.pointId, template]]),
    positions: new Map([[seed.pointId, seed.snapped]]),
    previousSearches: new Map([[seed.pointId, previousSearch]])
  };
}

describe("LocalAlgorithmEngine natural relocation", () => {
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
    const relocated = { x: 125, y: 45 };
    const reference = featureSource(160, 90, seed.snapped);
    const current = featureSource(160, 90, relocated);
    const template = nativePatch(reference, seed.roi);
    const previousSearch = { patch: template, roi: seed.roi };
    const trackContext = context(template, previousSearch);
    const relocate = vi.fn(() => ({ point: relocated, distance: 18, loweRatio: .62, method: "sift" as const }));
    const engine = new LocalAlgorithmEngine({ relocateNaturalDescriptor: relocate });

    const result = engine.track(frame(current, 1), [seed], trackContext);

    expect(result.tracks[0].pointId).toBe(seed.pointId);
    expect(result.tracks[0].state).toBe("valid");
    expect(result.tracks[0].refined.x).toBeCloseTo(relocated.x, 1);
    expect(result.tracks[0].refined.y).toBeCloseTo(relocated.y, 1);
    expect(result.tracks[0].relocationMethod).toBe("sift");
    expect(result.tracks[0].descriptorDistance).toBe(18);
  });
});
