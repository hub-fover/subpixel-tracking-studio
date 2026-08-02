import { describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { registerLocalPatches } from "./localRegistration";

function translatedPatch(dx: number, dy: number): { reference: GrayPatch; current: GrayPatch } {
  const width = 64; const height = 48; const reference = new Float32Array(width * height); const current = new Float32Array(width * height);
  for (let y = 4; y < height - 4; y += 1) for (let x = 4; x < width - 4; x += 1) {
    const value = ((x * 17 + y * 31) % 97) + (x === 20 || y === 25 ? 100 : 0);
    reference[y * width + x] = value;
    const tx = x + dx; const ty = y + dy;
    if (tx >= 0 && tx < width && ty >= 0 && ty < height) current[ty * width + tx] = value;
  }
  return { reference: { width, height, data: reference }, current: { width, height, data: current } };
}

describe("local registration", () => {
  it("estimates native-pixel translation and returns a homography", () => {
    const patches = translatedPatch(5, -3);
    const result = registerLocalPatches(patches.reference, patches.current, 2);
    expect(result.accepted).toBe(true);
    expect(result.transform?.matrix[2]).toBeCloseTo(5, 0);
    expect(result.transform?.matrix[5]).toBeCloseTo(-3, 0);
  });
});
