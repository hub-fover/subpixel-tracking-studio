import { CaptureError, type CapturedFrame, type FrameSource } from "./CaptureAdapter";

export type LoadedFileFrame = CapturedFrame & {
  video?: HTMLVideoElement;
  durationMs?: number;
  release?: () => void;
};

export function videoFrameTimes(durationSeconds: number, fps = 15) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) return [0];
  const result: number[] = [];
  for (let index = 0; index / fps < durationSeconds; index += 1) result.push(index / fps);
  return result;
}

export async function seekVideoFrame(video: HTMLVideoElement, timeSeconds: number) {
  const target = Math.max(0, Math.min(timeSeconds, Number.isFinite(video.duration) ? video.duration : timeSeconds));
  if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new CaptureError("input.invalid", "视频帧定位失败。")); };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = target;
  });
}

export async function snapshotVideoFrame(video: HTMLVideoElement): Promise<CanvasImageSource> {
  return typeof createImageBitmap === "function" ? createImageBitmap(video) : video;
}

export async function loadFirstFileFrame(file: File): Promise<LoadedFileFrame> {
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) throw new CaptureError("input.invalid", "请选择图片或视频文件。");
  if (file.type.startsWith("image/")) {
    const image = await createImageBitmap(file);
    return { width: image.width, height: image.height, timestampMs: 0, image };
  }
  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = objectUrl;
  await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new CaptureError("input.invalid", "视频解码失败。")); });
  video.pause();
  await seekVideoFrame(video, 0);
  const image = await snapshotVideoFrame(video);
  return { width: video.videoWidth, height: video.videoHeight, timestampMs: 0, image, video, durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : undefined, release: () => { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl); } };
}

export function imageSequenceSource(files: File[]): FrameSource {
  let stopped = false;
  return { stop: () => { stopped = true; }, async *[Symbol.asyncIterator]() { for (const file of files) { if (stopped) return; yield await loadFirstFileFrame(file); } } };
}
