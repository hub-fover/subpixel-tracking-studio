import type { GrayPatch } from "./types";

export function makeCirclePatch(options: { center: { x: number; y: number }; radius: number; width?: number; height?: number; sigma?: number }): GrayPatch {
  const width = options.width ?? 32; const height = options.height ?? 32; const sigma = options.sigma ?? 1.5;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - options.center.x, y - options.center.y);
    data[y * width + x] = Math.exp(-((distance - options.radius) ** 2) / (2 * sigma ** 2));
  }
  return { width, height, data };
}
