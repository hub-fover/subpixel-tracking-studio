import { describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { refineLocalPatch } from "./localRefinement";

function circlePatch(width = 41, height = 41, cx = 20.35, cy = 19.65, radius = 10) : GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - cx, y - cy);
    data[y * width + x] = distance <= radius ? 255 : 12;
  }
  return { width, height, data };
}

function ringPatch(width = 61, height = 61, cx = 30.35, cy = 29.65) : GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - cx, y - cy);
    data[y * width + x] = distance >= 15 && distance <= 21 ? 245 : 12;
  }
  return { width, height, data };
}

function texturedAdjacentCirclePatch(width = 89, height = 100, cx = 44.35, cy = 49.65, radius = 34): GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const texture = 54 + 22 * Math.sin(x * 1.31) + 17 * Math.cos(y * .83) + 13 * Math.sin((x + y) * .47);
    const targetDistance = Math.hypot(x - cx, y - cy);
    const neighborDistance = Math.hypot(x - 115, y - 50);
    data[y * width + x] = targetDistance <= radius ? 190 + 8 * Math.cos(x * .17) : neighborDistance <= 34 ? 205 : texture;
  }
  return { width, height, data };
}

function offCenterSalientCirclePatch(width = 240, height = 180): GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const texture = 58 + 15 * Math.sin(x * .71) + 11 * Math.cos(y * .43);
    const target = Math.hypot(x - 55.35, y - 58.65) <= 27;
    const distractor = Math.hypot(x - 182, y - 122) <= 15;
    data[y * width + x] = target ? 215 : distractor ? 142 : texture;
  }
  return { width, height, data };
}

function ambiguousCirclePatch(width = 240, height = 180): GrayPatch {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const left = Math.hypot(x - 65, y - 90) <= 24;
    const right = Math.hypot(x - 175, y - 90) <= 24;
    data[y * width + x] = left || right ? 220 : 35;
  }
  return { width, height, data };
}

function subpixelCornerPatch(width = 55, height = 53, cx = 24.35, cy = 27.65, angleDeg = 0, contrast = 210): GrayPatch {
  const data = new Float32Array(width * height);
  const samples = 8; const angle = angleDeg * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let bright = 0;
    for (let sy = 0; sy < samples; sy += 1) for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + .5) / samples - .5 - cx; const py = y + (sy + .5) / samples - .5 - cy;
      const u = cosine * px + sine * py; const v = -sine * px + cosine * py;
      if (u >= 0 && v >= 0) bright += 1;
    }
    data[y * width + x] = 20 + contrast * bright / (samples * samples);
  }
  return { width, height, data };
}

function repeatedCornersPatch(width = 90, height = 60): GrayPatch {
  const data = new Float32Array(width * height).fill(20);
  for (let y = 16; y <= 30; y += 1) for (let x = 12; x <= 26; x += 1) data[y * width + x] = 230;
  for (let y = 16; y <= 30; y += 1) for (let x = 62; x <= 76; x += 1) data[y * width + x] = 230;
  return { width, height, data };
}

