import { describe, expect, it } from "vitest";
import { videoFrameTimes } from "./fileSource";

describe("file video source", () => {
  it("samples a video at 15 FPS without changing its time base", () => {
    expect(videoFrameTimes(.2, 15)).toEqual([0, 1 / 15, 2 / 15]);
  });

  it("keeps a zero-time fallback for invalid metadata", () => {
    expect(videoFrameTimes(0, 15)).toEqual([0]);
    expect(videoFrameTimes(Number.NaN, 15)).toEqual([0]);
  });
});
