import type { GrayPatch } from "@subpixel/algorithms";
import type { Roi } from "@subpixel/contracts";

export function extractNativePatch(source: CanvasImageSource, roi: Roi): GrayPatch {
  const width = Math.max(1, Math.round(roi.width));
  const height = Math.max(1, Math.round(roi.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to read native pixels.");
  context.drawImage(source, roi.x, roi.y, width, height, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = .299 * rgba[index * 4] + .587 * rgba[index * 4 + 1] + .114 * rgba[index * 4 + 2];
  }
  return { width, height, data };
}

export function imageDimensions(source: CanvasImageSource | { width?: number; height?: number; videoWidth?: number; videoHeight?: number }) {
  const candidate = source as { width?: number | { baseVal?: { value?: number } }; height?: number | { baseVal?: { value?: number } }; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
  const width = candidate.videoWidth ?? candidate.naturalWidth ?? (typeof candidate.width === "number" ? candidate.width : candidate.width?.baseVal?.value) ?? 0;
  const height = candidate.videoHeight ?? candidate.naturalHeight ?? (typeof candidate.height === "number" ? candidate.height : candidate.height?.baseVal?.value) ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}
