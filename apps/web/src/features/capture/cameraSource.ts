import { CaptureError, type FrameSource } from "./CaptureAdapter";

export type CameraFacingMode = "environment" | "user";

export function nativeVideoSize(video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">) {
  return video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
}

export function chooseRecordingMimeType(isSupported: (mimeType: string) => boolean = mimeType => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType)) {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/webm"];
  return candidates.find(isSupported) ?? null;
}

function nextVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>(resolve => {
    const callback = (video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number }).requestVideoFrameCallback;
    if (callback) { callback.call(video, () => resolve()); return; }
    requestAnimationFrame(() => resolve());
  });
}

export async function cameraSource(video: HTMLVideoElement, facingMode: CameraFacingMode = "environment"): Promise<FrameSource & { stream: MediaStream; facingMode: CameraFacingMode }> {
  if (!window.isSecureContext) throw new CaptureError("input.unsupported", "Camera requires a secure HTTPS context.");
  if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError("input.unsupported", "This browser does not support camera capture.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30, max: 60 } },
      audio: false
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    const code = name === "NotAllowedError" || name === "SecurityError" ? "input.permission" : name === "NotFoundError" ? "input.no-device" : "input.invalid";
    throw new CaptureError(code, code === "input.permission" ? "Camera permission was denied." : code === "input.no-device" ? "No camera was found on this device." : "Camera is unavailable.");
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  let stopped = false;
  const source: FrameSource & { stream: MediaStream; facingMode: CameraFacingMode } = {
    stream,
    facingMode,
    stop() { stopped = true; stream.getTracks().forEach(track => track.stop()); if (video.srcObject === stream) video.srcObject = null; },
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        const size = nativeVideoSize(video);
        if (!size) { await nextVideoFrame(video); continue; }
        const image = typeof createImageBitmap === "function" ? await createImageBitmap(video) : video;
        yield { width: size.width, height: size.height, timestampMs: performance.now(), image };
        await nextVideoFrame(video);
      }
    }
  };
  return source;
}