describe("local refinement", () => {
  it("returns a gated original-coordinate circle center", () => {
    const result = refineLocalPatch(circlePatch(), "circle-center", { x: 100, y: 200, width: 41, height: 41 });
    expect(result.point).not.toBeNull();
    expect(result.geometry?.kind).toBe("ellipse");
    expect(result.accepted).toBe(true);
    expect(result.point!.x).toBeGreaterThan(118);
    expect(result.point!.x).toBeLessThan(122);
  });

  it("rejects an empty ROI instead of returning its center", () => {
    const result = refineLocalPatch({ width: 8, height: 8, data: new Float32Array(64) }, "circle-center", { x: 10, y: 20, width: 8, height: 8 });
    expect(result.accepted).toBe(false);
    expect(result.point).toBeNull();
  });

  it("accepts both edges of a thick circular ring without inflating residual", () => {
    const result = refineLocalPatch(ringPatch(), "circle-center", { x: 80, y: 120, width: 61, height: 61 });
    expect(result.accepted).toBe(true);
    expect(result.point).not.toBeNull();
    expect(result.residualPx).not.toBeNull();
    expect(result.residualPx!).toBeLessThanOrEqual(Math.max(.75, .02 * 36));
    expect(result.point!.x).toBeCloseTo(110.35, 0);
    expect(result.point!.y).toBeCloseTo(149.65, 0);
  });

  it("isolates the centered circle from textured background and an adjacent circle", () => {
    const result = refineLocalPatch(texturedAdjacentCirclePatch(), "circle-center", { x: 1800, y: 4300, width: 89, height: 100 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.point).not.toBeNull();
    expect(result.point!.x).toBeCloseTo(1844.35, 0);
    expect(result.point!.y).toBeCloseTo(4349.65, 0);
    expect(result.geometry?.kind).toBe("ellipse");
    expect(result.residualPx).not.toBeNull();
    expect(result.residualPx!).toBeLessThanOrEqual(.75);
  });

  it("refines a large native-pixel ROI without exceeding the JavaScript argument limit", () => {
    const patch = circlePatch(512, 512, 256.35, 255.65, 96);
    expect(() => refineLocalPatch(patch, "circle-center", { x: 0, y: 0, width: 512, height: 512 })).not.toThrow();
  });

  it("selects the most salient circle when it is away from the center of a large ROI", () => {
    const result = refineLocalPatch(offCenterSalientCirclePatch(), "circle-center", { x: 1000, y: 2000, width: 240, height: 180 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.point).not.toBeNull();
    expect(result.point!.x).toBeCloseTo(1055.35, 0);
    expect(result.point!.y).toBeCloseTo(2058.65, 0);
    expect(result.residualPx!).toBeLessThanOrEqual(.75);
  });

  it("rejects two equally salient circles instead of silently choosing an identity", () => {
    const result = refineLocalPatch(ambiguousCirclePatch(), "circle-center", { x: 0, y: 0, width: 240, height: 180 });
    expect(result.accepted).toBe(false);
    expect(result.point).toBeNull();
    expect(result.reason).toBe("refinement.circle-ambiguous");
  });

  it("refines a single corner to subpixel coordinates without requiring OpenCV", () => {
    const result = refineLocalPatch(subpixelCornerPatch(), "corner", { x: 100, y: 200, width: 55, height: 53 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.point).not.toBeNull();
    expect(Math.hypot(result.point!.x - 124.35, result.point!.y - 227.65)).toBeLessThan(.1);
  });

  it("keeps subpixel accuracy for a rotated corner", () => {
    const result = refineLocalPatch(subpixelCornerPatch(55, 53, 24.35, 27.65, 31), "natural-keypoint", { x: 0, y: 0, width: 55, height: 53 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.point).not.toBeNull();
    expect(Math.hypot(result.point!.x - 24.35, result.point!.y - 27.65)).toBeLessThan(.1);
  });

  it("keeps subpixel accuracy after an image is quantized to 8-bit pixels", () => {
    const patch = subpixelCornerPatch(55, 53, 24.35, 27.65, 31);
    for (let index = 0; index < patch.data.length; index += 1) patch.data[index] = Math.round(patch.data[index]);
    const result = refineLocalPatch(patch, "corner", { x: 0, y: 0, width: 55, height: 53 });
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(Math.hypot(result.point!.x - 24.35, result.point!.y - 27.65)).toBeLessThan(.1);
  });

  it("rejects a geometrically unique but imperceptibly low-contrast corner", () => {
    const result = refineLocalPatch(subpixelCornerPatch(55, 53, 24.35, 27.65, 0, 1), "corner", { x: 0, y: 0, width: 55, height: 53 });
    expect(result.accepted).toBe(false);
    expect(result.point).toBeNull();
    expect(result.reason).toBe("signal");
  });

  it("keeps the deterministic corner when an OpenCV build returns an implausible jump", () => {
    class FakeMat {
      data32F = new Float32Array(2);
      data = new Uint8Array(55 * 53);
      delete() { /* test double */ }
    }
    const fakeCv = {
      Mat: FakeMat,
      matFromArray: (_rows: number, _columns: number, _type: number, values: number[]) => { const matrix = new FakeMat(); matrix.data32F.set(values); return matrix; },
      cornerSubPix: (_gray: FakeMat, corners: FakeMat) => corners.data32F.set([0, 0]),
      Size: class { constructor(_width: number, _height: number) {} },
      TermCriteria: class { constructor(_type: number, _count: number, _epsilon: number) {} },
      CV_32FC2: 13,
      CV_8UC1: 0,
      TERM_CRITERIA_EPS: 2,
      TERM_CRITERIA_MAX_ITER: 1
    };
    (globalThis as typeof globalThis & { cv?: unknown }).cv = fakeCv;
    try {
      const result = refineLocalPatch(subpixelCornerPatch(), "corner", { x: 100, y: 200, width: 55, height: 53 });
      expect(result.accepted, JSON.stringify(result)).toBe(true);
      expect(result.point).not.toBeNull();
      expect(Math.hypot(result.point!.x - 124.35, result.point!.y - 227.65)).toBeLessThan(.1);
    } finally {
      delete (globalThis as typeof globalThis & { cv?: unknown }).cv;
    }
  });

  it("does not let OpenCV drift override a stable two-edge intersection", () => {
    class FakeMat {
      data32F = new Float32Array(2);
      data = new Uint8Array(55 * 53);
      delete() { /* test double */ }
    }
    const fakeCv = {
      Mat: FakeMat,
      matFromArray: (_rows: number, _columns: number, _type: number, values: number[]) => { const matrix = new FakeMat(); matrix.data32F.set(values); return matrix; },
      cornerSubPix: (_gray: FakeMat, corners: FakeMat) => corners.data32F.set([24.8, 27.8]),
      Size: class { constructor(_width: number, _height: number) {} },
      TermCriteria: class { constructor(_type: number, _count: number, _epsilon: number) {} },
      CV_32FC2: 13,
      CV_8UC1: 0
    };
    (globalThis as typeof globalThis & { cv?: unknown }).cv = fakeCv;
    try {
      const result = refineLocalPatch(subpixelCornerPatch(), "corner", { x: 100, y: 200, width: 55, height: 53 });
      expect(result.accepted, JSON.stringify(result)).toBe(true);
      expect(Math.hypot(result.point!.x - 124.35, result.point!.y - 227.65)).toBeLessThan(.1);
    } finally {
      delete (globalThis as typeof globalThis & { cv?: unknown }).cv;
    }
  });

  it("rejects an ROI containing repeated equally strong corners", () => {
    const result = refineLocalPatch(repeatedCornersPatch(), "corner", { x: 0, y: 0, width: 90, height: 60 });
    expect(result.accepted).toBe(false);
    expect(result.point).toBeNull();
    expect(result.reason).toBe("uniqueness");
  });
});
