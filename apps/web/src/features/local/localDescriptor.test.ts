import { afterEach, describe, expect, it } from "vitest";
import type { GrayPatch } from "@subpixel/algorithms";
import { relocateNaturalDescriptor } from "./localDescriptor";

const patch = (size = 9): GrayPatch => ({ width: size, height: size, data: new Float32Array(size * size) });

describe("natural descriptor relocation", () => {
  const originalCv = (globalThis as typeof globalThis & { cv?: unknown }).cv;

  afterEach(() => {
    (globalThis as typeof globalThis & { cv?: unknown }).cv = originalCv;
  });

  it("returns null when OpenCV descriptors are unavailable", () => {
    delete (globalThis as typeof globalThis & { cv?: unknown }).cv;
    expect(relocateNaturalDescriptor(patch(), patch(31))).toBeNull();
  });
});
