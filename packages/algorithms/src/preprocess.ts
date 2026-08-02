import type { GrayPatch } from "./types";

export function toGrayscale(data: ArrayLike<number>, channels = 4): GrayPatch {
  if (channels < 1 || !Number.isInteger(channels)) throw new Error("channels must be a positive integer");
  const pixels = Math.floor(data.length / channels);
  const side = Math.max(1, Math.floor(Math.sqrt(pixels)));
  const width = side;
  const height = Math.ceil(pixels / side);
  const output = new Float32Array(width * height);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * channels;
    output[i] = channels === 1 ? Number(data[offset]) : 0.299 * Number(data[offset]) + 0.587 * Number(data[offset + 1] ?? data[offset]) + 0.114 * Number(data[offset + 2] ?? data[offset]);
  }
  return { width, height, data: output };
}

export function subtractLocalBackground(patch: GrayPatch, radius = 2): GrayPatch {
  const values = patch.data;
  const out = new Float32Array(values.length);
  for (let y = 0; y < patch.height; y += 1) {
    for (let x = 0; x < patch.width; x += 1) {
      let sum = 0; let count = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(patch.height - 1, y + radius); yy += 1) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(patch.width - 1, x + radius); xx += 1) { sum += values[yy * patch.width + xx]; count += 1; }
      }
      out[y * patch.width + x] = values[y * patch.width + x] - sum / count;
    }
  }
  return { ...patch, data: out };
}

export function normalizePatch(patch: GrayPatch): GrayPatch {
  if (!patch.width || !patch.height || patch.data.length !== patch.width * patch.height) throw new Error("invalid patch");
  const mean = patch.data.reduce((sum, value) => sum + value, 0) / patch.data.length;
  const variance = patch.data.reduce((sum, value) => sum + (value - mean) ** 2, 0) / patch.data.length;
  const scale = Math.sqrt(variance) || 1;
  return { ...patch, data: Float32Array.from(patch.data, value => (value - mean) / scale) };
}
