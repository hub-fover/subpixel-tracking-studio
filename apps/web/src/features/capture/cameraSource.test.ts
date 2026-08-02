import { describe, expect, it } from "vitest";
import { chooseRecordingMimeType, nativeVideoSize } from "./cameraSource";

describe("camera source", () => {
  it("prefers a broadly supported recording MIME type", () => {
    expect(chooseRecordingMimeType((value: string) => value === "video/webm;codecs=vp8,opus")).toBe("video/webm;codecs=vp8,opus");
    expect(chooseRecordingMimeType(() => false)).toBeNull();
  });

  it("uses the video element's native dimensions without CSS dimensions", () => {
    expect(nativeVideoSize({ videoWidth: 3840, videoHeight: 2160 })).toEqual({ width: 3840, height: 2160 });
    expect(nativeVideoSize({ videoWidth: 0, videoHeight: 0 })).toBeNull();
  });
});
